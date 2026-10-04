import assert from 'node:assert/strict';
import test from 'node:test';
import { explainComps } from '../lib/comps-ai.js';
import { geometryAcres, isPublicOwner, ownerKey, ownershipChanges, parties, rankComps, summarizeOwners } from '../lib/ownership.js';
import { compsFor, importRecords, listSearches, openDatabase, ownerReport, searchParcels } from '../lib/parcels-db.js';

test('two names on a parcel split the land equally', () => {
  const owners = parties('Ada Lovelace & Ben Lovelace', null);
  assert.equal(owners.length, 2);
  assert.equal(owners[0].share, 0.5);
  assert.equal(isPublicOwner('City of Ketchikan'), true);
  assert.equal(isPublicOwner('Ada Lovelace'), false);

  const parcels = [
    { parcelno: 'A', acres: 10, total_value: 100 },
    { parcelno: 'B', acres: 10, total_value: 100 },
  ];
  const holdings = [
    { owner_key: 'ADA', display_name: 'Ada', public_owner: 0, parcelno: 'A', share: 1, acres: 10, value: 100 },
    { owner_key: 'ADA', display_name: 'Ada', public_owner: 0, parcelno: 'B', share: 0.5, acres: 10, value: 100 },
    { owner_key: 'BEN', display_name: 'Ben', public_owner: 0, parcelno: 'B', share: 0.5, acres: 10, value: 100 },
  ];
  const [ada, ben] = summarizeOwners(holdings, parcels);
  assert.equal(ada.name, 'Ada');
  assert.equal(ada.acres, 15);
  assert.equal(ada.acreShare, 0.75);
  assert.equal(ben.acreShare, 0.25);
});

test('a polygon has acres and a larger one has more', () => {
  const small = geometryAcres({
    type: 'Polygon',
    coordinates: [[
      [-131.650, 55.340],
      [-131.649, 55.340],
      [-131.649, 55.341],
      [-131.650, 55.341],
      [-131.650, 55.340],
    ]],
  });
  const large = geometryAcres({
    type: 'Polygon',
    coordinates: [[
      [-131.650, 55.340],
      [-131.640, 55.340],
      [-131.640, 55.350],
      [-131.650, 55.350],
      [-131.650, 55.340],
    ]],
  });
  assert.ok(small > 0);
  assert.ok(large > small * 50);
});

test('the database keeps owners, searches, and closer comps', () => {
  const db = openDatabase(':memory:');
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
  importRecords(db, [
    feature('1', 'Ada Lovelace', 1, 100000, 'R', square(-131.65, 55.34, 0.001)),
    feature('2', 'Ada Lovelace & Ben Lovelace', 1.1, 110000, 'R', square(-131.649, 55.341, 0.001)),
    feature('3', 'City of Ketchikan', 40, 500000, 'P', square(-131.40, 55.20, 0.01)),
  ]);
  const report = ownerReport(db, { privateOnly: true, limit: 10 });
  assert.equal(report.shown.some((owner) => owner.name === 'City of Ketchikan'), false);
  assert.equal(report.shown[0].name, 'Ada Lovelace');

  const matches = searchParcels(db, 'Ward Cove');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].parcelno, '1');
  db.prepare('UPDATE parcels SET loc_city = ? WHERE parcelno = ?').run('Saxman', '3');
  assert.equal(searchParcels(db, 'Saxman', { save: false })[0].parcelno, '3');
  assert.equal(listSearches(db)[0].query, 'Ward Cove');

  const comps = compsFor(db, '1', 2);
  assert.equal(comps.comps[0].parcelno, '2');
  assert.ok(comps.comps[0].comp.score > comps.comps[1].comp.score);
  assert.equal(comps.subject.parties.length, 1);
  assert.equal(comps.subject.parties[0].share, 1);
  assert.deepEqual(comps.comps[0].parties.map((party) => party.share), [0.5, 0.5]);
  assert.ok(report.value > 0);
});

