import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import turfArea from '@turf/area';
import { gzipSync } from 'node:zlib';
import type { Request, Response } from 'express';
import { canonicalParcel } from '../lib/canonical.js';
import { assignParcelIds } from '../lib/parcel-ids.js';
import { describeImport, planImport } from '../lib/parcel-import.js';
import { recordsFromGeoJson } from '../lib/records.js';
import { PrismaService } from './prisma.service.js';

const SQ_FT_PER_SQ_M = 10.763910416709722;
const CHUNK = 500;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const area = (turfArea as unknown as { default?: typeof turfArea }).default || turfArea;

function areaSqFt(geometry: object) {
  try {
    const squareMeters = area({ type: 'Feature', properties: {}, geometry } as never);
    return Number.isFinite(squareMeters) && squareMeters > 0 ? squareMeters * SQ_FT_PER_SQ_M : null;
  } catch {
    return null;
  }
}

const RECORD_COLUMNS: Array<[string, string]> = [
  ['parcel_id', 'text'],
  ['parcel_no', 'text'],
  ['owner_name', 'text'],
  ['owner_name_2', 'text'],
  ['owner_key', 'text'],
  ['owner_signature', 'text'],
  ['mailing_address', 'text'],
  ['mailing_city', 'text'],
  ['mailing_state', 'text'],
  ['mailing_zip', 'text'],
  ['situs_address', 'text'],
  ['situs_city', 'text'],
  ['subdivision', 'text'],
  ['land_acres', 'double precision'],
  ['land_sq_ft', 'double precision'],
  ['area_sq_ft', 'double precision'],
  ['appraised_cents', 'bigint'],
  ['taxable_cents', 'bigint'],
  ['exempt_cents', 'bigint'],
  ['land_value_cents', 'bigint'],
  ['improvement_value_cents', 'bigint'],
  ['exempt_codes', 'text[]'],
  ['zoning', 'text'],
  ['prop_use', 'text'],
  ['year_built', 'integer'],
  ['waterfront_code', 'integer'],
  ['deed_ref_date', 'text'],
  ['value_history', 'jsonb'],
  ['centroid_lat', 'double precision'],
  ['centroid_lng', 'double precision'],
  ['geometry', 'jsonb'],
  ['raw', 'jsonb'],
];

const DATA_COLUMNS = RECORD_COLUMNS.map(([name]) => name).filter((name) => name !== 'parcel_id');

function toRecord(row: ReturnType<typeof canonicalParcel> & { ownerChanged: boolean; previousOwnerName: string | null }) {
  return {
    parcel_id: row.parcelId,
    parcel_no: row.parcelNo,
    owner_name: row.ownerName,
    owner_name_2: row.ownerName2,
    owner_key: row.ownerKey,
    owner_signature: row.ownerSignature,
    mailing_address: row.mailingAddress,
    mailing_city: row.mailingCity,
    mailing_state: row.mailingState,
    mailing_zip: row.mailingZip,
    situs_address: row.situsAddress,
    situs_city: row.situsCity,
    subdivision: row.subdivision,
    land_acres: row.landAcres,
    land_sq_ft: row.landSqFt,
    area_sq_ft: row.areaSqFt,
    appraised_cents: row.appraisedCents,
    taxable_cents: row.taxableCents,
    exempt_cents: row.exemptCents,
    land_value_cents: row.landValueCents,
    improvement_value_cents: row.improvementValueCents,
    exempt_codes: row.exemptCodes,
    zoning: row.zoning,
    prop_use: row.propUse,
    year_built: row.yearBuilt,
    waterfront_code: row.waterfrontCode,
    deed_ref_date: row.deedRefDate,
    value_history: row.valueHistory,
    centroid_lat: row.centroidLat,
    centroid_lng: row.centroidLng,
    geometry: row.geometry,
    raw: row.raw,
    owner_changed: row.ownerChanged,
    previous_owner_name: row.previousOwnerName,
  };
}

const UPSERT_SQL = `
INSERT INTO parcels (${RECORD_COLUMNS.map(([name]) => name).join(', ')},
  first_import_id, last_import_id, owner_changed_at, previous_owner_name, missing_since, updated_at)
SELECT ${RECORD_COLUMNS.map(([name]) => `x.${name}`).join(', ')},
  $2, $2,
  CASE WHEN x.owner_changed THEN now() ELSE NULL END,
  CASE WHEN x.owner_changed THEN x.previous_owner_name ELSE NULL END,
  NULL, now()
FROM jsonb_to_recordset($1::jsonb) AS x(${RECORD_COLUMNS.map(([name, type]) => `${name} ${type}`).join(', ')},
  owner_changed boolean, previous_owner_name text)
ON CONFLICT (parcel_id) DO UPDATE SET
  ${DATA_COLUMNS.map((name) => `${name} = EXCLUDED.${name}`).join(',\n  ')},
  last_import_id = EXCLUDED.last_import_id,
  owner_changed_at = COALESCE(EXCLUDED.owner_changed_at, parcels.owner_changed_at),
  previous_owner_name = CASE WHEN EXCLUDED.owner_changed_at IS NOT NULL
    THEN EXCLUDED.previous_owner_name ELSE parcels.previous_owner_name END,
  missing_since = NULL,
  updated_at = now()`;

function num(value: bigint | number | null | undefined) {
  return value == null ? null : Number(value);
}

function status(row: { ownerChangedAt: Date | null; previousOwnerName: string | null; missingSince: Date | null }) {
  return {
    ownerChangedAt: row.ownerChangedAt ? row.ownerChangedAt.toISOString() : null,
    previousOwnerName: row.previousOwnerName,
    missingSince: row.missingSince ? row.missingSince.toISOString() : null,
  };
}

