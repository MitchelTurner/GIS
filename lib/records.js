const FIELD_ALIASES = {
  parcelno: ['parcelno', 'parcel_no', 'apn', 'parcel_num', 'parcel_number'],
  owner_name: ['owner_name', 'owner', 'ownernme1'],
  owner_2: ['owner_2', 'owner2', 'ownernme2'],
  mailing_address: ['address_full', 'address', 'mail_addr', 'mailing_address'],
  mailing_city: ['city', 'mailing_city'],
  mailing_state: ['state', 'mailing_state'],
  mailing_zip: ['zip', 'zipcode', 'mailing_zip'],
  location: ['location', 'situs', 'loc_addri'],
  loc_city: ['loc_city', 'situs_city'],
  subdivision: ['subname', 'subdivision'],
  acres: ['land_acres', 'acres'],
  sqft: ['land_sq_ft', 'sqft', 'land_sqft'],
  land_value: ['apr_land_v', 'asd_land_v', 'land_value'],
  improvement_value: ['apr_imps', 'improvement_value'],
  total_value: ['total_appr', 'total_asse', 'total_value'],
  zoning: ['zoning_typ', 'zoning'],
  year_built: ['year_built'],
  prop_use: ['propuse', 'prop_type', 'prop_use'],
  bedrooms: ['bedrooms'],
  bathrooms: ['bathrooms'],
};

export function formatMailing(record = {}) {
  const full = record.mailingAddress || record.mailing_address || '';
  const parts = [
    record.mailingCity || record.mailing_city,
    record.mailingState || record.mailing_state,
    record.mailingZip || record.mailing_zip,
  ].filter(Boolean);
  if (!full) return parts.join(', ');
  const lower = String(full).toLowerCase();
  if (parts.every((part) => lower.includes(String(part).toLowerCase()))) return String(full);
  return [full, ...parts].join(', ');
}

export function blankRecord() {
  return Object.fromEntries(Object.keys(FIELD_ALIASES).map((key) => [key, null]));
}

export function recordFromProperties(properties = {}) {
  const lookup = new Map();
  for (const [key, value] of Object.entries(properties)) {
    lookup.set(normalizeKey(key), value);
  }
  const record = blankRecord();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      if (!lookup.has(alias)) continue;
      const value = cleanValue(lookup.get(alias));
      if (value != null) {
        record[field] = numericField(field) ? numberOrNull(value) : String(value);
        break;
      }
    }
  }
  if (!record.parcelno && record.owner_name) record.parcelno = null;
  return record;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => String(value).trim() !== ''));
}

export function recordsFromCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => String(header).trim());
  return rows.slice(1).map((row) => {
    const properties = {};
    headers.forEach((header, index) => {
      properties[header] = row[index] ?? '';
    });
    return { properties, geometry: null };
  });
}

export function recordsFromGeoJson(data) {
  const features = data?.type === 'FeatureCollection' ? data.features : data?.type === 'Feature' ? [data] : [];
  return features.map((feature) => ({
    properties: feature.properties || {},
    geometry: feature.geometry || null,
  }));
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function cleanValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function numericField(field) {
  return ['acres', 'sqft', 'land_value', 'improvement_value', 'total_value', 'year_built', 'bedrooms', 'bathrooms'].includes(field);
}

function numberOrNull(value) {
  const number = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(number) ? number : null;
}
