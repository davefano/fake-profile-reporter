// Sending, editing and withdrawing reports across servers (KTD11), per-server
// reporter keys (KTD13), and the bot check's handshake in the panel (KTD6).
// Runs against a fake storage area and a fake fetch; synthetic data only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { canSend, summaryMarkup } from '../lib/panel/report-form';
import { startCheck, verifyMessage, verifyPageUrl, LOAD_WAIT_MS, RENEW_MS, type CheckState } from '../lib/panel/verify';
import { deriveReporterKey, masterKey } from '../lib/saves/reporter';
import { localSaves, type Area, type LocalReport, type SavedItem } from '../lib/saves/store';
import { syncItem, uploadPending, waitForVerified, withdrawItem } from '../lib/saves/upload';

const A = 'https://a.example';
const B = 'https://b.example';
const CHALLENGE = 'c'.repeat(32);

function fakeArea(): Area {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
  };
}

interface Call {
  method: string;
  url: string;
  key: string | null;
}
type Handler = (c: Call) => { status: number; body: unknown } | 'offline';

let calls: Call[];
let handler: Handler;
const realFetch = globalThis.fetch;

const ok = (body: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, ...body } });
const counts = { reports: 1, vouches: 0, impersonated: 0 };
/** A server that takes everything. */
const accepts: Handler = (c) => (c.method === 'POST' ? ok({ id: '4242', score: { score: 70 } }) : ok({ counts }));

