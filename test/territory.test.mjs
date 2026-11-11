import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { geometryAcres } from '../lib/ownership.js';
import { normalizeRecord, recordsFromText } from '../lib/library.js';
import {
  dissolveHoldings,
  mailFlows,
  parseStreet,
  placeCoordinate,
  sharedMailboxes,
  shorelinePremium,
  streetBlock,
} from '../lib/territory.js';

function square(x, y, size = 0.01) {
  const lat = 55.34;
  return {
    type: 'Polygon',
    coordinates: [[
      [x, lat + y],
      [x + size, lat + y],
      [x + size, lat + y + size],
      [x, lat + y + size],
      [x, lat + y],
    ]],
  };
}

function parcel(id, owner, geometry, extra = {}) {
  return {
    parcelno: id,
    owner_name: owner,
    geometry,
    acres: 1,
    total_value: 100000,
    loc_city: 'Ketchikan',
    ...extra,
  };
}

test('touching parcels of one owner become one shape', () => {
  const features = dissolveHoldings([
    parcel('a', 'Ada Lovelace', square(-131.65, 0)),
    parcel('b', 'Ada Lovelace', square(-131.64, 0)),
    parcel('c', 'Ben Lovelace', square(-131.63, 0)),
  ]);
  assert.equal(features.length, 2);
  const ada = features.find((feature) => feature.properties.ownerName === 'Ada Lovelace');
  assert.equal(ada.geometry.type, 'Polygon');
  assert.equal(ada.properties.parcelCount, 2);
  assert.deepEqual(ada.properties.parcelnos, ['a', 'b']);
  const one = geometryAcres(square(-131.65, 0));
  const joined = geometryAcres(ada.geometry);
  assert.ok(joined > one * 1.9 && joined < one * 2.1);
});

test('parcels that only meet at a corner stay separate', () => {
  const features = dissolveHoldings([
    parcel('a', 'Ada Lovelace', square(-131.65, 0)),
    parcel('b', 'Ada Lovelace', square(-131.64, 0.01)),
  ]);
  assert.equal(features[0].geometry.type, 'MultiPolygon');
  assert.equal(features[0].geometry.coordinates.length, 2);
});

test('shoreline premium compares waterfront and inland lots in a zone', () => {
  const parcels = [];
  for (let index = 0; index < 4; index += 1) {
    parcels.push(parcel(`w${index}`, 'Ada', null, { zoning: 'WC', waterfront: 80, total_value: 200000, acres: 1, geometry: square(-131.6, index * 0.02) }));
    parcels.push(parcel(`i${index}`, 'Ben', null, { zoning: 'WC', waterfront: 0, total_value: 100000, acres: 1, geometry: square(-131.5, index * 0.02) }));
  }
  const priced = shorelinePremium(parcels);
  assert.equal(priced.zones.length, 1);
  assert.equal(priced.zones[0].zoning, 'WC');
  assert.ok(priced.zones[0].premium > 1.9 && priced.zones[0].premium < 2.1);
  assert.ok(priced.overall.premium > 1.9);
});

test('mail routes locate a known city and skip a local one', () => {
  assert.deepEqual(placeCoordinate('Seattle', 'WA'), { lon: -122.3321, lat: 47.6062 });
  const flows = mailFlows([
    parcel('a', 'Ada', square(-131.65, 0), { mailing_city: 'Seattle', mailing_state: 'WA', lon: -131.65, lat: 55.34 }),
    parcel('b', 'Ben', square(-131.64, 0), { mailing_city: 'Seattle', mailing_state: 'WA', lon: -131.64, lat: 55.34 }),
    parcel('c', 'Cara', square(-131.63, 0), { mailing_city: 'Ketchikan', mailing_state: 'AK', lon: -131.63, lat: 55.34 }),
  ]);
  const seattle = flows.find((flow) => flow.city === 'Seattle');
  const home = flows.find((flow) => flow.city === 'Ketchikan');
  assert.equal(seattle.count, 2);
  assert.equal(seattle.away, 2);
  assert.ok(seattle.to);
  assert.equal(home.to, null);
});

test('a street lists the nearby house numbers', () => {
  assert.deepEqual(parseStreet('Water St 120'), { number: 120, street: 'water street' });
  const subject = parcel('mid', 'Ada', null, { location: 'Water St 120' });
  const parcels = [
    subject,
    parcel('low', 'Ben', null, { location: '100 Water Street' }),
    parcel('high', 'Cara', null, { location: 'Cedar Ave 10' }),
    parcel('next', 'Dee', null, { location: 'Water Street 140' }),
  ];
  const block = streetBlock(subject, parcels);
  assert.deepEqual(block.map((row) => row.parcelno), ['low', 'mid', 'next']);
  assert.equal(block[1].current, true);
});

test('two owners at one mailbox are grouped', () => {
  const boxes = sharedMailboxes([
    parcel('a', 'Harbor House LLC', null, { mailing_address: '500 Union St', mailing_city: 'Seattle', mailing_state: 'WA', mailing_zip: '98101' }),
    parcel('b', 'Front Street Partners', null, { mailing_address: '500 Union St', mailing_city: 'Seattle', mailing_state: 'WA', mailing_zip: '98101' }),
    parcel('c', 'Maya Chen', null, { mailing_address: '12 Main St', mailing_city: 'Ketchikan', mailing_state: 'AK', mailing_zip: '99901' }),
  ]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].label, '500 Union St, Seattle, WA 98101');
  assert.deepEqual(boxes[0].owners.map((owner) => owner.name).sort(), ['Front Street Partners', 'Harbor House LLC']);
  assert.deepEqual(boxes[0].parcelnos, ['a', 'b']);
  const full = sharedMailboxes([
    parcel('a', 'Maya Chen', null, { mailing_address: '18 Creek St, Ketchikan, AK 99901', mailing_city: 'Ketchikan', mailing_state: 'AK', mailing_zip: '99901' }),
    parcel('b', 'Wei Chen', null, { mailing_address: '18 Creek St, Ketchikan, AK 99901', mailing_city: 'Ketchikan', mailing_state: 'AK', mailing_zip: '99901' }),
  ]);
  assert.equal(full[0].label, '18 Creek St, Ketchikan, AK 99901');
});

test('the sample plat dissolves without dropping land', async () => {
  const text = await readFile(new URL('../public/sample.geojson', import.meta.url), 'utf8');
  const records = recordsFromText(text, 'sample.geojson').map((record, index) => normalizeRecord(record, index));
  const features = dissolveHoldings(records);
  assert.ok(features.length > 0);
  assert.ok(features.length < records.length);
  const before = records.reduce((sum, record) => sum + (geometryAcres(record.geometry) || 0), 0);
  const after = features.reduce((sum, feature) => sum + (geometryAcres(feature.geometry) || 0), 0);
  assert.ok(after > before * 0.9 && after < before * 1.1);
});
