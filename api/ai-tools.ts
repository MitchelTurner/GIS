import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

const ACRES = 'COALESCE(NULLIF(land_acres, 0), area_sq_ft / 43560.0)';
const PER_ACRE = `(appraised_cents / 100.0) / NULLIF(${ACRES}, 0)`;
// Same names lib/ownership.js isPublicOwner treats as public.
const PUBLIC_OWNER = String.raw`owner_name ~* '^\s*(city|state|borough|county|united states|u\.?s\.?a?\.?|ketchikan gateway|school district|university)\y'`;
const MAX_RESULT_CHARS = 60000;

const SUMMARY_COLUMNS = `parcel_id, parcel_no, owner_name, owner_name_2, situs_address, situs_city, subdivision,
  round((${ACRES})::numeric, 3)::float8 AS acres,
  (appraised_cents / 100)::float8 AS appraised,
  (taxable_cents / 100)::float8 AS taxable,
  (land_value_cents / 100)::float8 AS land_value,
  (improvement_value_cents / 100)::float8 AS improvement_value,
  round((${PER_ACRE})::numeric)::float8 AS appraised_per_acre,
  zoning, prop_use, year_built, (waterfront_code > 0) AS waterfront, exempt_codes,
  mailing_city, mailing_state, deed_ref_date, owner_changed_at, previous_owner_name, missing_since`;

const SORTS: Record<string, string> = {
  acres: `${ACRES}`,
  appraised: 'appraised_cents',
  per_acre: `${PER_ACRE}`,
  owner: 'owner_name',
  owner_changed: 'owner_changed_at',
  year_built: 'year_built',
  parcel: 'parcel_no',
};

const GROUPS: Record<string, { key: string; label: string }> = {
  zoning: { key: 'zoning', label: 'zoning' },
  subdivision: { key: 'subdivision', label: 'subdivision' },
  city: { key: 'situs_city', label: 'situs_city' },
  prop_use: { key: 'prop_use', label: 'prop_use' },
  owner: { key: 'owner_key', label: 'min(owner_name)' },
  mailing_city: { key: 'mailing_city', label: 'mailing_city' },
  mailing_state: { key: 'mailing_state', label: 'mailing_state' },
  waterfront: { key: '(waterfront_code > 0)', label: "CASE WHEN waterfront_code > 0 THEN 'waterfront' ELSE 'not waterfront' END" },
};

const FILTER_PROPERTIES = {
  text: { type: 'string', description: 'Words matched against owner names, parcel number, street address, subdivision, and mailing address.' },
  owner: { type: 'string', description: 'Part of an owner name, e.g. "LOVELACE".' },
  zoning: { type: 'string', description: 'Zoning code exactly as stored.' },
  subdivision: { type: 'string', description: 'Part of a subdivision name.' },
  city: { type: 'string', description: 'Property town (situs city).' },
  prop_use: { type: 'string', description: 'Part of the property use text.' },
  min_acres: { type: 'number' },
  max_acres: { type: 'number' },
  min_appraised: { type: 'number', description: 'Dollars.' },
  max_appraised: { type: 'number', description: 'Dollars.' },
  min_per_acre: { type: 'number', description: 'Appraised dollars per acre.' },
  max_per_acre: { type: 'number', description: 'Appraised dollars per acre.' },
  waterfront: { type: 'boolean' },
  exempt: { type: 'boolean', description: 'true: has an exemption code; false: has none.' },
  private_only: { type: 'boolean', description: 'Leave out city, state, borough, federal, school, and university owners.' },
  absentee: { type: 'boolean', description: 'Mailing city differs from the property town.' },
  condos: { type: 'boolean', description: 'true: only condos; false: leave condos out.' },
  owner_changed: { type: 'boolean', description: 'Owner changed between imported files.' },
  missing: { type: 'boolean', description: 'Absent from the latest imported file.' },
  near: { type: 'string', description: 'Parcel id or parcel number to measure distance from. Use with radius_km.' },
  radius_km: { type: 'number', description: 'Distance from the "near" parcel, in kilometers. Default 1.' },
};

export const AI_TOOLS = [
  {
    name: 'search_parcels',
    description: 'Search every parcel in the borough database. Returns the matching count, total acres and appraised value, and one page of parcels. Money is in dollars. Use several searches when a question needs them.',
    input_schema: {
      type: 'object',
      properties: {
        ...FILTER_PROPERTIES,
        sort: { type: 'string', enum: [...Object.keys(SORTS), 'distance'] },
        order: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: 'Rows to return, up to 100. Default 25.' },
        offset: { type: 'integer' },
      },
    },
  },
  {
    name: 'summarize_parcels',
    description: 'Group parcels and total them: parcel count, acres, appraised value, and median appraised dollars per acre per group. Takes the same filters as search_parcels.',
    input_schema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: Object.keys(GROUPS) },
        ...FILTER_PROPERTIES,
        sort: { type: 'string', enum: ['parcels', 'acres', 'appraised', 'median_per_acre'] },
        limit: { type: 'integer', description: 'Groups to return, up to 100. Default 30.' },
      },
      required: ['group_by'],
    },
  },
  {
    name: 'get_parcels',
    description: 'Full records for up to 25 parcels by parcel id or parcel number: every exported field, the full mailing address, value history, centroid, and import history flags.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 25 } },
      required: ['ids'],
    },
  },
  {
    name: 'list_imports',
    description: 'The files imported into the database, newest first, with counts of added parcels, owner changes, and missing parcels.',
    input_schema: { type: 'object', properties: {} },
  },
];

