import assert from 'node:assert/strict';
import test from 'node:test';
import { aiStatus, explainComps } from '../lib/comps-ai.js';
import { geometryAcres, isCondo, isPublicOwner, neighborBenchmarks, ownerKey, ownershipChanges, parties, placesDiffer, rankComps, summarizeOwners } from '../lib/ownership.js';
import { compsFor, getParcel, importRecords, listSearches, openDatabase, ownerReport, searchParcels, updateParcel } from '../lib/parcels-db.js';

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

test('mail in another city, a condo, and a rate under the nearby median', () => {
  assert.equal(placesDiffer('Ketchikan', 'Seattle'), true);
  assert.equal(placesDiffer('Ketchikan', 'ketchikan'), false);
  assert.equal(placesDiffer('Ketchikan', 'Ketchikan Gateway'), false);
  assert.equal(placesDiffer('', 'Seattle'), false);
  assert.equal(isCondo({ prop_use: 'CONDO' }), true);
  assert.equal(isCondo({ prop_use: 'RES' }), false);
  const parcels = [];
  for (let index = 0; index < 5; index += 1) {
    parcels.push({
      parcelno: `e${index}`,
      zoning: 'R',
      total_value: 100000,
      acres: 1,
      lat: 55.34,
      lon: -131.65,
    });
  }
  parcels.push({
    parcelno: 'cheap',
    zoning: 'R',
    total_value: 10000,
    acres: 1,
    lat: 55.341,
    lon: -131.651,
  });
  const bench = neighborBenchmarks(parcels);
  assert.equal(bench.get('cheap').below, true);
  assert.equal(bench.get('e0').below, false);
  assert.ok(bench.get('cheap').median > bench.get('cheap').rate);
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

test('the local database keeps a typed sale and a typed share', () => {
  const db = openDatabase(':memory:');
  const square = (lon, lat) => ({
    type: 'Polygon',
    coordinates: [[[lon, lat], [lon + 0.001, lat], [lon + 0.001, lat + 0.001], [lon, lat + 0.001], [lon, lat]]],
  });
  const rows = [
    feature('1', 'Ada Lovelace', 1, 100000, 'R', square(-131.65, 55.34)),
    feature('2', 'Ada Lovelace & Ben Lovelace', 1.1, 110000, 'R', square(-131.649, 55.341)),
  ];
  importRecords(db, rows);
  updateParcel(db, '2', { sale_price: 250000, sale_year: 2024, shares: { 'ADA LOVELACE': 0.6, 'BEN LOVELACE': 0.4 } });
  importRecords(db, rows);
  const kept = getParcel(db, '2');
  assert.equal(kept.sale_price, 250000);
  assert.equal(kept.sale_year, 2024);
  const comps = compsFor(db, '2', 2, { save: false });
  assert.equal(comps.subject.salePrice, 250000);
  assert.deepEqual(comps.subject.parties.map((party) => party.share).sort(), [0.4, 0.6]);
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

  const off = aiStatus({ apiKey: '' });
  assert.equal(off.available, false);
  const on = aiStatus({ apiKey: 'secret-key', model: 'test-model' });
  assert.deepEqual(on, { available: true, model: 'test-model' });

  let asked = null;
  const answer = await explainComps(
    {
      parcelno: '9',
      taxableValue: 0,
      appraisedValue: 10000,
      exemption: 'SENCT',
      waterfront: 155,
      deedDate: '24-AUG-84',
      valueHistory: [{ year: 2025, amount: 9000 }, { year: 2026, amount: 10000 }],
      neighbor: { rate: 10000, median: 100000, below: true },
    },
    [],
    {
      apiKey: 'test-key',
      question: '  Is the taxable amount the one to use?  ',
      fetchImpl: async (_url, init) => {
        asked = JSON.parse(JSON.parse(init.body).messages[1].content);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Taxable is zero.' } }] }) };
      },
    },
  );
  assert.equal(answer.text, 'Taxable is zero.');
  assert.equal(asked.question, 'Is the taxable amount the one to use?');
  assert.equal(asked.subject.taxable, 0);
  assert.equal(asked.subject.appraised, 10000);
  assert.equal(asked.subject.exemption, 'SENCT');
  assert.equal(asked.subject.waterfront, 'Yes');
  assert.equal(asked.subject.deedDate, '24-AUG-84');
  assert.equal(asked.subject.neighbor.below, true);
  assert.deepEqual(asked.subject.valueHistory, [
    { year: 2025, amount: 9000 },
    { year: 2026, amount: 10000 },
  ]);
  assert.equal(JSON.stringify(asked).includes('155'), false);
  assert.equal(JSON.stringify(asked).includes('secret'), false);
});

test('a pasted key is trimmed and a rejected key says what to fix', async () => {
  let auth = '';
  const rejected = await explainComps({ parcelno: '1' }, [], {
    apiKey: ' "sk-test-key"\n',
    fetchImpl: async (_url, init) => {
      auth = init.headers.Authorization;
      return { ok: false, status: 401, json: async () => ({ error: { code: 'invalid_api_key', message: 'Incorrect API key provided: sk-tes***-key' } }) };
    },
  });
  assert.equal(auth, 'Bearer sk-test-key');
  assert.equal(rejected.status, 401);
  assert.match(rejected.text, /api\.openai\.com turned down the key \(ends in -key, invalid_api_key\) \(HTTP 401\)/);
  assert.match(rejected.text, /AI_API_KEY/);
  assert.doesNotMatch(rejected.text, /sk-test/);
});

test('a rejected AI_API_KEY falls back to OPENAI_API_KEY', async (t) => {
  const saved = { AI_API_KEY: process.env.AI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.AI_API_KEY = 'sk-old-1111';
  process.env.OPENAI_API_KEY = 'sk-new-2222';
  const used = [];
  const fetchImpl = async (_url, init) => {
    used.push(init.headers.Authorization);
    if (init.headers.Authorization.endsWith('2222')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Compared.' } }] }) };
    }
    return { ok: false, status: 401, json: async () => ({ error: { code: 'invalid_api_key' } }) };
  };
  const answer = await explainComps({ parcelno: '1' }, [], { fetchImpl });
  assert.equal(answer.text, 'Compared.');
  assert.deepEqual(used, ['Bearer sk-old-1111', 'Bearer sk-new-2222']);

  process.env.OPENAI_API_KEY = 'sk-also-bad-3333';
  const both = await explainComps({ parcelno: '1' }, [], {
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'invalid_api_key' } }) }),
  });
  assert.match(both.text, /AI_API_KEY \(ends in 1111, invalid_api_key\) and OPENAI_API_KEY \(ends in 3333, invalid_api_key\)/);
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

test('an old sale stays on assessed value', () => {
  const subject = { parcelno: '1', acres: 1, total_value: 100000, sale_price: 200000, sale_year: 2025, zoning: 'R', lat: 55.34, lon: -131.65 };
  const ranked = rankComps(subject, [
    { parcelno: 'old', acres: 1.1, total_value: 500000, sale_price: 210000, sale_year: 2014, zoning: 'R', lat: 55.341, lon: -131.649 },
    { parcelno: 'near', acres: 1.05, total_value: 105000, zoning: 'R', lat: 55.341, lon: -131.649 },
  ], 2);
  assert.equal(ranked[0].parcelno, 'near');
  assert.equal(ranked.find((parcel) => parcel.parcelno === 'old').comp.comparedSale, false);
  assert.equal(ranked[0].comp.reasons.includes('similar assessed value per acre'), true);
});

test('a trust stays separate until it is linked', () => {
  assert.notEqual(ownerKey('Smith Family Trust'), ownerKey('Smith, John A'));
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
