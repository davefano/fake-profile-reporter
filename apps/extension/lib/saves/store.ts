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
  at: number;
  /** Servers holding this version of the report. */
  sentTo: string[];
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
    async markUploaded(key: string, server: string) {
      const item = await get(key);
      if (item && !item.uploadedTo.includes(server)) await put({ ...item, uploadedTo: [...item.uploadedTo, server] });
    },
    /** The server now holds this item's report, as it was when sent. */
    async markReportSent(key: string, server: string, at: number) {
      const item = await get(key);
      if (item?.report && item.report.at === at && !item.report.sentTo.includes(server)) {
        await put({ ...item, report: { ...item.report, sentTo: [...item.report.sentTo, server] } });
      }
    },
    async setReport(key: string, report: LocalReport | null) {
      const item = await get(key);
      if (item) await put({ ...item, report });
    },
    async setTargetId(key: string, targetId: string) {
      const item = await get(key);
      if (item && item.targetId !== targetId) await put({ ...item, targetId });
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

/** The newer save wins; the newer report wins, and a report on either side is kept. Returns `have` when nothing changes. */
export function mergeItem(have: SavedItem | undefined, incoming: SavedItem): SavedItem {
  if (!have) return incoming;
  const [newer, older] = incoming.savedAt > have.savedAt ? [incoming, have] : [have, incoming];
  const reports = [newer.report, older.report].filter((r): r is LocalReport => !!r).sort((a, b) => b.at - a.at);
  const same = reports.length === 2 && reports[0]!.at === reports[1]!.at;
  const report = reports[0] ? { ...reports[0], sentTo: same ? [...new Set([...reports[0].sentTo, ...reports[1]!.sentTo])] : reports[0].sentTo } : null;
  const uploadedTo = newer.savedAt === older.savedAt ? [...new Set([...newer.uploadedTo, ...older.uploadedTo])] : newer.uploadedTo;
  const next = { ...newer, targetId: newer.targetId ?? older.targetId, report, uploadedTo };
  return JSON.stringify(next) === JSON.stringify(have) ? have : next;
}

/** Saves not yet sent to `server`. */
export const pendingFor = (items: SavedItem[], server: string) => items.filter((i) => !i.uploadedTo.includes(server));

/** Reports not yet sent to `server`. */
export const reportsPendingFor = (items: SavedItem[], server: string) => items.filter((i) => i.report && !i.report.sentTo.includes(server));

/**
 * Saves from before reports had reasons stored `reportedAt` and no target ID.
 * They become a report with reason "Other", not yet sent anywhere.
 */
function normalize(x: unknown): SavedItem | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const i = x as Partial<SavedItem> & { reportedAt?: number | null };
  if ('report' in i && 'targetId' in i) return i as SavedItem;
  const { reportedAt, ...rest } = i;
  const payload = i.payload as { kind?: string; id?: unknown } | undefined;
  const targetId = payload && payload.kind !== 'profile' && typeof payload.id === 'string' ? payload.id : null;
  const report: LocalReport | null =
    i.report ?? (typeof reportedAt === 'number' ? { stance: 'report', reasons: ['other'], confidence: 'suspected', note: null, at: reportedAt, sentTo: [] } : null);
  return { ...rest, targetId: i.targetId ?? targetId, report } as SavedItem;
}

// --- Export / Import -----------------------------------------------------------

const FORMAT = 'fake-profile-reporter/saves';
/** Exports made before the rename. */
const OLD_FORMATS = ['fake-linkedin-reporter/saves'];

/**
 * One file with every save and this browser's reporter key, so reports can be
 * edited from another browser. The key works like a password.
 */
export function exportFile(items: SavedItem[], reporterKey: string | null, now = Date.now()) {
  return JSON.stringify({ format: FORMAT, version: 2, exportedAt: now, reporterKey, items }, null, 1);
}

const REPORTER_KEY = /^[A-Za-z0-9_-]{32,128}$/;

/** Read an export. Throws with a message for the user when it isn't one; skips items that don't look right. */
export function parseExport(text: string): { items: SavedItem[]; skipped: number; reporterKey: string | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON.");
  }
  const file = data as { format?: unknown; version?: unknown; items?: unknown; reporterKey?: unknown };
  if (!file || (file.format !== FORMAT && !OLD_FORMATS.includes(file.format as string)) || !Array.isArray(file.items)) throw new Error("That file isn't a Fake Profile Reporter export.");
  if (file.version !== 1 && file.version !== 2) throw new Error('That export is from a newer version of the extension.');
  const items = file.items.map(normalize).filter(isSavedItem);
  const reporterKey = typeof file.reporterKey === 'string' && REPORTER_KEY.test(file.reporterKey) ? file.reporterKey : null;
  return { items, skipped: file.items.length - items.length, reporterKey };
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
    strOrNull(i.targetId) &&
    (i.report === null || isReport(i.kind as SavedItem['kind'], i.report)) &&
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
    num(r.at) &&
    Array.isArray(r.sentTo) &&
    r.sentTo.every((s) => typeof s === 'string')
  );
}
