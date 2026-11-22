import { beforeEach, describe, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AccountResponse } from '@fpr/core/wire';
import { extractProfileFacts, scoreProfile } from '@fpr/core';
import { createAccountStore } from '../src/accounts-store';
import { hashIp } from '../src/ip';

const hashIpFor = (ip: string) => hashIp(ip, 'test');
import { fakeSnapshot } from '@fpr/core/test/fixtures';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

let env: Env & { SNAPSHOTS: ReturnType<typeof createTestR2> };

beforeEach(() => {
  env = { DB: createTestD1(), RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test' };
});

async function account(memberId: number): Promise<AccountResponse> {
  return (await (await app.request(`/api/accounts/${memberId}`, {}, env)).json()) as AccountResponse;
}

function post(body: unknown, { gzip = false, ip = '1.1.1.1', report = false } = {}) {
  const json = JSON.stringify(body);
  return app.request(
    report ? '/api/snapshots?report=1' : '/api/snapshots',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: gzip ? gzipSync(json) : json,
    },
    env,
  );
}

describe('POST /api/snapshots', () => {
  test('stores the raw payload gzipped in R2 and the facts in D1', async () => {
    const res = await post(fakeSnapshot({ memberId: 700_000_001 }), { gzip: true });
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.memberId).toBe(700_000_001);
    expect(data.score.level).toBe('low');
    expect(data.changes).toEqual([]);

    const [key, obj] = [...env.SNAPSHOTS.objects][0]!;
    expect(key).toStartWith('snapshots/700000001/');
    const raw = JSON.parse(gunzipSync(obj.body).toString('utf8'));
    expect(raw.slug).toBe('jordan-sample-0a1b2c');

    const acct = await account(700_000_001);
    expect(acct.joined?.source).toBe('about');
    expect(acct.connections).toEqual({ count: 500, capped: true });
    expect(acct.verified).toBe(false);
    expect(acct.snapshotCount).toBe(1);
  });

  test('plain JSON is accepted and stored gzipped', async () => {
    expect((await post(fakeSnapshot())).status).toBe(201);
    const [, obj] = [...env.SNAPSHOTS.objects][0]!;
    expect(obj.body[0]).toBe(0x1f);
  });

  test('tracks slug changes and diffs against the previous snapshot', async () => {
    await post(fakeSnapshot({ slug: 'first-slug', capturedAt: Date.UTC(2026, 9, 1) }), { ip: '1.1.1.1' });
    const res = await post(fakeSnapshot({ slug: 'second-slug', headline: 'CEO', capturedAt: Date.UTC(2026, 10, 1) }), { ip: '2.2.2.2' });
    const data = (await res.json()) as any;
    expect(data.changes.map((c: any) => c.field).sort()).toEqual(['headline', 'slug']);

    const byOldSlug = (await (await app.request('/api/accounts?slug=FIRST-SLUG', {}, env)).json()) as AccountResponse;
    expect(byOldSlug.slug).toBe('second-slug');
    expect(byOldSlug.slugs.map((x) => x.slug)).toEqual(['first-slug', 'second-slug']);
    expect(byOldSlug.snapshotCount).toBe(2);
    expect(byOldSlug.snapshots[0]!.changes).toHaveLength(2);
  });

  test('rejects bad input', async () => {
    expect((await app.request('/api/snapshots', { method: 'POST', body: '{nope' }, env)).status).toBe(400);
    expect((await post({ schema: 99, slug: 'x', payloads: {} })).status).toBe(400);
    expect((await post({ schema: 1, slug: 'x', capturedAt: 1, payloads: {}, errors: {} })).status).toBe(422);
  });

  test('rate limits repeat captures of the same account from one IP', async () => {
    expect((await post(fakeSnapshot())).status).toBe(201);
    expect((await post(fakeSnapshot())).status).toBe(429);
  });

  test('an older snapshot uploaded late does not roll the account back', async () => {
    await post(fakeSnapshot({ slug: 'new-slug', capturedAt: Date.UTC(2026, 10, 1) }), { ip: '1.1.1.1' });
    const late = (await (await post(fakeSnapshot({ slug: 'old-slug', capturedAt: Date.UTC(2026, 8, 1) }), { ip: '2.2.2.2' })).json()) as any;
    expect(late.changes).toEqual([]);
    const got = await account(700_000_001);
    expect(got.slug).toBe('new-slug');
    expect(got.lastCapturedAt).toBe(Date.UTC(2026, 10, 1));
    expect(got.firstCapturedAt).toBe(Date.UTC(2026, 8, 1));
    expect(got.snapshotCount).toBe(2);
    expect(got.slugs.find((x) => x.slug === 'old-slug')?.firstSeen).toBe(Date.UTC(2026, 8, 1));
  });

  test('a gzip bomb is rejected before it is fully decompressed', async () => {
    const bomb = gzipSync(Buffer.alloc(26 * 1024 * 1024, 0x20));
    const res = await app.request('/api/snapshots', { method: 'POST', headers: { 'cf-connecting-ip': '1.1.1.1' }, body: bomb }, env);
    expect(res.status).toBe(413);
  });

  test('a capture whose full profile failed keeps the account facts, and later changes still show', async () => {
    await post(fakeSnapshot({ firstName: 'Alex', headline: 'Engineer', capturedAt: Date.UTC(2026, 9, 1) }), { ip: '1.1.1.1' });
    const partial = fakeSnapshot({ firstName: 'Alex', capturedAt: Date.UTC(2026, 9, 15) });
    delete partial.payloads.fullProfile;
    partial.errors.fullProfile = 'HTTP 500';
    expect((await post(partial, { ip: '2.2.2.2' })).status).toBe(201);
    let got = await account(700_000_001);
    expect(got.name).toBe('Alex Sample');
    expect(got.headline).toBe('Engineer');

    const later = (await (await post(fakeSnapshot({ firstName: 'Alex', headline: 'CEO', capturedAt: Date.UTC(2026, 10, 1) }), { ip: '3.3.3.3' })).json()) as any;
    expect(later.changes.map((c: any) => c.field)).toEqual(['headline']);
    got = await account(700_000_001);
    expect(got.headline).toBe('CEO');
  });

  test('many partial captures in a row still keep the last good facts', async () => {
    await post(fakeSnapshot({ firstName: 'Alex', headline: 'Engineer', capturedAt: Date.UTC(2026, 8, 1) }), { ip: '1.1.1.1' });
    for (let i = 0; i < 12; i++) {
      const partial = fakeSnapshot({ firstName: 'Alex', capturedAt: Date.UTC(2026, 8, 2 + i) });
      delete partial.payloads.fullProfile;
      expect((await post(partial, { ip: `2.2.2.${i}` })).status).toBe(201);
    }
    const got = await account(700_000_001);
    expect(got).toMatchObject({ name: 'Alex Sample', headline: 'Engineer', snapshotCount: 13 });
  });

  test('malformed nested payloads are a 4xx, never a 500', async () => {
    for (const payloads of [
      { resolve: { included: 'x' }, fullProfile: { included: {} } },
      { fullProfile: { included: [null, 7] } },
    ]) {
      const res = await post({ schema: 1, slug: 'x', capturedAt: 1, payloads, errors: {} });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });

  test('uploads are cleaned: unknown and malformed payloads are dropped, never stored', async () => {
    const snap: any = fakeSnapshot();
    snap.payloads.profilePageMutual = 'Lara and David are mutual connections';
    snap.payloads.profilePageCounts = 123;
    snap.payloads.extra = { anything: true };
    expect((await post(snap, { gzip: true })).status).toBe(201);
    const [, obj] = [...env.SNAPSHOTS.objects][0]!;
    const stored = JSON.parse(gunzipSync(obj.body).toString('utf8'));
    expect(Object.keys(stored.payloads).sort()).toEqual(['about', 'activity', 'followingState', 'fullProfile', 'resolve']);
  });

  test('mutual connections are neither stored nor scored', async () => {
    const snap = fakeSnapshot();
    snap.payloads.profilePageMutualCount = 12;
    const data = (await (await post(snap, { gzip: true })).json()) as any;
    expect(data.score.signals.map((x: any) => x.id)).not.toContain('trust.mutual');
    const [, obj] = [...env.SNAPSHOTS.objects][0]!;
    expect(JSON.parse(gunzipSync(obj.body).toString('utf8')).payloads.profilePageMutualCount).toBeUndefined();
  });
});

