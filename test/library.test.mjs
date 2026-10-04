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

test('a new file keeps a typed sale price and a typed share', () => {
  const library = createLibrary([
    feature('1', 'Ada Lovelace', 2.4, 410000, 'R', null, 'Ward Cove'),
    feature('2', 'Ada Lovelace & Ben Lovelace', 2.1, 390000, 'R', null, 'Dock Street'),
  ]);
  library.update('1', { sale_price: 250000 });
  library.update('2', { shares: { 'ADA LOVELACE': 0.6, 'BEN LOVELACE': 0.4 } });
  const first = library.replace([
    feature('1', 'Ada Lovelace', 2.4, 410000, 'R', null, 'Ward Cove'),
    feature('2', 'Ada Lovelace & Ben Lovelace', 2.1, 390000, 'R', null, 'Dock Street'),
  ]);
  assert.deepEqual(first.changes, { gained: [], lost: [] });
  assert.equal(library.parcels.find((parcel) => parcel.parcelno === '1').sale_price, 250000);
  const shared = library.comps('2').subject.parties;
  assert.equal(shared.find((party) => party.name === 'Ada Lovelace').share, 0.6);

  const empty = createLibrary();
  const opened = empty.replace([feature('1', 'Ada Lovelace', 1, 100000, 'R', null, 'Ward Cove')]);
  assert.deepEqual(opened.changes, { gained: [], lost: [] });

  const changed = library.replace([
    feature('1', 'Ada Lovelace', 2.4, 410000, 'R', null, 'Ward Cove'),
    feature('4', 'Ada Lovelace', 1, 80000, 'R', null, 'Ward Cove'),
  ]);
  assert.equal(changed.changes.gained.some((row) => row.name === 'Ada Lovelace' && row.count === 1), true);
  assert.equal(changed.changes.lost.some((row) => row.name === 'Ben Lovelace' && row.count === 1), true);
  assert.equal(library.parcels.find((parcel) => parcel.parcelno === '1').sale_price, 250000);
});

test('a linked trust shares one row and a sale year survives the next file', () => {
  const library = createLibrary([
    feature('1', 'Ada Lovelace', 2, 200000, 'R', null, 'Ward Cove', { Year_Built: 1978, Apr_Land_V: 80000, Apr_Imps: 120000, PropUse: 'RES' }),
    feature('2', 'Smith Family Trust', 4, 300000, 'R', null, 'Dock Street'),
  ]);
  const ada = library.ownerReport().shown.find((owner) => owner.name === 'Ada Lovelace');
  const trust = library.ownerReport().shown.find((owner) => owner.name === 'Smith Family Trust');
  assert.ok(ada && trust);
  library.setLinks({ [trust.ownerKey]: ada.ownerKey });
  const joined = library.ownerDetail(ada.ownerKey);
  assert.equal(joined.parcelCount, 2);
  assert.equal(joined.acres, 6);
  assert.equal(joined.name, 'Ada Lovelace');
  assert.equal(joined.linked.length, 1);
  assert.equal(joined.linked[0].name, 'Smith Family Trust');
  assert.equal(library.ownerReport().shown.length, 1);
  const parcel = library.parcels.find((item) => item.parcelno === '1');
  assert.equal(parcel.year_built, 1978);
  assert.equal(parcel.prop_use, 'RES');
  assert.equal(parcel.land_value, 80000);
  assert.equal(parcel.improvement_value, 120000);
  library.update('1', { sale_price: 250000, sale_year: 2024 });
  library.replace([
    feature('1', 'Ada Lovelace', 2, 200000, 'R', null, 'Ward Cove', { Year_Built: 1978, Apr_Land_V: 80000, Apr_Imps: 120000, PropUse: 'RES' }),
    feature('2', 'Smith Family Trust', 4, 300000, 'R', null, 'Dock Street'),
  ]);
  const kept = library.parcels.find((item) => item.parcelno === '1');
  assert.equal(kept.sale_price, 250000);
  assert.equal(kept.sale_year, 2024);
  assert.equal(library.comps('1').subject.yearBuilt, 1978);
  assert.equal(library.comps('1').subject.propUse, 'RES');
  assert.equal(library.comps('1').subject.saleYear, 2024);
});

