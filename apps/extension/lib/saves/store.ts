// Saves kept in this browser: everything Track or Report saved, whatever the
// destination, with what's needed to upload it to a server later. Export and
// Import move them between browsers as one JSON file.

import { NOTE_MAX, reasonsFor, stancesFor, type ReportConfidence, type ReportStance, type RiskLevel } from '@fpr/core/scam';
import type { EntityRequest } from '@fpr/core/wire';

/** What a server needs: a profile's raw snapshot (it re-parses it), or a company or job's facts. */
export type SavedPayload = { kind: 'profile'; snapshotGzipBase64: string } | EntityRequest;

/** What you said about it: a report, a vouch, or that someone used this identity. */
export interface LocalReport {
  stance: ReportStance;
  reasons: string[];
  confidence: ReportConfidence | null;
  /** Private: sent to the server, which stores it and never shows it. */
  note: string | null;
  /** When this version was written; it names the version (see SavedItem.heldBy). */
  at: number;
}

export interface SavedItem {
  /** scanKey(), e.g. "profile:some-slug". */
  key: string;
  kind: 'profile' | 'company' | 'job';
  /** The server's ID for it: member ID for profiles, LinkedIn ID for companies and jobs. Null until known. */
  targetId: string | null;
  url: string;
  name: string;
  /** Headline, industry, or the job's company. */
  detail: string | null;
  score: number;
  level: RiskLevel;
  savedAt: number;
  report: LocalReport | null;
  /** When the report was withdrawn. With `report` null, the item is a tombstone servers in `heldBy` still need. */
  withdrawnAt: number | null;
  /**
   * Every server that may hold any version of the report, with the version
   * (`LocalReport.at`) it is known to hold, or null when that isn't confirmed.
   * A server joins before the request is sent and leaves only after a DELETE
   * succeeds.
   */
  heldBy: Record<string, number | null>;
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
  const get = async (key: string) => normalize((await area.get(itemKey(key)))[itemKey(key)]);
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
        .map((k) => normalize(got[itemKey(k)]))
        .filter((x): x is SavedItem => !!x)
        .sort((a, b) => b.savedAt - a.savedAt);
    },
    /** Rewrite one item; `fn` returning the same object writes nothing. Run under upload.ts's serial() to avoid lost updates. */
    async update(key: string, fn: (item: SavedItem) => SavedItem): Promise<SavedItem | undefined> {
      const item = await get(key);
      if (!item) return undefined;
      const next = fn(item);
      if (next !== item) await put(next);
      return next;
    },
    /** Record that `server` has this version, and the target ID it gave, in one write; the item after. */
    async markUploaded(key: string, server: string, targetId?: string | null): Promise<SavedItem | undefined> {
      const item = await get(key);
      if (!item) return undefined;
      const uploaded = item.uploadedTo.includes(server);
      const newId = targetId && targetId !== item.targetId;
      if (uploaded && !newId) return item;
      const next = { ...item, uploadedTo: uploaded ? item.uploadedTo : [...item.uploadedTo, server], targetId: newId ? targetId : item.targetId };
      await put(next);
      return next;
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

/** The version of what you said: the report's time, or the withdrawal's; null if you never said anything. */
export const intentAt = (i: Pick<SavedItem, 'report' | 'withdrawnAt'>) => i.report?.at ?? i.withdrawnAt ?? null;

/** True when `server` doesn't match what you last said: it lacks this report, or still holds a withdrawn one. */
export function needsSync(i: SavedItem, server: string) {
  if (i.report) return i.heldBy[server] !== i.report.at;
  return server in i.heldBy;
}

/**
 * The newer save wins; the newer of the two reports or withdrawals wins, so a
 * newer withdrawal beats an older report. `heldBy` is the union (either
 * browser may have sent it), confirmed only where it matches the winner.
 */
export function mergeItem(have: SavedItem | undefined, incoming: SavedItem): SavedItem {
  if (!have) return incoming;
  const [newer, older] = incoming.savedAt > have.savedAt ? [incoming, have] : [have, incoming];
  const said = (intentAt(incoming) ?? -1) > (intentAt(have) ?? -1) ? incoming : have;
  const at = intentAt(said);
  const heldBy: Record<string, number | null> = {};
  for (const s of new Set([...Object.keys(have.heldBy), ...Object.keys(incoming.heldBy)])) {
    heldBy[s] = at !== null && (have.heldBy[s] === at || incoming.heldBy[s] === at) ? at : null;
  }
  const uploadedTo = newer.savedAt === older.savedAt ? [...new Set([...newer.uploadedTo, ...older.uploadedTo])] : newer.uploadedTo;
  const next: SavedItem = { ...newer, targetId: newer.targetId ?? older.targetId, report: said.report, withdrawnAt: said.report ? null : said.withdrawnAt, heldBy, uploadedTo };
  return JSON.stringify(next) === JSON.stringify(have) ? have : next;
}

/**
 * A profile URL can pass to another member (a vanity URL given up and taken).
 * When the save under `key` was of a different member than `targetId`, it
 * moves to a key of its own, with its report and the servers that hold it,
 * so nothing said about that member carries over to the new one. Returns the
 * moved save, or null when it is the same member (or either ID is unknown).
 */
export function ownerChanged(prev: SavedItem | undefined, targetId: string | null): SavedItem | null {
  if (!prev || prev.kind !== 'profile' || !prev.targetId || !targetId || prev.targetId === targetId) return null;
  return { ...prev, key: `${prev.key}#${prev.targetId}` };
}

/** Saves not yet sent to `server`. */
export const pendingFor = (items: SavedItem[], server: string) => items.filter((i) => !i.uploadedTo.includes(server));

/** Reports `server` doesn't have yet, and withdrawals it hasn't had. */
export const reportsPendingFor = (items: SavedItem[], server: string) => items.filter((i) => needsSync(i, server));

/**
 * Released builds stored `reportedAt`, no target ID and no `heldBy`. A
 * `reportedAt` becomes a report with reason "Other", held nowhere yet.
 */
function normalize(x: unknown): SavedItem | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const i = x as Partial<SavedItem> & { reportedAt?: number | null };
  if ('report' in i && 'targetId' in i && 'heldBy' in i && 'withdrawnAt' in i) return i as SavedItem;
  const { reportedAt, ...rest } = i;
  const payload = i.payload as { kind?: string; id?: unknown } | undefined;
  const targetId = payload && payload.kind !== 'profile' && typeof payload.id === 'string' ? payload.id : null;
  const report: LocalReport | null =
    i.report ?? (typeof reportedAt === 'number' ? { stance: 'report', reasons: ['other'], confidence: 'suspected', note: null, at: reportedAt } : null);
  return { ...rest, targetId: i.targetId ?? targetId, report, withdrawnAt: i.withdrawnAt ?? null, heldBy: i.heldBy ?? {} } as SavedItem;
}