describe('account current facts', () => {
  test('a commit from a stale version writes nothing at all, even with the same capture time', async () => {
    const store = createAccountStore(env.DB);
    const at = Date.UTC(2026, 10, 1);
    const a = extractProfileFacts(fakeSnapshot({ headline: 'From A' }), at);
    const b = extractProfileFacts(fakeSnapshot({ headline: 'From B' }), at);
    let n = 0;
    const write = (f: typeof a) => ({ observed: { ...f, memberId: 700_000_001 }, score: scoreProfile(f, at), changes: [], r2Key: `k${n++}`, capturedAt: at, ipHash: 'h' });

    // Both read "no current facts yet"; only the first commit lands.
    expect(await store.commitNewest(write(a), null, { facts: a, score: scoreProfile(a, at) })).toBe(true);
    expect(await store.commitNewest(write(b), null, { facts: b, score: scoreProfile(b, at) })).toBe(false);
    // Both read the same version at the same capture time; only the first commit lands.
    const v1 = (await store.current(700_000_001))!.rev;
    expect(await store.commitNewest(write(b), v1, { facts: b, score: scoreProfile(b, at) })).toBe(true);
    expect(await store.commitNewest(write(a), v1, { facts: a, score: scoreProfile(a, at) })).toBe(false);

    const got = await account(700_000_001);
    expect(got.headline).toBe('From B');
    expect(got.snapshotCount).toBe(2); // the two losing commits stored nothing
    expect(got.snapshots).toHaveLength(2);
    const listed = await env.DB.prepare('SELECT headline FROM accounts WHERE member_id = 700000001').first<{ headline: string }>();
    expect(listed?.headline).toBe('From B');
  });

  test('the same capture uploaded twice is stored once, and a report on it still counts', async () => {
    const snap = fakeSnapshot({ capturedAt: Date.UTC(2026, 10, 1) });
    expect((await post(snap)).status).toBe(201);
    // Past the snapshot cooldown: same reporter, same capture, now reported.
    await env.RATE_KV.put(`cd:snapshot:700000001:${await hashIpFor('1.1.1.1')}`, '0');
    const res = (await (await post(snap, { report: true })).json()) as any;
    expect(res.reported).toBe(true);
    const got = await account(700_000_001);
    expect(got.snapshotCount).toBe(1);
    expect(got.snapshots).toHaveLength(1);
    expect(got.reports).toBe(1);
    expect(env.SNAPSHOTS.objects.size).toBe(1);
  });

  test('if archiving fails, nothing in the database changes', async () => {
    env.SNAPSHOTS.put = async () => {
      throw new Error('R2 down');
    };
    const res = await post(fakeSnapshot());
    expect(res.status).toBe(500);
    expect((await app.request('/api/accounts/700000001', {}, env)).status).toBe(404);
  });

  test('impossible capture times are treated as now, never a 500', async () => {
    for (const capturedAt of [-1e20, 1e20, 'yesterday']) {
      const snap: any = fakeSnapshot({ memberId: 700_000_100 + String(capturedAt).length });
      snap.capturedAt = capturedAt;
      const res = await post(snap, { ip: `9.9.9.${String(capturedAt).length}` });
      expect(res.status).toBe(201);
    }
  });
});

