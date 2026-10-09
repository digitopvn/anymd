import type { Enrichment } from '../convert/enrichment-types';

/** A plain or partial read must never erase a previously complete section. */
export function mergeEnrichment(previous: Enrichment = {}, incoming: Enrichment = {}): Enrichment {
  const merged: Enrichment = { ...previous };
  for (const key of ['thread', 'comments', 'images'] as const) {
    const next = incoming[key];
    const old = previous[key];
    if (!next) continue;
    if (old?.complete && !next.complete) continue;
    if (old && !next.complete && old.count > next.count) continue;
    Object.assign(merged, { [key]: next });
  }
  return merged;
}
