const EARTH_M_PER_DEG_LAT = 110540;

export function geometryAcres(geometry) {
  const squareMeters = geometryArea(geometry);
  if (!squareMeters) return null;
  return squareMeters / 4046.8564224;
}

export function geometryCentroid(geometry) {
  const ring = outerRing(geometry);
  if (!ring?.length) return null;
  let lon = 0;
  let lat = 0;
  const count = ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length;
  for (let i = 0; i < count; i += 1) {
    lon += ring[i][0];
    lat += ring[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

export function distanceKm(a, b) {
  if (a?.lat == null || b?.lat == null || a?.lon == null || b?.lon == null) return null;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function isPublicOwner(name) {
  return /^(city|state|borough|county|united states|u\.?s\.?a?\.?|ketchikan gateway|school district|university)\b/i.test(String(name || '').trim());
}

export function perAcre(value, acres) {
  const amount = Number(value);
  const size = Number(acres);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(size) || size <= 0) return null;
  return amount / size;
}

export function saleYearOf(record) {
  const match = String(record?.sale_year ?? record?.saleYear ?? '').match(/\b(?:18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

export function recentSale(record, nowYear = new Date().getFullYear()) {
  const year = saleYearOf(record);
  if (year == null) return true;
  return year >= nowYear - 5;
}

export function resolveOwnerKey(key, links = {}) {
  const seen = new Set();
  let current = key;
  while (current && links?.[current] && !seen.has(current)) {
    seen.add(current);
    const next = links[current];
    if (!next || next === current) break;
    current = next;
  }
  return current || key;
}

export const OWNER_COLORS = [
  '#c46b3a', '#1f6f62', '#3d5a80', '#8c3a4a', '#6b4c7a', '#3f6f4a',
  '#a15c38', '#4c6b8a', '#7a5c3a', '#5c4a6b', '#8a6230', '#2f5d50',
];

export function ownerKey(name) {
  let text = String(name || '').toUpperCase().replace(/\./g, ' ');
  text = text.replace(/[^A-Z0-9,\s]/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/\b(JR|SR|II|III|IV)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = text.includes(',')
    ? `${text.split(',').slice(1).join(' ')} ${text.split(',')[0]}`.split(/\s+/)
    : text.split(/\s+/);
  const cleaned = tokens.filter(Boolean);
  const long = cleaned.filter((token) => token.length > 1);
  const used = long.length >= 2 ? long : cleaned;
  return used.sort().join(' ');
}

export function parties(ownerName, owner2, shares = null) {
  const seen = new Map();
  for (const raw of [ownerName, owner2]) {
    if (raw == null || !String(raw).trim()) continue;
    for (const part of String(raw).split(/\s+(?:&|and)\s+|\/|;/i)) {
      const display = part.replace(/\s+/g, ' ').trim().replace(/^[,\s]+|[,\s]+$/g, '');
      const key = ownerKey(display);
      if (!key || key === 'NONE' || key === 'UNKNOWN' || key === 'ET AL') continue;
      if (!seen.has(key)) seen.set(key, display);
    }
  }
  const list = [...seen.entries()].map(([key, display]) => ({ key, display }));
  const custom = shares && typeof shares === 'object' ? shares : null;
  const numbered = list.map((party) => ({ ...party, share: custom ? Number(custom[party.key]) : NaN }));
  const sum = numbered.reduce((total, party) => total + (Number.isFinite(party.share) ? party.share : 0), 0);
  const useCustom = custom && numbered.every((party) => Number.isFinite(party.share) && party.share >= 0) && Math.abs(sum - 1) < 0.02;
  const even = list.length ? 1 / list.length : 0;
  return (useCustom ? numbered : list.map((party) => ({ ...party, share: even })))
    .map((party) => ({ ...party, publicOwner: isPublicOwner(party.display) }));
}

export function ownershipChanges(before, after) {
  const index = (list) => {
    const byOwner = new Map();
    for (const parcel of list || []) {
      for (const party of parties(parcel.owner_name, parcel.owner_2, parcel.shares)) {
        const row = byOwner.get(party.key) || { name: party.display, parcels: new Set() };
        row.parcels.add(parcel.parcelno);
        if (party.display.length > row.name.length) row.name = party.display;
        byOwner.set(party.key, row);
      }
    }
    return byOwner;
  };
  const previous = index(before);
  const next = index(after);
  const gained = [];
  const lost = [];
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    const prior = previous.get(key);
    const current = next.get(key);
    const priorParcels = prior?.parcels || new Set();
    const nextParcels = current?.parcels || new Set();
    const gainedParcels = [...nextParcels].filter((parcelno) => !priorParcels.has(parcelno));
    const lostParcels = [...priorParcels].filter((parcelno) => !nextParcels.has(parcelno));
    const name = current?.name || prior?.name;
    if (gainedParcels.length) gained.push({ name, count: gainedParcels.length });
    if (lostParcels.length) lost.push({ name, count: lostParcels.length });
  }
  const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
  return { gained: gained.sort(byCount).slice(0, 8), lost: lost.sort(byCount).slice(0, 8) };
}

export function summarizeOwners(holdings, parcels) {
  const totalAcres = parcels.reduce((sum, parcel) => sum + (Number(parcel.acres) || 0), 0);
  const totalValue = parcels.reduce((sum, parcel) => sum + (Number(parcel.total_value) || 0), 0);
  const parcelCount = parcels.length;
  const byOwner = new Map();
  for (const row of holdings) {
    const current = byOwner.get(row.owner_key) || {
      ownerKey: row.owner_key,
      name: row.display_name,
      publicOwner: !!row.public_owner,
      parcelShares: 0,
      acres: 0,
      value: 0,
      parcels: [],
    };
    current.parcelShares += Number(row.share) || 0;
    current.acres += (Number(row.acres) || 0) * (Number(row.share) || 0);
    current.value += (Number(row.value) || 0) * (Number(row.share) || 0);
    current.parcels.push(row.parcelno);
    if (row.canonical) {
      current.name = row.display_name;
      current.canonical = true;
    } else if (!current.canonical && String(row.display_name).length > current.name.length) {
      current.name = row.display_name;
    }
    byOwner.set(row.owner_key, current);
  }
  return [...byOwner.values()].map((owner) => ({
    ...owner,
    parcelCount: owner.parcels.length,
    acreShare: totalAcres ? owner.acres / totalAcres : 0,
    valueShare: totalValue ? owner.value / totalValue : 0,
    countShare: parcelCount ? owner.parcelShares / parcelCount : 0,
  })).sort((a, b) => b.acres - a.acres || b.parcelShares - a.parcelShares || a.name.localeCompare(b.name));
}

export function scoreComp(subject, other) {
  if (!other || other.parcelno === subject.parcelno) return null;
  const acresA = Number(subject.acres) || 0;
  const acresB = Number(other.acres) || 0;
  const acreScore = acresA > 0 && acresB > 0 ? Math.min(acresA, acresB) / Math.max(acresA, acresB) : 0.35;
  const saleA = Number(subject.sale_price) || 0;
  const saleB = Number(other.sale_price) || 0;
  const comparedSale = saleA > 0 && saleB > 0 && recentSale(subject) && recentSale(other);
  const valueA = comparedSale ? saleA : (Number(subject.total_value) || 0);
  const valueB = comparedSale ? saleB : (Number(other.total_value) || 0);
  const valueScore = valueA > 0 && valueB > 0 ? Math.min(valueA, valueB) / Math.max(valueA, valueB) : 0.25;
  const rateA = perAcre(valueA, subject.acres);
  const rateB = perAcre(valueB, other.acres);
  const rateScore = rateA && rateB ? Math.min(rateA, rateB) / Math.max(rateA, rateB) : 0;
  const sameZone = subject.zoning && other.zoning && String(subject.zoning).toUpperCase() === String(other.zoning).toUpperCase() ? 1 : 0;
  const sameSub = subject.subdivision && other.subdivision && String(subject.subdivision).toUpperCase() === String(other.subdivision).toUpperCase() ? 1 : 0;
  const distance = distanceKm(subject, other);
  const distanceScore = distance == null ? 0.4 : Math.max(0, 1 - distance / 8);
  const score = acreScore * 40 + valueScore * 20 + sameZone * 20 + sameSub * 10 + distanceScore * 10;
  return {
    parcelno: other.parcelno,
    score: Math.round(score * 10) / 10,
    distanceKm: distance == null ? null : Math.round(distance * 100) / 100,
    sameZone: !!sameZone,
    sameSubdivision: !!sameSub,
    acres: other.acres,
    totalValue: other.total_value,
    salePrice: other.sale_price || null,
    comparedSale,
    zoning: other.zoning,
    ownerName: other.owner_name,
    location: other.location,
    mailingCity: other.mailing_city,
    subdivision: other.subdivision,
    reasons: compReasons({ acreScore, valueScore, rateScore, sameZone, sameSub, distance, comparedSale }),
    assessedPerAcre: perAcre(other.total_value, other.acres),
    salePerAcre: perAcre(other.sale_price, other.acres),
  };
}

export function rankComps(subject, parcels, limit = 8) {
  return parcels
    .map((parcel) => {
      const scored = scoreComp(subject, parcel);
      return scored ? { ...parcel, comp: scored } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.comp.score - a.comp.score)
    .slice(0, limit);
}

function compReasons({ acreScore, valueScore, rateScore, sameZone, sameSub, distance, comparedSale }) {
  const reasons = [];
  if (acreScore >= 0.7) reasons.push('similar size');
  if (valueScore >= 0.7) reasons.push(comparedSale ? 'similar sale price' : 'similar assessed value');
  if (rateScore >= 0.7) reasons.push(comparedSale ? 'similar sale price per acre' : 'similar assessed value per acre');
  if (sameZone) reasons.push('same zoning');
  if (sameSub) reasons.push('same subdivision');
  if (distance != null && distance < 1) reasons.push('within 1 km');
  else if (distance != null && distance < 4) reasons.push('nearby');
  return reasons;
}

function geometryArea(geometry) {
  if (!geometry) return 0;
  if (geometry.type === 'Polygon') return polygonArea(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  return 0;
}

function polygonArea(rings) {
  if (!rings?.length) return 0;
  const outer = Math.abs(ringArea(rings[0]));
  const holes = rings.slice(1).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
  return Math.max(0, outer - holes);
}

function ringArea(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const mx = 111320 * Math.cos(lat * Math.PI / 180);
  const my = EARTH_M_PER_DEG_LAT;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * mx * ring[i + 1][1] * my - ring[i + 1][0] * mx * ring[i][1] * my;
  }
  return sum / 2;
}

function outerRing(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return geometry.coordinates?.[0] || null;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates?.[0]?.[0] || null;
  if (geometry.type === 'Point') return [geometry.coordinates];
  return null;
}

function samePoint(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}
