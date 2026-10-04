import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyArcGisUrl,
  isBasemapUrl,
  KETCHIKAN_OWNERS_URL,
  esriPolygonToGeoJson,
  esriFeatureToGeoJson,
  cleanFeature,
  recommendedField,
  isSystemField,
  contactField,
  contactColumns,
  featuresToCsv,
  displayProperties,
  pullFeatures,
  readEndpoint,
} from '../extension/lib/arcgis.js';

test('the imagery basemap is not the owner layer', () => {
  assert.equal(isBasemapUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'), true);
  assert.equal(isBasemapUrl(KETCHIKAN_OWNERS_URL), false);
  const owners = classifyArcGisUrl(KETCHIKAN_OWNERS_URL);
  assert.equal(owners.kind, 'layer');
  assert.equal(owners.url, KETCHIKAN_OWNERS_URL);
});

test('classifyArcGisUrl keeps the layer and drops the query', () => {
  const layer = classifyArcGisUrl('https://gis.example.com/arcgis/rest/services/Parcels/MapServer/0/query?f=json');
  assert.deepEqual(layer, {
    url: 'https://gis.example.com/arcgis/rest/services/Parcels/MapServer/0',
    kind: 'layer',
    id: 0,
  });
  const service = classifyArcGisUrl('https://gis.example.com/arcgis/rest/services/Parcels/FeatureServer');
  assert.equal(service.kind, 'service');
  assert.equal(classifyArcGisUrl('https://example.com/not-a-map'), null);
});

test('esri rings become one polygon with a hole', () => {
  const geometry = esriPolygonToGeoJson([
    [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]],
    [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]],
  ]);
  assert.equal(geometry.type, 'Polygon');
  assert.equal(geometry.coordinates.length, 2);
});

test('two outer rings become a multipolygon', () => {
  const geometry = esriPolygonToGeoJson([
    [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]],
    [[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]],
  ]);
  assert.equal(geometry.type, 'MultiPolygon');
  assert.equal(geometry.coordinates.length, 2);
});

test('points and lines convert', () => {
  const point = esriFeatureToGeoJson({ attributes: { APN: '1' }, geometry: { x: -131.6, y: 55.3 } });
  assert.equal(point.geometry.type, 'Point');
  assert.equal(point.properties.APN, '1');
  const line = esriFeatureToGeoJson({
    attributes: {},
    geometry: { paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
  });
  assert.equal(line.geometry.type, 'MultiLineString');
});

test('cleanFeature rounds coordinates and drops empty geometry', () => {
  const cleaned = cleanFeature({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-131.646789, 55.342123] },
    properties: { APN: '1' },
  }, 3);
  assert.deepEqual(cleaned.geometry.coordinates, [-131.647, 55.342]);
  assert.equal(cleanFeature({ type: 'Feature', geometry: null, properties: {} }, 6), null);
});

test('contact fields are the owner, town, mailing address, size, and value', () => {
  const field = (name) => ({ name, alias: name, type: 'String', esriType: 'esriFieldTypeString' });
  assert.equal(contactField(field('Owner_Name')), true);
  assert.equal(contactField(field('Address_full')), true);
  assert.equal(contactField(field('CITY')), true);
  assert.equal(contactField(field('Land_Acres')), true);
  assert.equal(contactField(field('Total_Appr')), true);
  assert.equal(contactField(field('Apr_Land_V')), true);
  assert.equal(contactField(field('Zoning_Typ')), true);
  assert.equal(contactField(field('Owner_1_1')), false);
  assert.equal(contactField(field('OBJECTID')), false);
  const columns = contactColumns([{
    properties: { LotNum: '3', ZIP: '99901', Owner_Name: 'Ada', CITY: 'Ketchikan', Address: '1 Dock St' },
  }]);
  assert.deepEqual(columns, ['Owner_Name', 'Address', 'CITY', 'ZIP']);
  const csv = featuresToCsv([{
    properties: { Owner_Name: 'Ada "A"', Address_full: '1 Dock St, Ketchikan, AK 99901' },
  }], ['Owner_Name', 'Address_full']);
  assert.equal(csv, 'Owner_Name,Address_full\n"Ada ""A""","1 Dock St, Ketchikan, AK 99901"\n');
  assert.deepEqual(displayProperties({
    SUBNUM: 'A',
    Owner_Name: 'Ada',
    LotNum: '3',
    CITY: 'Ketchikan',
  }).map(([key]) => key), ['Owner_Name', 'CITY', 'LotNum', 'SUBNUM']);
});

test('recommended fields skip ids and sparse columns', () => {
  assert.equal(isSystemField({ name: 'OBJECTID', type: 'OID', esriType: 'esriFieldTypeOID' }), true);
  assert.equal(isSystemField({ name: 'Shape_Area', type: 'Double', esriType: 'esriFieldTypeDouble' }), true);
  assert.equal(recommendedField({ name: 'APN', type: 'String', esriType: 'esriFieldTypeString' }, 100), true);
  assert.equal(recommendedField({ name: 'OWNER', type: 'String', esriType: 'esriFieldTypeString' }, 40), false);
  assert.equal(recommendedField({ name: 'ZONING', type: 'String', esriType: 'esriFieldTypeString' }, undefined), true);
});

test('pullFeatures falls back to Esri JSON and keeps both batches', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    const params = new URLSearchParams(url.search);
    if (init?.body) {
      for (const [key, value] of new URLSearchParams(init.body)) params.set(key, value);
    }
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!url.pathname.endsWith('/query')) {
      return json({ name: 'Tax Parcels', objectIdField: 'OBJECTID', maxRecordCount: 1000, fields: [] });
    }
    assert.equal(init?.method, 'POST');
    assert.equal(url.search, '');
    if (params.get('returnIdsOnly') === 'true') return json({ objectIds: [10, 11] });
    if (params.get('f') === 'geojson') {
      return json({ error: { code: 400, message: 'Invalid output format' } });
    }
    const id = params.get('objectIds');
    return json({
      features: [{
        attributes: { APN: id },
        geometry: { rings: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
      }],
    });
  };
  try {
    const result = await pullFeatures('https://gis.example.com/arcgis/rest/services/Parcels/MapServer/0', {
      fields: ['APN'],
      batch: 1,
      precision: 2,
    });
    assert.equal(result.features.length, 2);
    assert.deepEqual(result.features.map((feature) => feature.properties.APN).sort(), ['10', '11']);
    assert.equal(result.collection.type, 'FeatureCollection');
    assert.equal(result.report[0].field, 'APN');
    assert.equal(result.report[0].pct, 100);
  } finally {
    globalThis.fetch = original;
  }
});

test('readEndpoint lists service layers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    mapName: 'Borough',
    currentVersion: 10.8,
    layers: [{ id: 0, name: 'Tax Parcels', geometryType: 'esriGeometryPolygon' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const info = await readEndpoint('https://gis.example.com/arcgis/rest/services/Parcels/MapServer');
    assert.equal(info.kind, 'service');
    assert.equal(info.layers[0].url, 'https://gis.example.com/arcgis/rest/services/Parcels/MapServer/0');
  } finally {
    globalThis.fetch = original;
  }
});