// --- Export / Import -----------------------------------------------------------

const FORMAT = 'fake-profile-reporter/saves';
/** Exports made before the rename. */
const OLD_FORMATS = ['fake-linkedin-reporter/saves'];

/**
 * One file with every save, its withdrawals, and this browser's master key
 * (lib/saves/reporter.ts), so reports can be edited from another browser.
 * The key works like a password.
 */
export function exportFile(items: SavedItem[], masterKey: string | null, now = Date.now()) {
  return JSON.stringify({ format: FORMAT, version: 2, exportedAt: now, masterKey, items }, null, 1);
}

const MASTER_KEY = /^[A-Za-z0-9_-]{32,128}$/;

/** Read an export. Throws with a message for the user when it isn't one; skips items that don't look right. */
export function parseExport(text: string): { items: SavedItem[]; skipped: number; masterKey: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  const file = data as { format?: unknown; version?: unknown; items?: unknown; masterKey?: unknown };
  if (!file || (file.format !== FORMAT && !OLD_FORMATS.includes(file.format as string)) || !Array.isArray(file.items)) throw new Error("That file isn't a Fake Profile Reporter export.");
  if (file.version !== 1 && file.version !== 2) throw new Error('That export is from a newer version of the extension.');
  const items = file.items.map(normalize).filter(isSavedItem);
  const masterKey = typeof file.masterKey === 'string' && MASTER_KEY.test(file.masterKey) ? file.masterKey : null;
  return { items, skipped: file.items.length - items.length, masterKey };
}

const KINDS = ['profile', 'company', 'job'];
const LEVELS = ['low', 'medium', 'high'];
const LINKEDIN_URL = /^https:\/\/([a-z]{2,3}\.|www\.)?linkedin\.com\//;
/** heldBy keys are server origins, as settings.ts normalizeServer gives them. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
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
    strOrNull(i.targetId) &&
    (i.report === null || isReport(i.kind as SavedItem['kind'], i.report)) &&
    (i.withdrawnAt === null || num(i.withdrawnAt)) &&
    !!i.heldBy &&
    typeof i.heldBy === 'object' &&
    !Array.isArray(i.heldBy) &&
    Object.entries(i.heldBy).every(([k, v]) => ORIGIN.test(k) && (v === null || num(v))) &&
    Array.isArray(i.uploadedTo) &&
    i.uploadedTo.every((s) => typeof s === 'string') &&
    !!p &&
    typeof p === 'object' &&
    p.kind === i.kind &&
    (i.kind === 'profile' ? typeof p.snapshotGzipBase64 === 'string' : typeof p.id === 'string' && !!p.facts && typeof p.facts === 'object')
  );
}

function isReport(kind: SavedItem['kind'], x: unknown): x is LocalReport {
  const r = x as Partial<LocalReport> | null;
  if (!r || typeof r !== 'object' || !stancesFor(kind).includes(r.stance as ReportStance)) return false;
  const allowed = new Set(reasonsFor(r.stance!).map((x) => x.id));
  return (
    Array.isArray(r.reasons) &&
    r.reasons.length > 0 &&
    r.reasons.every((x) => typeof x === 'string' && allowed.has(x)) &&
    (r.confidence === null || r.confidence === 'suspected' || r.confidence === 'confirmed') &&
    (r.note === null || (typeof r.note === 'string' && r.note.length <= NOTE_MAX)) &&
    num(r.at)
  );
}