function parcelView(row: Record<string, any>) {
  const { raw, geometry, appraisedCents, taxableCents, exemptCents, landValueCents, improvementValueCents, ...rest } = row;
  return {
    ...rest,
    appraisedCents: num(appraisedCents),
    taxableCents: num(taxableCents),
    exemptCents: num(exemptCents),
    landValueCents: num(landValueCents),
    improvementValueCents: num(improvementValueCents),
    ownerChangedAt: row.ownerChangedAt ? row.ownerChangedAt.toISOString() : null,
    missingSince: row.missingSince ? row.missingSince.toISOString() : null,
    ...(raw !== undefined ? { raw } : {}),
    ...(geometry !== undefined ? { geometry } : {}),
  };
}

@Injectable()
export class ParcelService {
  private geometryCache: { etag: string; body: Buffer; gzip: Buffer } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async importText(text: string, filename: string) {
    let data: unknown;
    try {
      data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    } catch {
      throw new BadRequestException('That file is not GeoJSON. Drop the .geojson file the extension saved.');
    }
    const features = recordsFromGeoJson(data);
    if (!features.length) throw new BadRequestException('That file has no parcels.');
    const { records, duplicatesDropped } = assignParcelIds(features);
    const canonical = records.map((record) => canonicalParcel(record, areaSqFt));
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE parcels IN SHARE ROW EXCLUSIVE MODE');
      const existing = await tx.parcel.findMany({
        select: { parcelId: true, ownerSignature: true, ownerName: true, missingSince: true },
      });
      const plan = planImport(existing, canonical);
      const summary = { ...plan.summary, duplicatesDropped: plan.summary.duplicatesDropped + duplicatesDropped };
      const created = await tx.import.create({
        data: {
          filename: String(filename || 'upload.geojson').slice(0, 200),
          featureCount: features.length,
          parcelCount: summary.parcels,
          added: summary.added,
          updated: summary.updated,
          ownerChanged: summary.ownerChanged,
          missing: summary.missing,
          returned: summary.returned,
          duplicatesDropped: summary.duplicatesDropped,
        },
      });
      for (let start = 0; start < plan.rows.length; start += CHUNK) {
        const chunk = plan.rows.slice(start, start + CHUNK).map(toRecord);
        await tx.$executeRawUnsafe(UPSERT_SQL, JSON.stringify(chunk), created.id);
      }
      if (plan.missingIds.length) {
        await tx.$executeRawUnsafe(
          'UPDATE parcels SET missing_since = now(), updated_at = now() WHERE parcel_id = ANY($1::text[]) AND missing_since IS NULL',
          plan.missingIds,
        );
      }
      const total = await tx.parcel.count();
      return {
        importId: created.id,
        filename: created.filename,
        createdAt: created.createdAt.toISOString(),
        features: features.length,
        ...summary,
        totalParcels: total,
        message: describeImport(summary),
      };
    }, { timeout: 180000, maxWait: 10000 });
  }

  async geometry(acceptGzip: boolean, ifNoneMatch: string | undefined) {
    const last = await this.prisma.import.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    const etag = `"import-${last?.id ?? 0}"`;
    if (ifNoneMatch && ifNoneMatch.split(',').map((tag) => tag.trim().replace(/^W\//, '')).includes(etag)) {
      return { etag, notModified: true as const };
    }
    if (this.geometryCache?.etag !== etag) {
      const rows = await this.prisma.parcel.findMany({
        orderBy: { parcelId: 'asc' },
        select: { parcelId: true, raw: true, geometry: true, ownerChangedAt: true, previousOwnerName: true, missingSince: true },
      });
      const body = Buffer.from(JSON.stringify({
        type: 'FeatureCollection',
        importId: last?.id ?? null,
        features: rows.map((row) => ({
          type: 'Feature',
          parcelId: row.parcelId,
          status: status(row),
          properties: row.raw,
          geometry: row.geometry,
        })),
      }));
      this.geometryCache = { etag, body, gzip: gzipSync(body) };
    }
    const cache = this.geometryCache!;
    return { etag, notModified: false as const, body: acceptGzip ? cache.gzip : cache.body, gzip: acceptGzip };
  }

  async list() {
    const rows = await this.prisma.parcel.findMany({
      orderBy: { parcelId: 'asc' },
      omit: { raw: true, geometry: true },
    });
    return { parcels: rows.map(parcelView) };
  }

  async one(parcelId: string) {
    const row = await this.prisma.parcel.findUnique({ where: { parcelId } });
    if (!row) throw new NotFoundException('That parcel is not on the server.');
    return parcelView(row);
  }

  async imports() {
    const rows = await this.prisma.import.findMany({ orderBy: { id: 'desc' }, take: 50 });
    return { imports: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
  }
}

@Controller('api/imports')
export class ImportController {
  constructor(private readonly parcels: ParcelService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async create(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Attach the .geojson file as "file".');
    return this.parcels.importText(file.buffer.toString('utf8'), file.originalname);
  }

  @Get()
  list() {
    return this.parcels.imports();
  }
}

@Controller('api/parcels')
export class ParcelController {
  constructor(private readonly parcels: ParcelService) {}

  @Get('geometry')
  async geometry(@Req() req: Request, @Res() res: Response) {
    const accept = String(req.headers['accept-encoding'] || '');
    const result = await this.parcels.geometry(/\bgzip\b/.test(accept), req.headers['if-none-match']);
    res.setHeader('ETag', result.etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Vary', 'Accept-Encoding');
    if (result.notModified) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    if (result.gzip) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(result.body.length));
    res.status(200).end(result.body);
  }

  @Get()
  list() {
    return this.parcels.list();
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.parcels.one(id);
  }
}
