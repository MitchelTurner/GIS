import { distanceKm, geometryAcres, isPublicOwner, parties, perAcre, placeKey, placesDiffer } from './ownership.js';

const SNAP = 1e6;

// City centroids for mailing arcs. [lon, lat]
const PLACES = {
  'anchorage|ak': [-149.9003, 61.2181],
  'wasilla|ak': [-149.4394, 61.5814],
  'palmer|ak': [-149.1128, 61.5997],
  'eagle river|ak': [-149.5678, 61.3219],
  'fairbanks|ak': [-147.7164, 64.8401],
  'juneau|ak': [-134.4197, 58.3019],
  'douglas|ak': [-134.457, 58.276],
  'sitka|ak': [-135.33, 57.0531],
  'ketchikan|ak': [-131.6461, 55.3422],
  'ward cove|ak': [-131.725, 55.408],
  'saxman|ak': [-131.598, 55.319],
  'metlakatla|ak': [-131.572, 55.129],
  'wrangell|ak': [-132.376, 56.471],
  'petersburg|ak': [-132.955, 56.812],
  'kake|ak': [-133.947, 56.976],
  'craig|ak': [-133.148, 55.476],
  'klawock|ak': [-133.096, 55.554],
  'haines|ak': [-135.444, 59.235],
  'skagway|ak': [-135.314, 59.458],
  'homer|ak': [-151.548, 59.643],
  'kenai|ak': [-151.258, 60.554],
  'soldotna|ak': [-151.058, 60.487],
  'kodiak|ak': [-152.407, 57.79],
  'nome|ak': [-165.406, 64.501],
  'utqiagvik|ak': [-156.788, 71.2906],
  'barrow|ak': [-156.788, 71.2906],
  'seattle|wa': [-122.3321, 47.6062],
  'bellevue|wa': [-122.2015, 47.6101],
  'tacoma|wa': [-122.4443, 47.2529],
  'olympia|wa': [-122.9007, 47.0379],
  'everett|wa': [-122.2021, 47.979],
  'bellingham|wa': [-122.4781, 48.7519],
  'spokane|wa': [-117.426, 47.6588],
  'vancouver|wa': [-122.6615, 45.6387],
  'kirkland|wa': [-122.2087, 47.6815],
  'redmond|wa': [-122.1215, 47.674],
  'kent|wa': [-122.2348, 47.3809],
  'renton|wa': [-122.2171, 47.4829],
  'portland|or': [-122.6784, 45.5152],
  'eugene|or': [-123.0868, 44.0521],
  'bend|or': [-121.3153, 44.0582],
  'salem|or': [-123.0351, 44.9429],
  'boise|id': [-116.2023, 43.615],
  'honolulu|hi': [-157.8583, 21.3069],
  'los angeles|ca': [-118.2437, 34.0522],
  'san diego|ca': [-117.1611, 32.7157],
  'san francisco|ca': [-122.4194, 37.7749],
  'sacramento|ca': [-121.4944, 38.5816],
  'san jose|ca': [-121.8863, 37.3382],
  'oakland|ca': [-122.2712, 37.8044],
  'phoenix|az': [-112.074, 33.4484],
  'scottsdale|az': [-111.9261, 33.4942],
  'tucson|az': [-110.9747, 32.2226],
  'las vegas|nv': [-115.1398, 36.1699],
  'reno|nv': [-119.8138, 39.5296],
  'salt lake city|ut': [-111.891, 40.7608],
  'denver|co': [-104.9903, 39.7392],
  'houston|tx': [-95.3698, 29.7604],
  'dallas|tx': [-96.797, 32.7767],
  'austin|tx': [-97.7431, 30.2672],
  'chicago|il': [-87.6298, 41.8781],
  'minneapolis|mn': [-93.265, 44.9778],
  'new york|ny': [-74.006, 40.7128],
  'brooklyn|ny': [-73.9442, 40.6782],
  'miami|fl': [-80.1918, 25.7617],
  'boston|ma': [-71.0589, 42.3601],
  'washington|dc': [-77.0369, 38.9072],
};

const STREET_SUFFIX = {
  st: 'street',
  ave: 'avenue',
  rd: 'road',
  dr: 'drive',
  ln: 'lane',
  blvd: 'boulevard',
  hwy: 'highway',
  cir: 'circle',
  ct: 'court',
  pl: 'place',
  ter: 'terrace',
  pkwy: 'parkway',
};

