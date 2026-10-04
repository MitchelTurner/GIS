import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalParcel } from '../lib/canonical.js';
import { createLibrary, featuresFromParcels, recordsFromText } from '../lib/library.js';

const fixture = readFileSync(new URL('./fixtures/parcels.geojson', import.meta.url), 'utf8');

test('parcels saved in a browser rebuild into GeoJSON the server imports the same way', () => {
  const original = recordsFromText(fixture, 'parcels.geojson');
  const saved = createLibrary(original).parcels;
  const rebuilt = recordsFromText(JSON.stringify(featuresFromParcels(saved)), 'saved.geojson');
  const again = createLibrary(rebuilt).parcels;
  assert.equal(again.length, saved.length);
  const fields = ['parcelno', 'owner_name', 'owner_2', 'mailing_address', 'mailing_city', 'mailing_state', 'mailing_zip',
    'location', 'loc_city', 'subdivision', 'appraised_value', 'taxable_value', 'exemption_value', 'exemption',
    'land_value', 'improvement_value', 'zoning', 'prop_use', 'year_built', 'waterfront', 'deed_date', 'value_history'];
  for (const [index, parcel] of saved.entries()) {
    for (const field of fields) assert.deepEqual(again[index][field], parcel[field], `${parcel.parcelno} ${field}`);
    assert.deepEqual(again[index].geometry, parcel.geometry);
  }
  const before = original.map((record) => canonicalParcel(record));
  const after = rebuilt.map((record) => canonicalParcel(record));
  for (const [index, row] of before.entries()) {
    for (const key of ['parcelId', 'ownerName', 'ownerSignature', 'situsAddress', 'appraisedCents', 'taxableCents', 'landValueCents',
      'improvementValueCents', 'exemptCodes', 'zoning', 'propUse', 'yearBuilt', 'waterfrontCode', 'deedRefDate', 'valueHistory']) {
      assert.deepEqual(after[index][key], row[key], `${row.parcelId} ${key}`);
    }
  }
});