type Filters = Record<string, unknown>;

function text(value: unknown) {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, 200) : '';
}

function number(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
}

function like(value: string) {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function clean(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue;
    if (typeof value === 'bigint') out[key] = Number(value);
    else if (value instanceof Date) out[key] = value.toISOString().slice(0, 10);
    else out[key] = value;
  }
  return out;
}

function clamp(value: unknown, fallback: number, max: number) {
  const out = Math.trunc(Number(value));
  return Number.isFinite(out) && out > 0 ? Math.min(out, max) : fallback;
}

@Injectable()
export class AiToolService {
  constructor(private readonly prisma: PrismaService) {}

  definitions() {
    return AI_TOOLS;
  }

  async run(name: string, input: Record<string, unknown> = {}) {
    let result: unknown;
    if (name === 'search_parcels') result = await this.search(input);
    else if (name === 'summarize_parcels') result = await this.summarize(input);
    else if (name === 'get_parcels') result = await this.getParcels(input);
    else if (name === 'list_imports') result = await this.imports();
    else return { error: `There is no tool named ${name}.` };
    const json = JSON.stringify(result);
    return json.length > MAX_RESULT_CHARS ? { note: 'Result cut short. Narrow the filters or lower the limit.', partial: json.slice(0, MAX_RESULT_CHARS) } : result;
  }

  private async where(filters: Filters) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const words = text(filters.text);
    if (words) {
      for (const word of words.split(/\s+/).slice(0, 6)) {
        const p = param(like(word));
        clauses.push(`concat_ws(' ', parcel_id, parcel_no, owner_name, owner_name_2, situs_address, situs_city, subdivision, mailing_address, mailing_city, mailing_state, mailing_zip) ILIKE ${p}`);
      }
    }
    const owner = text(filters.owner);
    if (owner) {
      const p = param(like(owner));
      clauses.push(`(owner_name ILIKE ${p} OR owner_name_2 ILIKE ${p})`);
    }
    if (text(filters.zoning)) clauses.push(`upper(zoning) = upper(${param(text(filters.zoning))})`);
    if (text(filters.subdivision)) clauses.push(`subdivision ILIKE ${param(like(text(filters.subdivision)))}`);
    if (text(filters.city)) clauses.push(`situs_city ILIKE ${param(like(text(filters.city)))}`);
    if (text(filters.prop_use)) clauses.push(`prop_use ILIKE ${param(like(text(filters.prop_use)))}`);
    const ranges: Array<[string, string, number]> = [
      ['min_acres', `${ACRES} >=`, 1],
      ['max_acres', `${ACRES} <=`, 1],
      ['min_appraised', 'appraised_cents >=', 100],
      ['max_appraised', 'appraised_cents <=', 100],
      ['min_per_acre', `${PER_ACRE} >=`, 1],
      ['max_per_acre', `${PER_ACRE} <=`, 1],
    ];
    for (const [key, expression, scale] of ranges) {
      const value = number(filters[key]);
      if (value !== null) clauses.push(`${expression} ${param(value * scale)}`);
    }
    if (typeof filters.waterfront === 'boolean') clauses.push(filters.waterfront ? 'waterfront_code > 0' : 'COALESCE(waterfront_code, 0) <= 0');
    if (typeof filters.exempt === 'boolean') clauses.push(filters.exempt ? 'cardinality(exempt_codes) > 0' : 'cardinality(exempt_codes) = 0');
    if (filters.private_only === true) clauses.push(`NOT COALESCE(${PUBLIC_OWNER}, false)`);
    if (filters.absentee === true) {
      clauses.push(`(mailing_city <> '' AND situs_city <> '' AND position(lower(mailing_city) in lower(situs_city)) = 0 AND position(lower(situs_city) in lower(mailing_city)) = 0)`);
    }
    if (typeof filters.condos === 'boolean') clauses.push(filters.condos ? "prop_use ILIKE '%condo%'" : "COALESCE(prop_use, '') NOT ILIKE '%condo%'");
    if (typeof filters.owner_changed === 'boolean') clauses.push(filters.owner_changed ? 'owner_changed_at IS NOT NULL' : 'owner_changed_at IS NULL');
    if (typeof filters.missing === 'boolean') clauses.push(filters.missing ? 'missing_since IS NOT NULL' : 'missing_since IS NULL');