beforeEach(() => {
  (globalThis as any).browser = { storage: { local: fakeArea() } };
  calls = [];
  handler = accepts;
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call = { method: init.method ?? 'GET', url: String(input), key: headers['x-reporter-key'] ?? null };
    calls.push(call);
    const res = handler(call);
    if (res === 'offline') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const report = (o: Partial<LocalReport> = {}): LocalReport => ({ stance: 'report', reasons: ['fake-recruiter'], confidence: 'suspected', note: null, at: 4_000, ...o });

const item = (o: Partial<SavedItem> = {}): SavedItem => ({
  key: 'company:example-brand-careers',
  kind: 'company',
  targetId: '4242',
  url: 'https://www.linkedin.com/company/example-brand-careers/',
  name: 'Example Brand Careers',
  detail: null,
  score: 72,
  level: 'high',
  savedAt: 1_000,
  report: report(),
  withdrawnAt: null,
  heldBy: {},
  uploadedTo: [A, B],
  payload: { kind: 'company', id: '4242', facts: {} as any },
  ...o,
});
const KEY = item().key;

const reportCalls = (method: string) => calls.filter((c) => c.method === method && c.url.includes('/api/reports/')).map((c) => new URL(c.url).origin);
const down = (server: string, base: Handler = accepts): Handler => (c) => (c.url.startsWith(server) ? 'offline' : base(c));

describe('reconciling servers (KTD11)', () => {
  test('AE4: withdrawing reaches every server that holds it, not just the selected one', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: { [A]: 4_000, [B]: 4_000 } }));
    const res = await withdrawItem(KEY, B);
    expect(reportCalls('DELETE').sort()).toEqual([A, B]);
    expect(res).toMatchObject({ ok: true, unsent: [] });
    const got = await saves.get(KEY);
    expect(got).toMatchObject({ report: null, heldBy: {} });
    expect(got!.withdrawnAt).toBeNumber();
  });

  test('a server that misses the withdrawal keeps the tombstone and gets it on its next update', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: { [A]: 4_000, [B]: 4_000 } }));
    handler = down(A);
    const res = await withdrawItem(KEY, B);
    expect(res).toMatchObject({ ok: true, unsent: [A] });
    expect(await saves.get(KEY)).toMatchObject({ report: null, heldBy: { [A]: 4_000 } });

    handler = accepts;
    calls = [];
    await syncItem(KEY, A);
    expect(reportCalls('DELETE')).toEqual([A]);
    expect((await saves.get(KEY))!.heldBy).toEqual({});
  });

  test('AE9: a failed withdrawal, then a new report on the same server: it keeps the new report', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: { [A]: 4_000 } }));
    handler = down(A);
    await withdrawItem(KEY, A);
    // A new report while A is still unreachable: written here first.
    await saves.update(KEY, (i) => ({ ...i, report: report({ stance: 'vouch', reasons: ['worked-together'], confidence: null, at: 9_000 }), withdrawnAt: null }));
    handler = accepts;
    calls = [];
    await syncItem(KEY, A);
    expect(reportCalls('DELETE')).toEqual([]);
    expect(reportCalls('PUT')).toEqual([A]);
    expect((await saves.get(KEY))!.heldBy).toEqual({ [A]: 9_000 });
    calls = [];
    await syncItem(KEY, A); // later flush: nothing left to do
    expect(calls).toEqual([]);
  });

  test('an edit that failed, then a withdrawal: the server ends withdrawn', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: { [A]: 4_000 } }));
    handler = down(A);
    await saves.update(KEY, (i) => ({ ...i, report: report({ at: 5_000 }) }));
    await syncItem(KEY, A);
    await withdrawItem(KEY, A);
    handler = accepts;
    calls = [];
    await syncItem(KEY, A);
    expect(reportCalls('PUT')).toEqual([]);
    expect(reportCalls('DELETE')).toEqual([A]);
    expect((await saves.get(KEY))!.heldBy).toEqual({});
  });

  test('an edit after switching Save to reaches the original server too', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: { [A]: 4_000 } }));
    await saves.update(KEY, (i) => ({ ...i, report: report({ at: 5_000, reasons: ['other'] }) }));
    const res = await syncItem(KEY, B);
    expect(reportCalls('PUT').sort()).toEqual([A, B]);
    expect(res.unsent).toEqual([]);
    expect((await saves.get(KEY))!.heldBy).toEqual({ [A]: 5_000, [B]: 5_000 });
  });

  test('a server leaves heldBy only after a DELETE succeeds; not_reported counts as done', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: { [A]: 4_000, [B]: 4_000 } }));
    handler = (c) => (c.method !== 'DELETE' ? accepts(c) : c.url.startsWith(A) ? { status: 500, body: {} } : { status: 404, body: { error: 'not_reported' } });
    await withdrawItem(KEY, A);
    expect((await saves.get(KEY))!.heldBy).toEqual({ [A]: 4_000 });
  });

  test('the intent is written before the network call', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: {} }));
    let seen: SavedItem | undefined;
    const inner = accepts;
    handler = (c) => (c.method === 'PUT' ? 'offline' : inner(c));
    globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') seen = await saves.get(KEY);
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await syncItem(KEY, A);
    expect(seen!.heldBy).toEqual({ [A]: null });
    expect((await saves.get(KEY))!.heldBy).toEqual({ [A]: null }); // may hold it: keep it
  });

  test('two reconciliations started together for one item keep both servers', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: {} }));
    await Promise.all([syncItem(KEY, A), syncItem(KEY, B)]);
    expect((await saves.get(KEY))!.heldBy).toEqual({ [A]: 4_000, [B]: 4_000 });
  });

  test('verification_required keeps its place, returns the check, and loses nothing', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: {} }));
    handler = (c) => (c.method === 'PUT' ? { status: 403, body: { error: 'verification_required', verifyUrl: `${A}/verify?challenge=${CHALLENGE}` } } : accepts(c));
    const res = await syncItem(KEY, A);
    expect(res.current).toMatchObject({ error: 'verification_required', verifyUrl: `${A}/verify?challenge=${CHALLENGE}` });
    expect(res.unsent).toEqual([A]);
    expect(await saves.get(KEY)).toMatchObject({ report: report(), heldBy: { [A]: null } });
  });

  test('saving while offline is kept here and reported as not sent', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: {}, uploadedTo: [] }));
    handler = () => 'offline';
    const res = await syncItem(KEY, A);
    expect(res.current).toMatchObject({ error: 'network_error' });
    expect(res.unsent).toEqual([A]);
    expect((await saves.get(KEY))!.report).toEqual(report());
  });
});

