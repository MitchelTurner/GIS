import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibrary } from '../lib/library.js';

test('the library keeps owner shares, town search, and closer comps', () => {
  const square = (lon, lat, size) => ({
    type: 'Polygon',
    coordinates: [[
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ]],
  });
  const library = createLibrary([
    feature('1', 'Ada Lovelace', 1, 100000, 'R', square(-131.65, 55.34, 0.001), 'Ward Cove'),
    feature('2', 'Ada Lovelace & Ben Lovelace', 1.1, 110000, 'R', square(-131.649, 55.341, 0.001), 'Dock Street'),
    feature('3', 'City of Ketchikan', 40, 500000, 'P', square(-131.40, 55.20, 0.01), 'Downtown'),
  ]);
  const report = library.ownerReport({ privateOnly: true });
  assert.equal(report.shown.some((owner) => owner.name === 'City of Ketchikan'), false);
  assert.equal(report.shown[0].name, 'Ada Lovelace');
  assert.equal(library.search('Ward Cove')[0].parcelno, '1');
  const comps = library.comps('1', 2);
  assert.equal(comps.comps[0].parcelno, '2');
  assert.equal(comps.subject.parties.length, 1);
  assert.deepEqual(comps.comps[0].parties.map((party) => party.share), [0.5, 0.5]);

  const restored = createLibrary(library.parcels);
  assert.equal(restored.parcels.find((parcel) => parcel.parcelno === '1').acres, 1);
  assert.equal(restored.ownerReport({ privateOnly: true }).shown[0].name, 'Ada Lovelace');
});

function feature(parcelno, owner, acres, value, zoning, geometry, location) {
  return {
    geometry,
    properties: {
      PARCELNO: parcelno,
      Owner_Name: owner,
      Land_Acres: acres,
      Total_Appr: value,
      Zoning_Typ: zoning,
      Location: location,
    },
  };
}
