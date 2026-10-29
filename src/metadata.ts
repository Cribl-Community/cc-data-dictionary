import type { DataPath, UntaggedDataPath } from './types';

const getApiUrl = () => window.CRIBL_API_URL || 'http://localhost:9000/api/v1';

export interface DataPathMetadata {
  owner?: string;
  criticality?: 'low' | 'medium' | 'high' | 'critical';
  notes?: string;
  dataSourceLabel?: string;
}

export type MetadataStore = Record<string, DataPathMetadata>;

const KV_PATH = '/kvstore/data-dictionary/metadata';

export function getPathKey(groupId: string, sourceId: string, routeId: string, destId: string): string {
  return `${groupId}::${sourceId}::${routeId}::${destId}`;
}

// Keys written before the dictionary could span worker groups. Source, route and
// destination ids are only unique WITHIN a group, so these could collide between
// two groups that name their entities the same way — which is why keys are now
// group-scoped. Kept so existing annotations survive the change.
export function legacyPathKey(sourceId: string, routeId: string, destId: string): string {
  return `${sourceId}::${routeId}::${destId}`;
}

// Identity of a data path, stable across regrouping and reloads. Source-specific
// routes key on the source id; content/catch-all routes have no source, so they
// key on the displayed source slot. QuickConnect paths have no route, so they
// key on a stable "qc" marker.
function pathIdentity(path: DataPath | UntaggedDataPath): { sourceId: string; routeId: string; destId: string } {
  return {
    sourceId: path.source?.id ?? path.sourceDisplay,
    routeId: path.route?.id ?? `qc:${path.kind}`,
    destId: path.destination.id,
  };
}

export function pathKeyOf(path: DataPath): string {
  const { sourceId, routeId, destId } = pathIdentity(path);
  return getPathKey(path.groupId, sourceId, routeId, destId);
}

function legacyKeyOf(path: DataPath): string {
  const { sourceId, routeId, destId } = pathIdentity(path);
  return legacyPathKey(sourceId, routeId, destId);
}

// Read a path's metadata, falling back to its pre-group-scoping key so
// annotations written by earlier versions still show up.
export function metaFor(store: MetadataStore, path: DataPath): DataPathMetadata {
  return store[pathKeyOf(path)] ?? store[legacyKeyOf(path)] ?? {};
}

/**
 * Apply an edit to the store, returning a new one. Always writes under the
 * path's group-scoped key.
 *
 * A legacy key is ambiguous — it was written when the app only ever showed one
 * group at a time, so there's no way to know which group it belonged to, and
 * identically-named paths in two groups both read it. So a normal save LEAVES it
 * in place: deleting it would silently strip the annotation from a sibling path
 * in another group that's still reading it. The new key wins on read either way.
 *
 * Clearing every field is different — that's an explicit "remove this
 * annotation", so the legacy entry goes too. Otherwise the fallback would keep
 * serving it and the clear would appear to do nothing.
 */
export function applyMetadataEdit(
  store: MetadataStore,
  path: DataPath,
  meta: DataPathMetadata,
): MetadataStore {
  const next = { ...store };
  const key = pathKeyOf(path);

  if (!meta.owner && !meta.criticality && !meta.notes && !meta.dataSourceLabel) {
    delete next[key];
    delete next[legacyKeyOf(path)];
  } else {
    next[key] = meta;
  }
  return next;
}

// The KV store keeps the value as an opaque string. Read it as text and parse it
// ourselves: a JSON content type lets the server coerce the body, which stores
// "[object Object]" and makes res.json() throw.
function parseStored(text: string): MetadataStore {
  let value: unknown = JSON.parse(text);
  if (typeof value === 'string') value = JSON.parse(value); // double-encoded
  return value && typeof value === 'object' ? (value as MetadataStore) : {};
}

export async function loadMetadata(): Promise<MetadataStore> {
  try {
    const res = await fetch(`${getApiUrl()}${KV_PATH}`);
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`Failed to load metadata: ${res.status}`);
    return parseStored(await res.text());
  } catch (e) {
    console.error('Could not load data dictionary metadata', e);
    return {};
  }
}

export async function saveMetadata(store: MetadataStore): Promise<void> {
  const res = await fetch(`${getApiUrl()}${KV_PATH}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(store),
  });
  if (!res.ok) throw new Error(`Failed to save metadata: ${res.status}`);
}