describe('upload batch', () => {
  test('an unverified key is asked about once, and the other reports are not failed', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: {}, uploadedTo: [] }));
    await saves.put(item({ key: 'company:second', url: 'https://www.linkedin.com/company/second/', savedAt: 900, heldBy: {}, uploadedTo: [] }));
    await saves.put(item({ key: 'company:third', url: 'https://www.linkedin.com/company/third/', savedAt: 800, report: null, heldBy: {}, uploadedTo: [] }));
    handler = (c) => (c.method === 'PUT' ? { status: 403, body: { error: 'verification_required', verifyUrl: `${A}/verify?challenge=${CHALLENGE}` } } : accepts(c));
    const res = await uploadPending(A);
    expect(reportCalls('PUT')).toHaveLength(1);
    expect(res).toMatchObject({ failed: 0, uploaded: 1, waiting: 2, verifyUrl: `${A}/verify?challenge=${CHALLENGE}` });
    // The saves themselves still went.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(3);
  });

  test('sends pending withdrawals too', async () => {
    const saves = localSaves();
    await saves.put(item({ report: null, withdrawnAt: 5_000, heldBy: { [A]: null } }));
    const res = await uploadPending(A);
    expect(reportCalls('DELETE')).toEqual([A]);
    expect(res).toMatchObject({ uploaded: 1, failed: 0 });
  });
});

describe('the check in a tab (Safari)', () => {
  test('polls the status route with this server’s key until it passes', async () => {
    let polls = 0;
    handler = (c) => (c.url.endsWith('/api/verify/status') ? { status: 200, body: { verified: ++polls >= 3, verifiedUntil: null } } : accepts(c));
    expect(await waitForVerified(A, 1, 1_000)).toBe(true);
    expect(polls).toBe(3);
    expect(calls[0]!.key).toBe(await deriveReporterKey(await masterKey(), A));
  });

  test('gives up when the challenge would have expired', async () => {
    handler = () => ({ status: 200, body: { verified: false, verifiedUntil: null } });
    expect(await waitForVerified(A, 1, 20)).toBe(false);
  });
});

describe('reporter keys (KTD13)', () => {
  test('two servers get different keys, neither of them the master key', async () => {
    const master = await masterKey();
    const [a, b] = await Promise.all([deriveReporterKey(master, A), deriveReporterKey(master, B)]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(master);
    expect(b).not.toBe(master);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await deriveReporterKey(master, `${A}/`)).toBe(a); // the origin, not the spelling
    expect(await masterKey()).toBe(master);
  });

  test('requests carry the key derived for their own server', async () => {
    const saves = localSaves();
    await saves.put(item({ heldBy: { [A]: 1, [B]: 1 } }));
    await syncItem(KEY, B);
    const sent = Object.fromEntries(calls.filter((c) => c.method === 'PUT').map((c) => [new URL(c.url).origin, c.key]));
    const master = await masterKey();
    expect(sent[A]).toBe(await deriveReporterKey(master, A));
    expect(sent[B]).toBe(await deriveReporterKey(master, B));
  });
});

describe('the report form', () => {
  test('every stance needs at least one reason, impersonation included', () => {
    expect(canSend([])).toBe(false);
    expect(canSend([])).toBe(false);
    expect(canSend([])).toBe(false);
    expect(canSend(['contacted-me'])).toBe(true);
  });

  test('a report that could not be sent says so and offers Send now, never a retry', () => {
    const html = summaryMarkup('company', item({ heldBy: { [A]: null } }), A, 'a.example');
    expect(html).toContain('Saved in this browser, but not sent');
    expect(html).toContain('id="rsSendNow"');
    expect(html.toLowerCase()).not.toContain('retry');
    const sent = summaryMarkup('company', item({ heldBy: { [A]: 4_000 } }), A, 'a.example');
    expect(sent).toContain('shared with a.example');
    expect(sent).not.toContain('rsSendNow');
  });
});

