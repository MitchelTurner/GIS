import assert from 'node:assert/strict';
import test from 'node:test';
import { asFeatureCollection, classifyDocument } from '../public/viewer.js';

test('classifyDocument tells a parcel file from a field report', () => {
  assert.equal(classifyDocument({
    type: 'FeatureCollection',
    features: [],
  }), 'geojson');
  assert.equal(classifyDocument({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-131.6, 55.3] },
    properties: { LotNum: '3' },
  }), 'geojson');
  assert.equal(classifyDocument({
    type: 'Polygon',
    coordinates: [[[-131.6, 55.3], [-131.5, 55.3], [-131.5, 55.4], [-131.6, 55.3]]],
  }), 'geojson');
  assert.equal(classifyDocument([
    { field: 'LotNum', filled: 100, pct: 100 },
    { field: 'SUBNUM', filled: 40, pct: 40 },
  ]), 'report');
  assert.equal(classifyDocument({ name: 'notes' }), 'json');
  assert.equal(classifyDocument([]), 'json');
});

test('asFeatureCollection wraps a single feature and a bare geometry', () => {
  const feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-131.6, 55.3] },
    properties: { LotNum: '3' },
  };
  assert.deepEqual(asFeatureCollection(feature), {
    type: 'FeatureCollection',
    features: [feature],
  });
  const geometry = { type: 'Point', coordinates: [-131.6, 55.3] };
  assert.equal(asFeatureCollection(geometry).features[0].geometry, geometry);
  const collection = { type: 'FeatureCollection', features: [feature] };
  assert.equal(asFeatureCollection(collection), collection);
});
