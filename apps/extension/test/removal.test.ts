// "This is me": the removal request's code, the code check on a fresh read,
// the state kept per profile, and the answers the panel shows (R17, KTD8).
// Synthetic people only; no DOM.
import { describe, expect, test } from 'bun:test';
import type { RemovalRequest } from '@fpr/core/wire';
import { checkAndSend, hasCode, newCode, outcomeText, removalStore, type RemovalOutcome } from '../lib/panel/removal';
import type { Area } from '../lib/saves/store';
import type { ProfileScan, ScanResponse } from '../lib/scan/messages';

const MEMBER = 700_000_001;
const SERVER = 'https://a.example';

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

/** A fresh read of a profile with this headline and About. */
function read(headline: string | null, summary: string | null, o: { memberId?: number; carried?: ProfileScan['carried'] } = {}): ScanResponse {
  return {
    kind: 'profile',
    slug: 'jordan-sample-0a1b2c',
    facts: { memberId: o.memberId ?? MEMBER, headline, summary, profileLoaded: true } as ProfileScan['facts'],
    capturedAt: Date.now(),
    errors: {},
    carried: o.carried ?? [],
    changes: [],
    previousCheckAt: null,
    cached: false,
    score: { version: 6, score: 10, level: 'low', signals: [], missing: [] },
  };
}

describe('the code', () => {
  test('is in the format the server accepts, and different each time', () => {
    const a = newCode();
    expect(a).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    expect(newCode()).not.toBe(a);
  });

  test('is found as a whole token, case-sensitively', () => {
    const code = 'fpr-k3x9q2m7wz';
    expect(hasCode(`Platform engineer ${code}`, code)).toBe(true);
    expect(hasCode(`(${code}) Platform engineer`, code)).toBe(true);
    expect(hasCode(`Code: ${code}.`, code)).toBe(true);
    expect(hasCode(code.toUpperCase(), code)).toBe(false);
    expect(hasCode(`x${code}`, code)).toBe(false);
    expect(hasCode(`${code}9`, code)).toBe(false);
    expect(hasCode(`${code}-old`, code)).toBe(false);
    expect(hasCode(`old_${code}`, code)).toBe(false);
    expect(hasCode(null, code)).toBe(false);
  });
});

describe('check and send', () => {
  const code = 'fpr-k3x9q2m7wz';

  async function run(scan: ScanResponse, answer: unknown = { ok: true }) {
    const sent: RemovalRequest[] = [];
    const out = await checkAndSend({
      memberId: MEMBER,
      code,
      contact: '',
      scan: async () => scan,
      send: async (req) => (sent.push(req), answer as never),
    });
    return { out, sent };
  }

  test('finds the code in the headline and sends the request', async () => {
    const { out, sent } = await run(read(`Platform engineer ${code}`, null));
    expect(out).toEqual({ kind: 'sent' });
    expect(sent).toEqual([{ memberId: MEMBER, code }]);
  });

  test('finds the code in About and sends the contact when given', async () => {
    const sent: RemovalRequest[] = [];
    const out = await checkAndSend({
      memberId: MEMBER,
      code,
      contact: '  me@example.org ',
      scan: async () => read('Platform engineer', `Hello.\n\n${code}\n`),
      send: async (req) => (sent.push(req), { ok: true }),
    });
    expect(out.kind).toBe('sent');
    expect(sent).toEqual([{ memberId: MEMBER, code, contact: 'me@example.org' }]);
  });

  test('a read without the code says so, naming headline and About, and sends nothing', async () => {
    const { out, sent } = await run(read('Platform engineer', `Something ${code}x`));
    expect(out).toEqual({ kind: 'missing' });
    expect(sent).toEqual([]);
    const text = outcomeText(out, SERVER);
    expect(text).toContain('headline');
    expect(text).toContain('About');
  });

  test('a read of another profile, or one that could not load the profile part, sends nothing', async () => {
    expect((await run(read(code, null, { memberId: MEMBER + 1 }))).sent).toEqual([]);
    const stale = await run(read(code, null, { carried: ['profile'] }));
    expect(stale.out.kind).toBe('scan_failed');
    expect(stale.sent).toEqual([]);
    const failed = await run({ error: 'capture_failed', message: 'LinkedIn said no' });
    expect(failed.out.kind).toBe('scan_failed');
    expect(failed.sent).toEqual([]);
  });

  test('verification_required hands back the check', async () => {
    const { out } = await run(read(code, null), { error: 'verification_required', verifyUrl: `${SERVER}/verify?challenge=${'c'.repeat(32)}` });
    expect(out).toEqual({ kind: 'verify', verifyUrl: `${SERVER}/verify?challenge=${'c'.repeat(32)}` });
  });

  test('already_pending and recently_denied show a plain message', async () => {
    const pending = (await run(read(code, null), { error: 'already_pending' })).out;
    expect(pending).toEqual({ kind: 'refused', error: 'already_pending' });
    expect(outcomeText(pending, SERVER)).toMatch(/already .*pending/i);
    const denied = (await run(read(code, null), { error: 'recently_denied' })).out;
    expect(outcomeText(denied, SERVER)).toMatch(/declined/i);
    for (const error of ['queue_full', 'daily_limit_reached', 'not_found', 'removed']) {
      const text = outcomeText({ kind: 'refused', error }, SERVER);
      expect(text).not.toBe(error);
      expect(text).not.toMatch(/fake/i);
    }
    expect(outcomeText({ kind: 'refused', error: 'not_found' }, SERVER)).toContain('a.example');
  });
});

describe('kept per profile', () => {
  test('a code issued, then the panel closed and reopened on the same profile, is the same code', async () => {
    const area = fakeArea();
    const first = await removalStore(area).issue(MEMBER);
    // Reopening the panel builds a new store over the same storage.
    expect(await removalStore(area).get(MEMBER)).toEqual(first);
    expect((await removalStore(area).issue(MEMBER)).code).toBe(first.code);
    expect((await removalStore(area).issue(MEMBER + 1)).code).not.toBe(first.code);
  });

  test('cancel forgets the code; sent replaces it and stays', async () => {
    const area = fakeArea();
    const store = removalStore(area);
    const first = await store.issue(MEMBER);
    await store.cancel(MEMBER);
    expect(await store.get(MEMBER)).toBeNull();
    expect((await store.issue(MEMBER)).code).not.toBe(first.code);
    await store.markSent(MEMBER, SERVER, 1_000);
    expect(await removalStore(area).get(MEMBER)).toEqual({ state: 'sent', server: SERVER, at: 1_000 });
    // A sent request isn't replaced by a new code.
    expect(await store.issue(MEMBER).catch(() => 'refused')).toBe('refused');
  });

  test('outcomes that leave a request pending say the maintainer reviews it', () => {
    const sent: RemovalOutcome = { kind: 'sent' };
    expect(outcomeText(sent, SERVER)).toMatch(/maintainer/i);
  });
});