describe('the bot check (KTD6)', () => {
  const PARENT = 'chrome-extension://abcdefghijklmnop';

  test('frames only the selected server’s own /verify page over https', () => {
    expect(verifyPageUrl(`${A}/verify?challenge=${CHALLENGE}`, A, { parentOrigin: PARENT })?.href).toBe(`${A}/verify?challenge=${CHALLENGE}&parentOrigin=${encodeURIComponent(PARENT)}`);
    expect(verifyPageUrl(`${B}/verify?challenge=${CHALLENGE}`, A, {})).toBeNull();
    expect(verifyPageUrl(`http://a.example/verify?challenge=${CHALLENGE}`, A, {})).toBeNull();
    expect(verifyPageUrl(`${A}/other?challenge=${CHALLENGE}`, A, {})).toBeNull();
    expect(verifyPageUrl(`${A}/verify?challenge=nope`, A, {})).toBeNull();
    expect(verifyPageUrl('javascript:alert(1)', A, {})).toBeNull();
  });

  test('accepts a message only from the framed page, for its challenge', () => {
    const win = {};
    const frame = { origin: A, window: win, challenge: CHALLENGE };
    const data = { type: 'fpr-verify', challenge: CHALLENGE, token: 'tok' };
    expect(verifyMessage({ origin: A, source: win, data }, frame)).toEqual(data as any);
    expect(verifyMessage({ origin: B, source: win, data }, frame)).toBeNull();
    expect(verifyMessage({ origin: A, source: {}, data }, frame)).toBeNull();
    expect(verifyMessage({ origin: A, source: win, data: { ...data, challenge: 'd'.repeat(32) } }, frame)).toBeNull();
    expect(verifyMessage({ origin: A, source: win, data: { type: 'other' } }, frame)).toBeNull();
  });

  function harness(o: { renew?: () => Promise<string | null>; verify?: (t: string, c: string) => Promise<true | string> } = {}) {
    const states: CheckState['state'][] = [];
    const framed: string[] = [];
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let next = 0;
    let listener: ((e: { origin: string; source: unknown; data: unknown }) => void) | null = null;
    const win = {};
    let onLoad = () => {};
    const verified: string[] = [];
    const check = startCheck(`${A}/verify?challenge=${CHALLENGE}`, {
      server: A,
      parentOrigin: PARENT,
      view: {
        show: (s) => states.push(s.state),
        frame(url, loaded) {
          framed.push(url);
          onLoad = loaded;
          return { window: win, focus() {}, remove() {} };
        },
      },
      listen(fn) {
        listener = fn;
        return () => (listener = null);
      },
      verify: o.verify ?? (async (t) => (verified.push(t), true)),
      renew: o.renew ?? (async () => `${A}/verify?challenge=${'e'.repeat(32)}`),
      timers: {
        set: (fn, ms) => (timers.set(++next, { fn, ms }), next),
        clear: (id) => timers.delete(id as number),
      },
    });
    const fire = (ms: number) => [...timers.entries()].filter(([, t]) => t.ms === ms).forEach(([id, t]) => (timers.delete(id), t.fn()));
    return { check, states, framed, fire, post: (e: { origin: string; source: unknown; data: unknown }) => listener?.(e), win, load: () => onLoad(), verified };
  }

  test('a check that never loads offers Try again, which asks for a fresh challenge', async () => {
    const h = harness();
    expect(h.states).toEqual(['loading']);
    h.fire(LOAD_WAIT_MS);
    expect(h.states.at(-1)).toBe('not_loaded');
    h.check.retry();
    await Bun.sleep(0);
    expect(h.framed).toHaveLength(2);
    expect(h.framed[1]).toContain('e'.repeat(32));
  });

  test('an expiring challenge is replaced without asking', async () => {
    const h = harness();
    h.load();
    h.fire(RENEW_MS);
    await Bun.sleep(0);
    expect(h.framed).toHaveLength(2);
  });

  test('ignores messages from elsewhere, then passes on the framed page’s token', async () => {
    const h = harness();
    h.load();
    expect(h.states.at(-1)).toBe('ready');
    h.post({ origin: B, source: h.win, data: { type: 'fpr-verify', challenge: CHALLENGE, token: 'evil' } });
    h.post({ origin: A, source: {}, data: { type: 'fpr-verify', challenge: CHALLENGE, token: 'evil' } });
    expect(h.verified).toEqual([]);
    h.post({ origin: A, source: h.win, data: { type: 'fpr-verify', challenge: CHALLENGE, token: 'good' } });
    expect(await h.check.done).toBe(true);
    expect(h.verified).toEqual(['good']);
  });

  test('a verifyUrl from another server is never framed', () => {
    const framed: string[] = [];
    const states: string[] = [];
    startCheck(`${B}/verify?challenge=${CHALLENGE}`, {
      server: A,
      parentOrigin: PARENT,
      view: { show: (s) => states.push(s.state), frame: (u) => (framed.push(u), { window: {}, focus() {}, remove() {} }) },
      listen: () => () => {},
      verify: async () => true,
      renew: async () => null,
    });
    expect(framed).toEqual([]);
    expect(states).toEqual(['failed']);
  });

  test('stopping mid-check resolves false and frames nothing more', async () => {
    const h = harness();
    h.check.stop();
    expect(await h.check.done).toBe(false);
    h.fire(LOAD_WAIT_MS);
    expect(h.states).toEqual(['loading']);
  });
});
