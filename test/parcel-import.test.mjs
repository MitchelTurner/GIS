import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalParcel } from '../lib/canonical.js';
import { createLibrary, recordsFromText } from '../lib/library.js';
import { assignParcelIds, baseParcelId } from '../lib/parcel-ids.js';
import { describeImport, planImport } from '../lib/parcel-import.js';
import { recordsFromGeoJson } from '../lib/records.js';

const first = readFileSync(new URL('./fixtures/parcels.geojson', import.meta.url), 'utf8');
const second = readFileSync(new URL('./fixtures/parcels-reimport.geojson', import.meta.url), 'utf8');

function canonical(text) {
  return assignParcelIds(recordsFromGeoJson(JSON.parse(text))).records.map((record) => canonicalParcel(record));
}

test('Parcel_Num is the key, so condo units that share a PARCELNO stay separate', () => {
  const ids = assignParcelIds(recordsFromGeoJson(JSON.parse(first))).records.map((record) => record.parcelId);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
  assert.ok(ids.includes('9000000008000001'));
  assert.ok(ids.includes('9000000008000002'));
  const library = createLibrary(recordsFromText(first, 'parcels.geojson'));
  assert.equal(library.parcels.length, 10);
});

test('PARCELNO is the fallback, and placeholders get a stable shape suffix', () => {
  assert.equal(baseParcelId({ PARCELNO: ' 123 ', Parcel_Num: '' }), '123');
  const shape = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const other = { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] };
  const run = () => assignParcelIds([
    { properties: { PARCELNO: '<NA>', Parcel_Num: '' }, geometry: shape },
    { properties: { PARCELNO: '<NA>', Parcel_Num: '' }, geometry: other },
    { properties: { PARCELNO: 'STATE DOT' }, geometry: shape },
  ]).records.map((record) => record.parcelId);
  const ids = run();
  assert.equal(new Set(ids).size, 3);
  assert.match(ids[0], /^<NA>~[0-9a-f]{8}$/);
  assert.match(ids[2], /^STATE DOT~[0-9a-f]{8}$/);
  assert.deepEqual(run(), ids);
});

test('An exact repeated row is dropped; a different row under the same number is kept', () => {
  const row = { properties: { Parcel_Num: '42', Owner_Name: 'LOVELACE ADA' }, geometry: null };
  const { records, duplicatesDropped } = assignParcelIds([
    row,
    { ...row },
    { properties: { Parcel_Num: '42', Owner_Name: 'HOPPER GRACE' }, geometry: null },
  ]);
  assert.equal(duplicatesDropped, 1);
  assert.equal(records[0].parcelId, '42');
  assert.match(records[1].parcelId, /^42~[0-9a-f]{8}$/);
});

test('canonicalParcel maps export fields to cents and keeps unknowns null', () => {
  const rows = canonical(first);
  const vacant = rows.find((row) => row.parcelId === '900000000100');
  assert.equal(vacant.ownerName, 'LOVELACE ADA');
  assert.equal(vacant.ownerKey, 'ADA LOVELACE');
  assert.equal(vacant.appraisedCents, 6000000);
  assert.equal(vacant.landValueCents, 6000000);
  assert.equal(vacant.improvementValueCents, 0);
  assert.equal(vacant.yearBuilt, null);
  assert.equal(vacant.propUse, 'VACANT');
  assert.equal(vacant.raw.PARCELNO, '900000000100');
  const city = rows.find((row) => row.parcelId === '900000000700');
  assert.deepEqual(city.exemptCodes, ['CTKET']);
  assert.equal(city.taxableCents, 0);
  const box = rows.find((row) => row.parcelId === '900000000600');
  assert.equal(box.mailingAddress, 'PO BOX 1234');
  const shared = rows.find((row) => row.parcelId === '900000000300');
  assert.equal(shared.ownerSignature, 'ADA LOVELACE|ANNE BYRON');
});

test('Re-import with one owner changed and one parcel removed: 1 changed, 1 missing, nothing deleted', () => {
  const firstPlan = planImport([], canonical(first));
  assert.equal(firstPlan.summary.added, 10);
  assert.equal(firstPlan.summary.ownerChanged, 0);
  const stored = firstPlan.rows.map((row) => ({ ...row, missingSince: null }));
  const plan = planImport(stored, canonical(second));
  assert.equal(plan.summary.ownerChanged, 1);
  assert.equal(plan.summary.missing, 1);
  assert.equal(plan.summary.added, 0);
  assert.deepEqual(plan.missingIds, ['900000000900']);
  const changed = plan.rows.find((row) => row.ownerChanged);
  assert.equal(changed.parcelId, '900000000400');
  assert.equal(changed.previousOwnerName, 'HOPPER GRACE');
  assert.equal(plan.rows.length + plan.missingIds.length, 10);
  assert.equal(describeImport(plan.summary), 'Imported 9 parcels, 1 owner changed, 1 missing from this file.');
});

test('A parcel that comes back clears its missing mark', () => {
  const rows = canonical(first);
  const stored = rows.map((row) => ({ ...row, missingSince: row.parcelId === '900000000900' ? '2026-01-01' : null }));
  const plan = planImport(stored, rows);
  assert.equal(plan.summary.returned, 1);
  assert.equal(plan.summary.missing, 0);
});

test('Owner padding and name punctuation alone do not count as a change', () => {
  const rows = canonical(first);
  const stored = rows.map((row) => ({ ...row, missingSince: null }));
  const tweaked = rows.map((row) => (row.parcelId === '900000000200'
    ? canonicalParcel({ parcelId: row.parcelId, properties: { ...row.raw, Owner_Name: '  LOVELACE,  ADA. ' }, geometry: row.geometry })
    : row));
  assert.equal(planImport(stored, tweaked).summary.ownerChanged, 0);
});

test('Server status fields reach the parcel view', () => {
  const data = JSON.parse(first);
  data.features.forEach((feature, index) => {
    feature.parcelId = index ? `server-${index}` : 'server-id';
  });
  data.features[0].status = { ownerChangedAt: '2026-10-04T00:00:00.000Z', previousOwnerName: 'HOPPER GRACE', missingSince: null };
  const library = createLibrary(recordsFromText(JSON.stringify(data), 'server.geojson'));
  const view = library.comps('server-id').subject;
  assert.equal(view.previousOwnerName, 'HOPPER GRACE');
  assert.equal(view.ownerChangedAt, '2026-10-04T00:00:00.000Z');
  assert.equal(view.missingSince, null);
});