test('a zero appraised column does not hide the assessed amount', () => {
  const library = createLibrary([
    feature('1', 'Ada Lovelace', 2, 0, 'R', null, 'Ward Cove', {
      Total_Asse: 135400,
      Apr_Land_V: 0,
      Asd_Land_V: 80000,
      Apr_Imps: 0,
      Asd_Imp_Va: 55400,
    }),
    feature('2', 'Grace Hopper', 1, 111100, 'R', null, 'Dock Street', { Total_Asse: 0, Apr_Imps: 111100 }),
  ]);
  const exempt = library.parcels.find((parcel) => parcel.parcelno === '1');
  assert.equal(exempt.total_value, 135400);
  assert.equal(exempt.land_value, 80000);
  assert.equal(exempt.improvement_value, 55400);
  assert.equal(library.parcels.find((parcel) => parcel.parcelno === '2').total_value, 111100);
  assert.equal(library.ownerReport().shown.find((owner) => owner.name === 'Ada Lovelace').value, 135400);

  const fromParts = createLibrary([{
    geometry: null,
    properties: {
      PARCELNO: '3',
      Owner_Name: 'Nikola Tesla',
      Land_Acres: 1,
      Apr_Land_V: 80000,
      Apr_Imps: 120000,
    },
  }]);
  assert.equal(fromParts.parcels[0].total_value, 200000);

  const unknown = createLibrary([{
    geometry: null,
    properties: { PARCELNO: '4', Owner_Name: 'Nikola Tesla', Land_Acres: 1 },
  }]);
  assert.equal(unknown.parcels[0].total_value, null);
  assert.equal(unknown.ownerReport().shown[0].value, null);
});

test('appraised, taxable, exemption, waterfront, and assessment history stay distinct', () => {
  const library = createLibrary([
    feature('1', 'Ada Lovelace', 2, 111100, 'R', null, 'Ward Cove', {
      Total_Asse: 0,
      Total_Exem: 111100,
      Exempt_1: 'SENIOR',
      Exempt_2: 'NONE',
      Water_Fron: 155,
      D_Ref_Date: '24-AUG-84',
      Asse_Year1: 2026,
      Total_Apr1: 111100,
      Asse_Year2: 2025,
      Total_Apr2: 100000,
      Address_full: '1 Pine St',
      CITY: 'Seattle',
      State: 'WA',
      ZIP: '98101',
      Loc_City: 'Ketchikan',
    }),
  ]);
  const parcel = library.parcels[0];
  assert.equal(parcel.appraised_value, 111100);
  assert.equal(parcel.taxable_value, 0);
  assert.equal(parcel.exemption, 'SENIOR');
  assert.equal(parcel.exemption_value, 111100);
  assert.equal(parcel.total_value, 111100);
  assert.equal(parcel.waterfront, 155);
  assert.equal(parcel.deed_date, '24-AUG-84');
  assert.deepEqual(parcel.value_history, [
    { year: 2025, amount: 100000 },
    { year: 2026, amount: 111100 },
  ]);
  const owner = library.ownerDetail(library.ownerReport().shown[0].ownerKey);
  assert.equal(owner.absentee, true);
  assert.equal(owner.mailingStreet, '1 Pine St');
  assert.equal(owner.mailingCity, 'Seattle');
  assert.equal(owner.mailingState, 'WA');
  assert.equal(owner.mailingZip, '98101');
  assert.equal(owner.propertyTown, 'Ketchikan');
  const view = library.comps('1').subject;
  assert.equal(view.appraisedValue, 111100);
  assert.equal(view.taxableValue, 0);
  assert.equal(view.deedDate, '24-AUG-84');
  assert.equal(view.valueHistory.length, 2);
});

function feature(parcelno, owner, acres, value, zoning, geometry, location, extra = {}) {
  return {
    geometry,
    properties: {
      PARCELNO: parcelno,
      Owner_Name: owner,
      Land_Acres: acres,
      Total_Appr: value,
      Zoning_Typ: zoning,
      Location: location,
      ...extra,
    },
  };
}