test('AI comparison uses the ranked comps and stays quiet without a key', async () => {
  const quiet = await explainComps({ parcelno: '1' }, [], { apiKey: '' });
  assert.equal(quiet.available, false);
  let sent = null;
  const explained = await explainComps(
    { parcelno: '1', ownerName: 'Ada', acres: 1, totalValue: 100, zoning: 'R', location: 'Dock', locCity: 'Ketchikan', mailingCity: 'Anchorage' },
    [{ parcelno: '2', ownerName: 'Ben', acres: 1, totalValue: 90, zoning: 'R', location: 'Dock', comp: { score: 80, reasons: ['same zoning'] } }],
    {
      apiKey: 'test-key',
      fetchImpl: async (url, init) => {
        sent = { url, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Ben is the closer comp.' } }] }) };
      },
    },
  );
  assert.equal(explained.text, 'Ben is the closer comp.');
  assert.equal(JSON.parse(sent.body.messages[1].content).subject.sale, undefined);
  assert.match(sent.url, /chat\/completions$/);
  assert.match(sent.body.messages[1].content, /Ada/);
  assert.match(sent.body.messages[1].content, /mailingCity/);
  assert.match(sent.body.messages[1].content, /Ketchikan/);
  assert.doesNotMatch(sent.body.messages[1].content, /"city"/);

  let priced = null;
  await explainComps(
    { parcelno: '1', ownerName: 'Ada', salePrice: 200000 },
    [{ parcelno: '2', sale_price: 210000, comp: { score: 1, reasons: [] } }],
    {
      apiKey: 'test-key',
      fetchImpl: async (_url, init) => {
        priced = JSON.parse(JSON.parse(init.body).messages[1].content);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      },
    },
  );
  assert.equal(priced.subject.sale, 200000);
  assert.equal(priced.comps[0].sale, 210000);
});

function feature(parcelno, owner, acres, value, zoning, geometry) {
  return {
    geometry,
    properties: {
      PARCELNO: parcelno,
      Owner_Name: owner,
      Land_Acres: acres,
      Total_Appr: value,
      Zoning_Typ: zoning,
      Location: parcelno === '1' ? 'Ward Cove' : 'Dock Street',
    },
  };
}

test('rankComps prefers the similar neighbor', () => {
  const subject = { parcelno: '1', acres: 1, total_value: 100000, zoning: 'R', subdivision: 'Ada', lat: 55.34, lon: -131.65 };
  const [best] = rankComps(subject, [
    { parcelno: '2', acres: 1.1, total_value: 110000, zoning: 'R', subdivision: 'Ada', lat: 55.341, lon: -131.649, owner_name: 'Ben' },
    { parcelno: '3', acres: 40, total_value: 900000, zoning: 'I', subdivision: 'Far', lat: 55.1, lon: -131.2, owner_name: 'City' },
  ], 2);
  assert.equal(best.parcelno, '2');
  assert.equal(best.comp.reasons.includes('similar assessed value'), true);
});

test('the same person keeps one name across assessor spellings', () => {
  assert.equal(ownerKey('SMITH JOHN'), ownerKey('Smith, John A'));
  assert.equal(ownerKey('SMITH JOHN'), 'JOHN SMITH');
});

test('a typed share replaces the even split', () => {
  const owners = parties('Ada Lovelace & Ben Lovelace', null, { 'ADA LOVELACE': 0.6, 'BEN LOVELACE': 0.4 });
  const ada = owners.find((party) => party.display === 'Ada Lovelace');
  assert.equal(ada.share, 0.6);
  assert.equal(owners.find((party) => party.display === 'Ben Lovelace').share, 0.4);
});

test('sale prices rank comps when both parcels have one', () => {
  const subject = { parcelno: '1', acres: 1, total_value: 100000, sale_price: 200000, zoning: 'R', lat: 55.34, lon: -131.65 };
  const [best] = rankComps(subject, [
    { parcelno: '2', acres: 1.1, total_value: 500000, sale_price: 210000, zoning: 'R', lat: 55.341, lon: -131.649, owner_name: 'Ben' },
    { parcelno: '3', acres: 1.05, total_value: 100000, sale_price: 900000, zoning: 'R', lat: 55.341, lon: -131.649, owner_name: 'Cara' },
  ], 2);
  assert.equal(best.parcelno, '2');
  assert.equal(best.comp.comparedSale, true);
  assert.equal(best.comp.reasons.includes('similar sale price'), true);
});

test('a later file names who gained parcels and who lost them', () => {
  const parcel = { parcelno: '1', owner_name: 'Ada Lovelace', acres: 1 };
  const next = ownershipChanges(
    [parcel, { parcelno: '9', owner_name: 'City of Ketchikan', acres: 4 }],
    [parcel, { parcelno: '2', owner_name: 'Ada Lovelace', acres: 1 }],
  );
  assert.deepEqual(next.gained, [{ name: 'Ada Lovelace', count: 1 }]);
  assert.deepEqual(next.lost, [{ name: 'City of Ketchikan', count: 1 }]);
});
