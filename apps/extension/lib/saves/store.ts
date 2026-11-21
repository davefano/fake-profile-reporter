// Saves kept in this browser: everything Track or Report saved, whatever the
// destination, with what's needed to upload it to a server later. Export and
// Import move them between browsers as one JSON file.

import type { RiskLevel } from '@flr/core/scam';
import type { EntityRequest } from '@flr/core/wire';

type EntityPayload = EntityRequest extends infer R ? (R extends unknown ? Omit<R, 'report'> : never) : never;
/** What a server needs: a profile's raw snapshot (it re-parses it), or a company or job's facts. */
export type SavedPayload = { kind: 'profile'; snapshotGzipBase64: string } | EntityPayload;

export interface SavedItem {
  /** scanKey(), e.g. "profile:some-slug". */
  key: string;
  kind: 'profile' | 'company' | 'job';
  url: string;
  name: string;
  /** Headline, industry, or the job's company. */
  detail: string | null;
  score: number;
  level: RiskLevel;
  savedAt: number;
  reportedAt: number | null;
  /** Servers this version of the item has been sent to. */
  uploadedTo: string[];
  payload: SavedPayload;
}

/** The subset of a storage area the store uses (lets tests pass a fake). */
export interface Area {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const INDEX = 'saves:index';
const itemKey = (key: string) => `save:${key}`;

export function saveStore(area: Area) {
  const index = async () => ((await area.get(INDEX))[INDEX] as string[] | undefined) ?? [];
  const get = async (key: string) => (await area.get(itemKey(key)))[itemKey(key)] as SavedItem | undefined;
  const put = async (item: SavedItem) => {
    const keys = await index();
    await area.set({ [itemKey(item.key)]: item, [INDEX]: keys.includes(item.key) ? keys : [item.key, ...keys] });
  };
  return {
    get,
    put,
    /** Newest first. */
    async list(): Promise<SavedItem[]> {
      const keys = await index();
      if (!keys.length) return [];
      const got = await area.get(keys.map(itemKey));
      return keys
        .map((k) => got[itemKey(k)] as SavedItem | undefined)
        .filter((x): x is SavedItem => !!x)
        .sort((a, b) => b.savedAt - a.savedAt);
    },
    async markUploaded(key: string, server: string) {
      const item = await get(key);
      if (item && !item.uploadedTo.includes(server)) await put({ ...item, uploadedTo: [...item.uploadedTo, server] });
    },
    /** Add imported items; for items already here, keep the newer save. */
    async merge(items: SavedItem[]): Promise<{ added: number; updated: number }> {
      let added = 0;
      let updated = 0;
      for (const incoming of items) {
        const have = await get(incoming.key);
        const next = mergeItem(have, incoming);
        if (next === have) continue;
        await put(next);
        if (have) updated++;
        else added++;
      }
      return { added, updated };
    },
  };
}

export const localSaves = () => saveStore(browser.storage.local);

/** The newer save wins; a report on either side is kept. Returns `have` when nothing changes. */
export function mergeItem(have: SavedItem | undefined, incoming: SavedItem): SavedItem {
  if (!have) return incoming;
  const [newer, older] = incoming.savedAt > have.savedAt ? [incoming, have] : [have, incoming];
  const reportedAt = newer.reportedAt ?? older.reportedAt;
  const uploadedTo = newer.savedAt === older.savedAt ? [...new Set([...newer.uploadedTo, ...older.uploadedTo])] : newer.uploadedTo;
  const next = { ...newer, reportedAt, uploadedTo };
  return JSON.stringify(next) === JSON.stringify(have) ? have : next;
}

/** Saves not yet sent to `server`. */
export const pendingFor = (items: SavedItem[], server: string) => items.filter((i) => !i.uploadedTo.includes(server));

// --- Export / Import -----------------------------------------------------------

const FORMAT = 'fake-linkedin-reporter/saves';

export function exportFile(items: SavedItem[], now = Date.now()) {
  return JSON.stringify({ format: FORMAT, version: 1, exportedAt: now, items }, null, 1);
}

/** Read an export. Throws with a message for the user when it isn't one; skips items that don't look right. */
export function parseExport(text: string): { items: SavedItem[]; skipped: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  const file = data as { format?: unknown; version?: unknown; items?: unknown };
  if (!file || file.format !== FORMAT || !Array.isArray(file.items)) throw new Error("That file isn't a Fake LinkedIn Reporter export.");
  if (file.version !== 1) throw new Error('That export is from a newer version of the extension.');
  const items = file.items.filter(isSavedItem);
  return { items, skipped: file.items.length - items.length };
}

const KINDS = ['profile', 'company', 'job'];
const LEVELS = ['low', 'medium', 'high'];
const LINKEDIN_URL = /^https:\/\/([a-z]{2,3}\.|www\.)?linkedin\.com\//;
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
const strOrNull = (x: unknown) => x === null || typeof x === 'string';

function isSavedItem(x: unknown): x is SavedItem {
  const i = x as Partial<SavedItem> | null;
  if (!i || typeof i !== 'object') return false;
  const p = i.payload as Record<string, unknown> | undefined;
  return (
    typeof i.kind === 'string' &&
    KINDS.includes(i.kind) &&
    typeof i.key === 'string' &&
    i.key.startsWith(`${i.kind}:`) &&
    typeof i.url === 'string' &&
    LINKEDIN_URL.test(i.url) &&
    typeof i.name === 'string' &&
    strOrNull(i.detail) &&
    num(i.score) &&
    typeof i.level === 'string' &&
    LEVELS.includes(i.level) &&
    num(i.savedAt) &&
    (i.reportedAt === null || num(i.reportedAt)) &&
    Array.isArray(i.uploadedTo) &&
    i.uploadedTo.every((s) => typeof s === 'string') &&
    !!p &&
    typeof p === 'object' &&
    p.kind === i.kind &&
    (i.kind === 'profile' ? typeof p.snapshotGzipBase64 === 'string' : typeof p.id === 'string' && !!p.facts && typeof p.facts === 'object')
  );
}