    let distance = '';
    const near = text(filters.near);
    if (near) {
      const anchor = await this.prisma.parcel.findFirst({
        where: { OR: [{ parcelId: near }, { parcelNo: near }] },
        select: { centroidLat: true, centroidLng: true },
      });
      if (anchor?.centroidLat == null || anchor?.centroidLng == null) {
        return { error: `No parcel ${near} with a location is in the database.` };
      }
      const lat = param(anchor.centroidLat);
      const lng = param(anchor.centroidLng);
      distance = `(6371 * 2 * asin(sqrt(power(sin(radians(centroid_lat - ${lat}) / 2), 2) + cos(radians(${lat})) * cos(radians(centroid_lat)) * power(sin(radians(centroid_lng - ${lng}) / 2), 2))))`;
      clauses.push(`${distance} <= ${param(number(filters.radius_km) ?? 1)}`);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, distance };
  }

  async search(input: Filters) {
    const where = await this.where(input);
    if ('error' in where) return where;
    const limit = clamp(input.limit, 25, 100);
    const offset = Math.max(0, Math.trunc(Number(input.offset)) || 0);
    const sortKey = String(input.sort || '');
    const sortExpression = sortKey === 'distance' && where.distance ? where.distance : SORTS[sortKey] || 'parcel_no';
    const order = input.order === 'desc' ? 'DESC' : input.order === 'asc' ? 'ASC' : sortKey && sortKey !== 'owner' && sortKey !== 'parcel' && sortKey !== 'distance' ? 'DESC' : 'ASC';
    const distanceColumn = where.distance ? `, round(${where.distance}::numeric, 2)::float8 AS distance_km` : '';
    const [totals] = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT count(*)::int AS matches, round(sum(${ACRES})::numeric, 2)::float8 AS total_acres,
        (sum(appraised_cents) / 100)::float8 AS total_appraised
       FROM parcels ${where.sql}`,
      ...where.params,
    );
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${SUMMARY_COLUMNS}${distanceColumn} FROM parcels ${where.sql}
       ORDER BY ${sortExpression} ${order} NULLS LAST, parcel_id LIMIT ${limit} OFFSET ${offset}`,
      ...where.params,
    );
    return { ...clean(totals), offset, parcels: rows.map(clean) };
  }

  async summarize(input: Filters) {
    const group = GROUPS[String(input.group_by)];
    if (!group) return { error: `group_by must be one of ${Object.keys(GROUPS).join(', ')}.` };
    const where = await this.where(input);
    if ('error' in where) return where;
    const limit = clamp(input.limit, 30, 100);
    const sorts: Record<string, string> = { parcels: 'parcels', acres: 'acres', appraised: 'appraised', median_per_acre: 'median_per_acre' };
    const sort = sorts[String(input.sort)] || 'parcels';
    const groups = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT ${group.label} AS "group", count(*)::int AS parcels,
        round(sum(${ACRES})::numeric, 2)::float8 AS acres,
        (sum(appraised_cents) / 100)::float8 AS appraised,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${PER_ACRE})::numeric)::float8 AS median_per_acre
       FROM parcels ${where.sql}
       GROUP BY ${group.key}
       ORDER BY ${sort} DESC NULLS LAST LIMIT ${limit}`,
      ...where.params,
    );
    const [count] = await this.prisma.$queryRawUnsafe<Array<{ groups: number }>>(
      `SELECT count(DISTINCT ${group.key})::int AS groups FROM parcels ${where.sql}`,
      ...where.params,
    );
    return { totalGroups: count?.groups ?? 0, groups: groups.map(clean) };
  }

  async getParcels(input: Filters) {
    const ids = (Array.isArray(input.ids) ? input.ids : [input.ids]).map(text).filter(Boolean).slice(0, 25);
    if (!ids.length) return { error: 'Give at least one parcel id or parcel number.' };
    const rows = await this.prisma.parcel.findMany({
      where: { OR: [{ parcelId: { in: ids } }, { parcelNo: { in: ids } }] },
      omit: { geometry: true, ownerSignature: true },
      take: 50,
    });
    const found = new Set(rows.flatMap((row) => [row.parcelId, row.parcelNo]));
    return {
      parcels: rows.map((row) => clean({
        ...row,
        appraisedCents: undefined,
        taxableCents: undefined,
        exemptCents: undefined,
        landValueCents: undefined,
        improvementValueCents: undefined,
        appraised: row.appraisedCents == null ? null : Number(row.appraisedCents) / 100,
        taxable: row.taxableCents == null ? null : Number(row.taxableCents) / 100,
        exempt: row.exemptCents == null ? null : Number(row.exemptCents) / 100,
        landValue: row.landValueCents == null ? null : Number(row.landValueCents) / 100,
        improvementValue: row.improvementValueCents == null ? null : Number(row.improvementValueCents) / 100,
        valueHistory: (Array.isArray(row.valueHistory) ? row.valueHistory : []).map((entry: any) => ({
          year: entry?.year,
          appraised: entry?.appraisedCents == null ? null : Number(entry.appraisedCents) / 100,
        })),
      })),
      notFound: ids.filter((id) => !found.has(id)),
    };
  }

  async imports() {
    const rows = await this.prisma.import.findMany({ orderBy: { id: 'desc' }, take: 20 });
    return { imports: rows.map((row) => clean(row as unknown as Record<string, unknown>)) };
  }
}
