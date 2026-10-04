// Plans one import against what the server already holds. Pure, so it can be tested
// without a database. Rules: upsert by parcelId, never delete, mark owner changes
// and parcels that are absent from the file.

/**
 * @param {Array<{parcelId: string, ownerSignature: string|null, ownerName: string|null, missingSince: any}>} existing
 * @param {Array<{parcelId: string, ownerSignature: string|null, ownerName: string|null}>} incoming canonical rows
 */
export function planImport(existing, incoming) {
  const before = new Map((existing || []).map((row) => [row.parcelId, row]));
  const seen = new Set();
  const rows = [];
  const summary = {
    parcels: 0,
    added: 0,
    updated: 0,
    ownerChanged: 0,
    missing: 0,
    returned: 0,
    duplicatesDropped: 0,
  };
  for (const row of incoming || []) {
    if (!row?.parcelId || seen.has(row.parcelId)) {
      summary.duplicatesDropped += 1;
      continue;
    }
    seen.add(row.parcelId);
    const old = before.get(row.parcelId);
    if (!old) {
      summary.added += 1;
      rows.push({ ...row, isNew: true, ownerChanged: false, previousOwnerName: null, returned: false });
      continue;
    }
    summary.updated += 1;
    const ownerChanged = (old.ownerSignature || '') !== (row.ownerSignature || '');
    if (ownerChanged) summary.ownerChanged += 1;
    const returned = old.missingSince != null;
    if (returned) summary.returned += 1;
    rows.push({
      ...row,
      isNew: false,
      ownerChanged,
      previousOwnerName: ownerChanged ? (old.ownerName || null) : null,
      returned,
    });
  }
  const missingIds = [];
  let alreadyMissing = 0;
  for (const [parcelId, old] of before) {
    if (seen.has(parcelId)) continue;
    if (old.missingSince == null) missingIds.push(parcelId);
    else alreadyMissing += 1;
  }
  summary.parcels = rows.length;
  summary.missing = missingIds.length;
  summary.stillMissing = alreadyMissing;
  return { rows, missingIds, summary };
}

export function describeImport(summary) {
  const parts = [`${summary.parcels.toLocaleString('en-US')} parcels`];
  if (summary.added) parts.push(`${summary.added.toLocaleString('en-US')} new`);
  if (summary.ownerChanged) parts.push(`${summary.ownerChanged.toLocaleString('en-US')} owner changed`);
  if (summary.missing) parts.push(`${summary.missing.toLocaleString('en-US')} missing from this file`);
  if (summary.returned) parts.push(`${summary.returned.toLocaleString('en-US')} back in the file`);
  return `Imported ${parts.join(', ')}.`;
}