function pointKey(coord) {
  return `${Math.round(coord[0] * SNAP)},${Math.round(coord[1] * SNAP)}`;
}

function parseKey(key) {
  const [x, y] = key.split(',');
  return [Number(x) / SNAP, Number(y) / SNAP];
}

function sameCoord(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function pushRing(into, ring) {
  if (!ring || ring.length < 4) return;
  into.push(ring);
}

function collectRings(geometry, into) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates || []) pushRing(into, ring);
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates || []) {
      for (const ring of polygon || []) pushRing(into, ring);
    }
  } else if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries || []) collectRings(child, into);
  }
}

function shoelace(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function closeRing(points) {
  if (points.length < 3) return null;
  const ring = points.slice();
  if (!sameCoord(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
  if (ring.length < 4) return null;
  return ring;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = ((yi > point[1]) !== (yj > point[1]))
      && (point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-15) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringCentroid(ring) {
  const count = sameCoord(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length;
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < count; i += 1) {
    lon += ring[i][0];
    lat += ring[i][1];
  }
  return [lon / count, lat / count];
}

function dissolveRings(rings) {
  const net = new Map();
  for (const ring of rings) {
    const count = sameCoord(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length;
    for (let i = 0; i < count; i += 1) {
      const a = pointKey(ring[i]);
      const b = pointKey(ring[(i + 1) % count]);
      if (a === b) continue;
      const undirected = a < b ? `${a}|${b}` : `${b}|${a}`;
      let slot = net.get(undirected);
      if (!slot) {
        slot = { low: a < b ? a : b, high: a < b ? b : a, forward: 0, reverse: 0 };
        net.set(undirected, slot);
      }
      if (a < b) slot.forward += 1;
      else slot.reverse += 1;
    }
  }

  const outgoing = new Map();
  const unused = new Map();
  const addEdge = (from, to) => {
    const list = outgoing.get(from) || [];
    list.push(to);
    outgoing.set(from, list);
    const key = `${from}>${to}`;
    unused.set(key, (unused.get(key) || 0) + 1);
  };
  for (const slot of net.values()) {
    const flow = slot.forward - slot.reverse;
    const from = flow > 0 ? slot.low : slot.high;
    const to = flow > 0 ? slot.high : slot.low;
    for (let n = 0; n < Math.abs(flow); n += 1) addEdge(from, to);
  }

  const take = (from, to) => {
    const key = `${from}>${to}`;
    const left = unused.get(key) || 0;
    if (left <= 0) return false;
    if (left === 1) unused.delete(key);
    else unused.set(key, left - 1);
    return true;
  };

  const nextAfter = (prev, curr) => {
    const options = outgoing.get(curr);
    if (!options?.length) return null;
    const origin = parseKey(curr);
    const back = parseKey(prev);
    const incoming = Math.atan2(back[1] - origin[1], back[0] - origin[0]);
    let best = null;
    let bestDelta = Infinity;
    for (const to of options) {
      if ((unused.get(`${curr}>${to}`) || 0) <= 0) continue;
      const dest = parseKey(to);
      const angle = Math.atan2(dest[1] - origin[1], dest[0] - origin[0]);
      let delta = incoming - angle;
      while (delta <= 1e-9) delta += Math.PI * 2;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = to;
      }
    }
    return best;
  };

  const traced = [];
  for (const key of [...unused.keys()]) {
    if ((unused.get(key) || 0) <= 0) continue;
    const splitAt = key.indexOf('>');
    const startFrom = key.slice(0, splitAt);
    const startTo = key.slice(splitAt + 1);
    if (!take(startFrom, startTo)) continue;
    const points = [parseKey(startFrom), parseKey(startTo)];
    let prev = startFrom;
    let curr = startTo;
    let guard = 0;
    let closed = false;
    while (guard < 100000) {
      if (curr === startFrom) {
        closed = true;
        break;
      }
      const nxt = nextAfter(prev, curr);
      if (!nxt || !take(curr, nxt)) break;
      points.push(parseKey(nxt));
      prev = curr;
      curr = nxt;
      guard += 1;
    }
    const ring = closed ? closeRing(points) : null;
    if (ring && Math.abs(shoelace(ring)) > 1e-14) traced.push(ring);
  }
  return traced;
}

function polygonsFromRings(rings) {
  const signed = rings.map((ring) => ({ ring, area: shoelace(ring) }));
  const total = signed.reduce((sum, item) => sum + item.area, 0);
  if (total < 0) {
    for (const item of signed) {
      item.ring.reverse();
      if (!sameCoord(item.ring[0], item.ring[item.ring.length - 1])) item.ring.push(item.ring[0]);
      item.area = -item.area;
    }
  }
  const polygons = signed
    .filter((item) => item.area > 0)
    .sort((a, b) => a.area - b.area)
    .map((item) => ({ outer: item.ring, holes: [], area: item.area }));
  for (const item of signed) {
    if (item.area >= 0) continue;
    const sample = ringCentroid(item.ring);
    let host = null;
    for (const polygon of polygons) {
      if (polygon.area <= Math.abs(item.area)) continue;
      if (!pointInRing(sample, polygon.outer)) continue;
      if (!host || polygon.area < host.area) host = polygon;
    }
    if (host) {
      if (shoelace(item.ring) > 0) item.ring.reverse();
      host.holes.push(item.ring);
    } else {
      const outer = item.ring.slice();
      if (shoelace(outer) < 0) outer.reverse();
      polygons.push({ outer, holes: [], area: Math.abs(item.area) });
    }
  }
  return polygons;
}

function asMulti(geometries) {
  const coordinates = [];
  for (const geometry of geometries) {
    if (!geometry) continue;
    if (geometry.type === 'Polygon') coordinates.push(geometry.coordinates);
    else if (geometry.type === 'MultiPolygon') coordinates.push(...geometry.coordinates);
  }
  if (!coordinates.length) return null;
  if (coordinates.length === 1) return { type: 'Polygon', coordinates: coordinates[0] };
  return { type: 'MultiPolygon', coordinates };
}

function geometryFromPolygons(polygons) {
  const coordinates = polygons
    .filter((polygon) => polygon.outer?.length >= 4)
    .map((polygon) => [polygon.outer, ...polygon.holes]);
  if (!coordinates.length) return null;
  if (coordinates.length === 1) return { type: 'Polygon', coordinates: coordinates[0] };
  return { type: 'MultiPolygon', coordinates };
}

export function dissolveGeometries(geometries) {
  const list = (geometries || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const rings = [];
  for (const geometry of list) collectRings(geometry, rings);
  if (rings.length < 2) return asMulti(list);
  let dissolved = null;
  try {
    const traced = dissolveRings(rings);
    dissolved = geometryFromPolygons(polygonsFromRings(traced));
  } catch {
    dissolved = null;
  }
  const before = list.reduce((sum, geometry) => sum + (geometryAcres(geometry) || 0), 0);
  const after = geometryAcres(dissolved) || 0;
  if (!dissolved || (before > 0 && (after < before * 0.9 || after > before * 1.1))) return asMulti(list);
  return dissolved;
}

function featureBBox(geometry) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let count = 0;
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      count += 1;
      minLon = Math.min(minLon, node[0]);
      maxLon = Math.max(maxLon, node[0]);
      minLat = Math.min(minLat, node[1]);
      maxLat = Math.max(maxLat, node[1]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry?.coordinates);
  if (!count) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function primaryParty(parcel) {
  const list = parties(parcel.owner_name, parcel.owner_2, parcel.shares);
  if (!list.length) return null;
  return list.reduce((best, party) => (party.share > best.share ? party : best));
}

export function dissolveHoldings(parcels, resolveKey = (key) => key) {
  const groups = new Map();
  for (const parcel of parcels || []) {
    if (!parcel?.geometry) continue;
    const party = primaryParty(parcel);
    const ownerKey = party ? resolveKey(party.key) : '';
    const ownerName = party?.display || parcel.owner_name || 'No owner';
    const group = groups.get(ownerKey) || {
      ownerKey,
      ownerName,
      publicOwner: party ? party.publicOwner : isPublicOwner(ownerName),
      parcels: [],
    };
    group.parcels.push(parcel);
    groups.set(ownerKey, group);
  }
  const features = [];
  for (const group of groups.values()) {
    const geometry = dissolveGeometries(group.parcels.map((parcel) => parcel.geometry));
    if (!geometry) continue;
    let acres = 0;
    let value = 0;
    let valued = false;
    const parcelnos = [];
    for (const parcel of group.parcels) {
      parcelnos.push(parcel.parcelno);
      acres += Number(parcel.acres) > 0 ? Number(parcel.acres) : 0;
      if (Number(parcel.total_value) > 0) {
        value += Number(parcel.total_value);
        valued = true;
      }
    }
    features.push({
      type: 'Feature',
      geometry,
      bbox: featureBBox(geometry),
      properties: {
        ownerKey: group.ownerKey,
        ownerName: group.ownerName,
        publicOwner: group.publicOwner,
        parcelCount: group.parcels.length,
        parcelnos,
        acres,
        value: valued ? value : null,
      },
    });
  }
  return features;
}

function median(numbers) {
  const sorted = numbers.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function shorelinePremium(parcels) {
  const water = [];
  const inland = [];
  const byZone = new Map();
  for (const parcel of parcels || []) {
    const rate = perAcre(parcel.total_value, parcel.acres);
    if (rate == null) continue;
    const shore = Number(parcel.waterfront) > 0;
    if (shore) water.push(rate);
    else inland.push(rate);
    const zoning = String(parcel.zoning || '').trim();
    if (!zoning) continue;
    const bucket = byZone.get(zoning) || { water: [], inland: [] };
    bucket[shore ? 'water' : 'inland'].push(rate);
    byZone.set(zoning, bucket);
  }
  const zones = [];
  for (const [zoning, bucket] of byZone) {
    if (bucket.water.length < 3 || bucket.inland.length < 3) continue;
    const waterfrontRate = median(bucket.water);
    const inlandRate = median(bucket.inland);
    if (waterfrontRate == null || inlandRate == null || inlandRate <= 0) continue;
    zones.push({
      zoning,
      waterfrontRate,
      inlandRate,
      premium: waterfrontRate / inlandRate,
      waterfrontCount: bucket.water.length,
      inlandCount: bucket.inland.length,
    });
  }
  zones.sort((a, b) => b.premium - a.premium || a.zoning.localeCompare(b.zoning));
  const waterfrontRate = water.length >= 3 ? median(water) : null;
  const inlandRate = inland.length >= 3 ? median(inland) : null;
  const overall = waterfrontRate != null && inlandRate
    ? {
      waterfrontRate,
      inlandRate,
      premium: waterfrontRate / inlandRate,
      waterfrontCount: water.length,
      inlandCount: inland.length,
    }
    : null;
  return { overall, zones };
}

export function placeCoordinate(city, state) {
  const name = placeKey(city);
  const region = placeKey(state);
  if (!name) return null;
  if (region && PLACES[`${name}|${region}`]) {
    const [lon, lat] = PLACES[`${name}|${region}`];
    return { lon, lat };
  }
  const matches = Object.entries(PLACES).filter(([key]) => key.startsWith(`${name}|`));
  if (matches.length !== 1) return null;
  const [lon, lat] = matches[0][1];
  return { lon, lat };
}

export function mailFlows(parcels) {
  const groups = new Map();
  for (const parcel of parcels || []) {
    const city = String(parcel.mailing_city || '').trim();
    if (!city) continue;
    const state = String(parcel.mailing_state || '').trim();
    const key = `${placeKey(city)}|${placeKey(state)}`;
    const group = groups.get(key) || {
      city,
      state: state.toUpperCase(),
      count: 0,
      away: 0,
      acres: 0,
      lon: 0,
      lat: 0,
      located: 0,
    };
    group.count += 1;
    group.acres += Number(parcel.acres) > 0 ? Number(parcel.acres) : 0;
    if (placesDiffer(city, parcel.loc_city || parcel.locCity)) group.away += 1;
    if (parcel.lon != null && parcel.lat != null) {
      group.lon += Number(parcel.lon);
      group.lat += Number(parcel.lat);
      group.located += 1;
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const from = group.located
      ? { lon: group.lon / group.located, lat: group.lat / group.located }
      : null;
    const to = placeCoordinate(group.city, group.state);
    const km = from && to ? distanceKm(from, to) : null;
    return {
      city: group.city,
      state: group.state,
      count: group.count,
      away: group.away,
      acres: group.acres,
      from,
      to: km != null && km >= 40 ? to : null,
    };
  }).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
}

export function arcLine(from, to, steps = 28) {
  if (!from || !to) return [];
  const dx = to.lon - from.lon;
  const dy = to.lat - from.lat;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(len * 0.22, 8);
  const cx = (from.lon + to.lon) / 2 - (dy / len) * bend;
  const cy = (from.lat + to.lat) / 2 + (dx / len) * bend;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    points.push([
      u * u * from.lat + 2 * u * t * cy + t * t * to.lat,
      u * u * from.lon + 2 * u * t * cx + t * t * to.lon,
    ]);
  }
  return points;
}

const STREET_WORDS = new Map(Object.entries(STREET_SUFFIX));

export function parseStreet(location) {
  let text = String(location || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  const numberMatch = text.match(/\b\d+[a-z]?\b/);
  const number = numberMatch ? Number.parseInt(numberMatch[0], 10) : null;
  text = text.replace(/\b\d+[a-z]?\b/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = text.split(' ').filter(Boolean).map((part) => STREET_WORDS.get(part) || part);
  return { number: Number.isFinite(number) ? number : null, street: parts.join(' ') };
}

function field(parcel, snake, camel) {
  return parcel?.[snake] ?? parcel?.[camel];
}

export function streetBlock(subject, parcels, limit = 9) {
  const parsed = parseStreet(subject?.location);
  if (!parsed.street) return [];
  const town = placeKey(field(subject, 'loc_city', 'locCity'));
  const rows = [];
  for (const parcel of parcels || []) {
    const other = parseStreet(parcel.location);
    if (other.street !== parsed.street) continue;
    if (town && placeKey(field(parcel, 'loc_city', 'locCity')) !== town) continue;
    rows.push({
      parcelno: parcel.parcelno,
      location: parcel.location || '',
      ownerName: field(parcel, 'owner_name', 'ownerName') || '',
      number: other.number,
      acres: parcel.acres,
      totalValue: field(parcel, 'total_value', 'totalValue'),
      current: parcel.parcelno === subject.parcelno,
    });
  }
  rows.sort((a, b) => {
    if (a.number == null && b.number == null) return String(a.parcelno).localeCompare(String(b.parcelno));
    if (a.number == null) return 1;
    if (b.number == null) return -1;
    return a.number - b.number || String(a.parcelno).localeCompare(String(b.parcelno));
  });
  if (rows.length <= limit) return rows;
  const index = Math.max(0, rows.findIndex((row) => row.current));
  const start = Math.max(0, Math.min(index - Math.floor(limit / 2), rows.length - limit));
  return rows.slice(start, start + limit);
}

function mailingLabel(parcel) {
  const city = String(parcel.mailing_city || '').trim();
  const state = String(parcel.mailing_state || '').trim();
  const zip = String(parcel.mailing_zip || '').trim();
  let street = String(parcel.mailing_address || '').trim();
  if (city && street.toLowerCase().includes(city.toLowerCase())) street = street.split(',')[0].trim();
  const region = [state, zip].filter(Boolean).join(' ');
  return [street, city, region].filter(Boolean).join(', ');
}

export function sharedMailboxes(parcels, resolveKey = (key) => key) {
  const groups = new Map();
  for (const parcel of parcels || []) {
    const street = placeKey(parcel.mailing_address);
    const city = placeKey(parcel.mailing_city);
    if (!street || street.length < 4 || !city) continue;
    const key = [street, city, placeKey(parcel.mailing_state), placeKey(parcel.mailing_zip)].join('|');
    const group = groups.get(key) || { label: mailingLabel(parcel), owners: new Map(), parcelnos: [] };
    group.parcelnos.push(parcel.parcelno);
    for (const party of parties(parcel.owner_name, parcel.owner_2, parcel.shares)) {
      const keyName = resolveKey(party.key);
      const slot = group.owners.get(keyName) || { key: keyName, name: party.display, parcels: 0 };
      slot.parcels += 1;
      group.owners.set(keyName, slot);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      label: group.label,
      parcelnos: group.parcelnos,
      owners: [...group.owners.values()].sort((a, b) => b.parcels - a.parcels || a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.owners.length >= 2)
    .sort((a, b) => b.owners.length - a.owners.length || b.parcelnos.length - a.parcelnos.length);
}
