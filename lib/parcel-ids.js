// Canonical parcel ids for the Ketchikan owner export. See docs/FIELD_MAP.md.
// Parcel_Num is unique per unit; PARCELNO is shared by every unit of a condo
// or mobile-home park, so it is only the fallback when Parcel_Num is blank.

function lookup(properties) {
  const map = new Map();
  for (const [key, value] of Object.entries(properties || {})) {
    map.set(String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''), value);
  }
  return map;
}

function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

// FNV-1a, 32-bit. Stable in the browser and in Node without crypto.
export function shortHash(value) {
  const input = String(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function isPlaceholderId(value) {
  const id = text(value);
  return !id || !/\d/.test(id);
}

export function baseParcelId(properties) {
  const fields = lookup(properties);
  const parcelNum = text(fields.get('parcel_num'));
  if (parcelNum) return parcelNum;
  const parcelNo = text(fields.get('parcelno') ?? fields.get('parcel_no') ?? fields.get('apn') ?? fields.get('parcel_number'));
  return parcelNo;
}

function contentKey(record) {
  return JSON.stringify([record?.properties || {}, record?.geometry || null]);
}

function shapeKey(record) {
  return record?.geometry ? JSON.stringify(record.geometry) : JSON.stringify(record?.properties || {});
}

/**
 * Gives every record a parcelId and drops rows that repeat an earlier row exactly.
 * Placeholder numbers (`<NA>`, `STATE DOT`, blank) get a suffix from the shape.
 * A second, different row under the same number gets a suffix from its shape;
 * the first row in file order keeps the bare number.
 */
export function assignParcelIds(records) {
  const used = new Set();
  const seenContent = new Map();
  const out = [];
  let duplicatesDropped = 0;
  (records || []).forEach((record, index) => {
    const base = baseParcelId(record?.properties);
    const content = contentKey(record);
    const contentId = `${base}\u0000${content}`;
    if (seenContent.has(contentId)) {
      duplicatesDropped += 1;
      return;
    }
    let id;
    if (isPlaceholderId(base)) {
      id = `${base || 'NO NUMBER'}~${shortHash(shapeKey(record))}`;
    } else if (used.has(base)) {
      id = `${base}~${shortHash(shapeKey(record))}`;
    } else {
      id = base;
    }
    let candidate = id;
    for (let n = 2; used.has(candidate); n += 1) candidate = `${id}-${n}`;
    if (!candidate) candidate = `row-${index + 1}`;
    used.add(candidate);
    seenContent.set(contentId, candidate);
    out.push({ ...record, parcelId: candidate });
  });
  return { records: out, duplicatesDropped };
}