describe('reports', () => {
  test('?report=1 saves the snapshot and reports the account; the leaderboard ranks reported accounts', async () => {
    const res = await post(fakeSnapshot({ memberId: 700_000_001, firstName: 'Alex' }), { report: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).reported).toBe(true);
    await post(fakeSnapshot({ memberId: 700_000_002, firstName: 'Sam' }), { report: true, ip: '1.1.1.1' });
    await post(fakeSnapshot({ memberId: 700_000_002, firstName: 'Sam' }), { report: true, ip: '2.2.2.2' });
    await post(fakeSnapshot({ memberId: 700_000_003 })); // tracked, never reported

    const board = (await (await app.request('/api/leaderboard', {}, env)).json()) as any;
    expect(board.stats).toEqual({ reports: 3, accounts: 2 });
    expect(board.rows.map((r: any) => [r.memberId, r.reports])).toEqual([[700_000_002, 2], [700_000_001, 1]]);
    expect(board.rows[0]).toMatchObject({ name: 'Sam Sample', level: 'low', slug: 'jordan-sample-0a1b2c' });
  });

  test('a report inside the snapshot cooldown answers with the stored score, not the new upload', async () => {
    const first = (await (await post(fakeSnapshot({ joinedAt: Date.UTC(2012, 0, 15) }))).json()) as any;
    const fresh = fakeSnapshot({ joinedAt: Date.UTC(2026, 9, 15), headline: 'Recruiter', connections: '2 connections' });
    const res = (await (await post(fresh, { report: true })).json()) as any;
    expect(res.reported).toBe(true);
    expect(res.score.score).toBe(first.score.score);
    expect((await account(700_000_001)).score).toBe(first.score.score);
  });

  test('a report still counts inside the snapshot cooldown, but only once a day', async () => {
    expect((await post(fakeSnapshot())).status).toBe(201); // Track
    expect((await post(fakeSnapshot(), { report: true })).status).toBe(201); // then Report
    expect((await post(fakeSnapshot(), { report: true })).status).toBe(429);
    const got = await account(700_000_001);
    expect(got.reports).toBe(1);
    expect(got.snapshotCount).toBe(1);
  });
});

test('GET /api/accounts 404s for unknown accounts', async () => {
  expect((await app.request('/api/accounts/123', {}, env)).status).toBe(404);
  expect((await app.request('/api/accounts?slug=nobody', {}, env)).status).toBe(404);
  expect((await app.request('/api/accounts', {}, env)).status).toBe(400);
});
