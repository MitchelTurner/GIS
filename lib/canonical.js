// Turns one export feature into the canonical parcel row stored on the server.
// Field sources are listed in docs/FIELD_MAP.md. A field with no source stays null.
import { geometryCentroid, parties } from './ownership.js';
import { recordFromProperties } from './records.js';

function cents(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 100);
}

function lookup(properties) {
  const map = new Map();
  for (const [key, value] of Object.entries(properties || {})) {
    map.set(String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), value);
  }
  return map;
}

function text(value) {
  if (value == null) return null;
  const trimmed = String(value).replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

function integer(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

export function ownerSignature(ownerName, owner2) {
  return [...new Set(parties(ownerName, owner2).map((party) => party.key))].sort().join('|');
}

export function primaryOwnerKey(ownerName, owner2) {
  return parties(ownerName, owner2)[0]?.key || null;
}

/**
 * @param {{parcelId: string, properties: object, geometry: object|null}} record
 * @param {(geometry: object) => number|null} [areaSqFt] square feet of a geometry
 */
export function canonicalParcel(record, areaSqFt = () => null) {
  const properties = record?.properties || {};
  const fields = lookup(properties);
  const mapped = recordFromProperties(properties);
  const center = geometryCentroid(record?.geometry);
  const ownerName = text(mapped.owner_name);
  const ownerName2 = text(mapped.owner_2);
  const exemptCodes = ['exempt_1', 'exempt_2', 'exempt_3']
    .map((key) => text(fields.get(key)))
    .filter((code) => code && !/^(none|0)$/i.test(code));
  const area = record?.geometry ? areaSqFt(record.geometry) : null;
  return {
    parcelId: record.parcelId,
    parcelNo: text(fields.get('parcelno')),
    ownerName,
    ownerName2,
    ownerKey: primaryOwnerKey(ownerName, ownerName2),
    ownerSignature: ownerSignature(ownerName, ownerName2),
    mailingAddress: text(fields.get('address')),
    mailingCity: text(fields.get('city')),
    mailingState: text(fields.get('state')),
    mailingZip: text(fields.get('zip')),
    situsAddress: text(fields.get('location')),
    situsCity: text(fields.get('loc_city')),
    subdivision: text(fields.get('subname')),
    landAcres: fields.has('land_acres') ? numberOrNull(fields.get('land_acres')) : null,
    landSqFt: fields.has('land_sq_ft') ? numberOrNull(fields.get('land_sq_ft')) : null,
    areaSqFt: Number.isFinite(area) && area > 0 ? area : null,
    appraisedCents: cents(mapped.appraised_value),
    taxableCents: cents(mapped.taxable_value),
    exemptCents: cents(mapped.exemption_value),
    landValueCents: cents(numberOrNull(fields.get('apr_land_v'))),
    improvementValueCents: cents(numberOrNull(fields.get('apr_imps'))),
    exemptCodes,
    zoning: text(fields.get('zoning_typ')),
    propUse: text(fields.get('propuse')),
    yearBuilt: positive(integer(fields.get('year_built'))),
    waterfrontCode: integer(fields.get('water_fron')),
    deedRefDate: text(fields.get('d_ref_date')),
    valueHistory: (mapped.value_history || []).map((row) => ({ year: row.year, appraisedCents: cents(row.amount) })),
    centroidLat: center?.lat ?? null,
    centroidLng: center?.lon ?? null,
    geometry: record?.geometry || null,
    raw: properties,
  };
}

function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  return value != null && value > 0 ? value : null;
}
