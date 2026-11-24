import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeSnapshot } from '@fpr/core/test/fixtures';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

const MEMBER = 700_000_001;
const OTHER = 700_000_002;
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const KEY_C = 'c'.repeat(40);
const TOKEN = 'T0ken-of-at-least-thirty-two-random-bytes-xyz';
const DAY = 86_400_000;
const CODE = 'fpr-7k3q9z';

let env: Env & { SNAPSHOTS: ReturnType<typeof createTestR2> };

function makeEnv(db = createTestD1()) {
  return { DB: db, RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test', ADMIN_TOKEN: TOKEN } as Env & { SNAPSHOTS: ReturnType<typeof createTestR2> };
}

let ipSeq = 0;
const save = (memberId = MEMBER, p: { firstName?: string; slug?: string; capturedAt?: number } = {}) =>
  app.request(
    '/api/snapshots',
    { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.9.${ipSeq++ % 250}.1` }, body: JSON.stringify(fakeSnapshot({ memberId, ...p })) },
    env,
  );

function request(body: unknown, key: string | null = KEY_A, ip = '1.1.1.1') {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
  if (key) headers['x-reporter-key'] = key;
  return app.request('/api/removals', { method: 'POST', headers, body: JSON.stringify(body) }, env);
}
const ask = (key = KEY_A, ip = '1.1.1.1', memberId = MEMBER, contact?: string) => request({ memberId, code: CODE, ...(contact ? { contact } : {}) }, key, ip);

function admin(path: string, init: { method?: string; body?: unknown; auth?: string | null; ip?: string } = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': init.ip ?? '9.9.9.9' };
  if (init.auth !== null) headers.authorization = init.auth ?? `Bearer ${TOKEN}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
}
const list = async () => (await (await admin('/api/admin/removals')).json()) as any;
const approve = (id: number, memberId = MEMBER) => admin(`/api/admin/removals/${id}/approve`, { body: { memberId } });
const deny = (id: number, reason: 'code' | 'merits') => admin(`/api/admin/removals/${id}/deny`, { body: { reason } });
const restore = (memberId = MEMBER) => admin(`/api/admin/removed/${memberId}/restore`, { body: {} });

const rows = <T = any>(sql: string, ...params: (string | number)[]) => env.DB.prepare(sql).bind(...params).all<T>().then((r) => r.results);
const requestRow = async (id: number) => (await rows('SELECT * FROM removal_requests WHERE id = ?', id))[0];
const report = (key: string, stance = 'report', ip = '2.2.2.2', memberId = MEMBER) =>
  app.request(`/api/reports/profile/${memberId}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-reporter-key': key, 'cf-connecting-ip': ip }, body: JSON.stringify({ stance, reasons: stance === 'report' ? ['fake-applicant'] : stance === 'impersonated' ? ['fake-copy'] : ['know-personally'] }) }, env);

/** Files a request and returns its ID. */
async function filed(key = KEY_A, ip = '1.1.1.1', contact?: string) {
  const res = await ask(key, ip, MEMBER, contact);
  expect(res.status).toBe(201);
  const [r] = await rows<{ id: number }>('SELECT MAX(id) AS id FROM removal_requests');
  return r!.id;
}

beforeEach(async () => {
  env = makeEnv();
  expect((await save()).status).toBe(201);
});

describe('POST /api/removals', () => {
  test('accepts a request for a stored member; the profile stays listed and counted while pending (AE6)', async () => {
    await report(KEY_B);
    expect((await ask()).status).toBe(201);
    const board = (await (await app.request('/api/leaderboard', {}, env)).json()) as any;
    expect(board.rows.map((r: any) => [r.memberId, r.reports])).toEqual([[MEMBER, 1]]);
    const acct = await app.request(`/api/accounts/${MEMBER}`, {}, env);
    expect(acct.status).toBe(200);
    expect(((await acct.json()) as any).counts.reports).toBe(1);
  });

  test('refuses a member the server never stored', async () => {
    const res = await ask(KEY_A, '1.1.1.1', 700_000_999);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  test('one pending request per requester and per IP; another requester may also ask', async () => {
    expect((await ask(KEY_A, '1.1.1.1')).status).toBe(201);
    const again = await ask(KEY_A, '3.3.3.3');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'already_pending' });
    expect((await ask(KEY_C, '1.1.1.1')).status).toBe(409); // same IP
    expect((await ask(KEY_B, '2.2.2.2')).status).toBe(201);
  });

  test('a denial because the code was not found blocks only that requester (AE8)', async () => {
    const id = await filed(KEY_A, '1.1.1.1');
    expect((await deny(id, 'code')).status).toBe(200);
    const again = await ask(KEY_A, '4.4.4.4');
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: 'recently_denied' });
    expect((await ask(KEY_B, '2.2.2.2')).status).toBe(201);
  });

  test('a denial on the merits blocks the profile for 90 days', async () => {
    const id = await filed();
    await deny(id, 'merits');
    const res = await ask(KEY_B, '2.2.2.2');
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'recently_denied' });
    await env.DB.prepare('UPDATE removal_requests SET decided_at = ?').bind(Date.now() - 91 * DAY).run();
    expect((await ask(KEY_B, '2.2.2.2')).status).toBe(201);
  });

  test('at the global cap of pending requests, answers queue_full', async () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      await env.DB.prepare("INSERT INTO removal_requests (member_id, reporter, ip_hash, code, status, created_at) VALUES (?, ?, ?, 'x', 'pending', ?)").bind(800_000_000 + i, `r${i}`, `ip${i}`, now).run();
    }
    const res = await ask();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'queue_full' });
  });

  test('parallel requests from one key past its daily cap: only the cap succeeds', async () => {
    // Different members so pending rules don't interfere; only the daily cap decides.
    for (let i = 1; i <= 5; i++) await save(MEMBER + i * 10);
    const out = await Promise.all([1, 2, 3, 4, 5].map((i) => ask(KEY_A, `5.5.5.${i}`, MEMBER + i * 10)));
    const statuses = out.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
    for (const r of out.filter((r) => r.status === 429)) expect(await r.json()).toEqual({ error: 'daily_limit_reached' });
  });

  test('per IP, at most 5 a day', async () => {
    for (let i = 1; i <= 6; i++) await save(MEMBER + i * 10);
    const keys = [1, 2, 3, 4, 5, 6].map((i) => String(i).repeat(40));
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await ask(keys[i], '6.6.6.6', MEMBER + (i + 1) * 10)).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  test('needs a verified key where the server has the bot check', async () => {
    env = { ...env, VERIFY_HOST: 'api.example.test', TURNSTILE_SITEKEY: 'site', TURNSTILE_SECRET: 'secret' };
    const res = await ask();
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('verification_required');
  });

  test('validates the key and body', async () => {
    expect((await ask('short')).status).toBe(401);
    expect((await request({ memberId: MEMBER, code: CODE }, null)).status).toBe(401);
    for (const bad of [{}, { memberId: 'abc', code: CODE }, { memberId: MEMBER }, { memberId: MEMBER, code: 'has space' }, { memberId: MEMBER, code: CODE, contact: 'x'.repeat(201) }, { memberId: MEMBER, code: CODE, contact: 5 }]) {
      expect((await request(bad)).status).toBe(400);
    }
  });
});

describe('admin auth', () => {
  for (const token of [undefined, '', 'too-short']) {
    test(`ADMIN_TOKEN ${JSON.stringify(token)}: admin routes answer 404`, async () => {
      env = { ...env, ADMIN_TOKEN: token };
      for (const auth of ['Bearer undefined', 'Bearer ', null, `Bearer ${token}`]) {
        expect((await admin('/api/admin/removals', { auth })).status).toBe(404);
        expect((await admin('/api/admin/removed/1/restore', { auth, body: {} })).status).toBe(404);
      }
    });
  }

  test('a wrong token gets 401, and repeated failures from one IP hit the cap', async () => {
    expect((await admin('/api/admin/removals', { auth: 'Bearer wrong' })).status).toBe(401);
    expect((await admin('/api/admin/removals', { auth: null })).status).toBe(401);
    for (let i = 0; i < 8; i++) await admin('/api/admin/removals', { auth: `Bearer ${TOKEN}x` });
    expect((await admin('/api/admin/removals', { auth: 'Bearer wrong' })).status).toBe(429);
    expect((await admin('/api/admin/removals')).status).toBe(429); // even the right token, from that IP, today
    expect((await admin('/api/admin/removals', { ip: '8.8.8.8' })).status).toBe(200);
  });

  test('admin routes carry no CORS headers', async () => {
    const res = await app.request('/api/admin/removals', { headers: { origin: 'chrome-extension://abcdefghijklmnop', authorization: `Bearer ${TOKEN}` } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await app.request('/api/admin/removals', { method: 'OPTIONS', headers: { origin: 'chrome-extension://abcdefghijklmnop', 'access-control-request-method': 'GET' } }, env);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    // The extension's routes still get them.
    const pub = await app.request('/api/leaderboard', { headers: { origin: 'chrome-extension://abcdefghijklmnop' } }, env);
    expect(pub.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdefghijklmnop');
  });
});

describe('GET /api/admin/removals', () => {
  test('groups pending requests by member, with stored slugs, level, signals and counts by stance', async () => {
    await report(KEY_B, 'report', '2.2.2.2');
    await report(KEY_C, 'vouch', '3.3.3.3');
    // A slug in the request is never shown: only the slugs the server stored.
    expect((await request({ memberId: MEMBER, code: CODE, slug: 'attacker-chosen', contact: 'me@example.test' })).status).toBe(201);
    expect((await ask(KEY_B, '2.2.2.2')).status).toBe(201);
    const body = await list();
    expect(body.members).toHaveLength(1);
    const m = body.members[0];
    expect(m.memberId).toBe(MEMBER);
    expect(m.slugs).toEqual(['jordan-sample-0a1b2c']);
    expect(m.counts).toEqual({ reports: 1, impersonated: 0, vouches: 1 });
    expect(['low', 'medium', 'high']).toContain(m.score.level);
    expect(m.score.signals).toBeArray();
    expect(m.requests).toHaveLength(2);
    expect(m.requests[0]).toMatchObject({ code: CODE, contact: 'me@example.test' });
    expect(JSON.stringify(body)).not.toContain('attacker-chosen');
  });
});

describe('approve', () => {
  test('with a member ID that does not match the request: 400, nothing deleted', async () => {
    const id = await filed();
    const res = await approve(id, OTHER);
    expect(res.status).toBe(400);
    expect(await rows('SELECT member_id FROM accounts')).toHaveLength(1);
    expect((await requestRow(id)).status).toBe('pending');
    expect(await rows('SELECT * FROM removed_members')).toEqual([]);
  });

  test('deletes every D1 row and R2 object of the member, blocks it, and clears the contact', async () => {
    await save(MEMBER, { firstName: 'Jordy', slug: 'jordan-renamed', capturedAt: Date.now() - 1000 });
    await save(OTHER, { firstName: 'Sam', slug: 'sam-sample' });
    await report(KEY_B, 'report', '2.2.2.2');
    await report(KEY_C, 'impersonated', '3.3.3.3');
    await report(KEY_B, 'report', '2.2.2.2', OTHER);
    const id = await filed(KEY_A, '1.1.1.1', 'reach-me@example.test');
    const before = [...env.SNAPSHOTS.objects.keys()].filter((k) => k.startsWith(`snapshots/${MEMBER}/`));
    expect(before.length).toBeGreaterThan(0);

    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'approved' });

    for (const t of ['accounts', 'account_current', 'account_snapshots', 'account_slugs']) {
      expect(await rows(`SELECT * FROM ${t} WHERE member_id = ?`, MEMBER)).toEqual([]);
    }
    expect(await rows(`SELECT * FROM reports WHERE target_id = ?`, String(MEMBER))).toEqual([]);
    expect([...env.SNAPSHOTS.objects.keys()].filter((k) => k.startsWith(`snapshots/${MEMBER}/`))).toEqual([]);
    expect([...env.SNAPSHOTS.objects.keys()].some((k) => k.startsWith(`snapshots/${OTHER}/`))).toBe(true);
    const r = await requestRow(id);
    expect(r).toMatchObject({ status: 'approved', contact: null });
    expect(await rows('SELECT member_id, request_id FROM removed_members')).toEqual([{ member_id: MEMBER, request_id: id }]);

    // A body search of the public routes finds nothing of the member.
    for (const path of ['/api/leaderboard', `/api/accounts/${MEMBER}`, '/api/accounts?slug=jordan-sample-0a1b2c', '/api/accounts?slug=jordan-renamed']) {
      const text = await (await app.request(path, {}, env)).text();
      for (const needle of [String(MEMBER), 'jordan-sample', 'jordan-renamed', 'Jordy']) expect(text).not.toContain(needle);
    }
    expect((await app.request(`/api/accounts/${MEMBER}`, {}, env)).status).toBe(404);
    expect((await app.request('/api/accounts?slug=jordan-renamed', {}, env)).status).toBe(404);
    // The other profile is untouched.
    expect((await app.request(`/api/accounts/${OTHER}`, {}, env)).status).toBe(200);

    const log = await rows('SELECT * FROM removal_log');
    expect(log).toMatchObject([{ request_id: id, member_id: MEMBER, action: 'approve' }]);
    expect(JSON.stringify(log)).not.toContain('reach-me');
  });

  test('more than 1000 R2 keys under the member are all deleted', async () => {
    for (let i = 0; i < 2345; i++) env.SNAPSHOTS.objects.set(`snapshots/${MEMBER}/extra-${String(i).padStart(5, '0')}.json.gz`, { body: new Uint8Array(), options: {} });
    env.SNAPSHOTS.objects.set(`snapshots/${MEMBER}0/not-this-member.json.gz`, { body: new Uint8Array(), options: {} });
    const id = await filed();
    expect((await approve(id)).status).toBe(200);
    expect([...env.SNAPSHOTS.objects.keys()].filter((k) => k.startsWith(`snapshots/${MEMBER}/`))).toEqual([]);
    expect(env.SNAPSHOTS.objects.has(`snapshots/${MEMBER}0/not-this-member.json.gz`)).toBe(true);
  });

  test('an R2 delete that throws leaves approved_r2_pending; re-running approve finishes it', async () => {
    const id = await filed();
    const realDelete = env.SNAPSHOTS.delete;
    env.SNAPSHOTS.delete = async () => {
      throw new Error('R2 unavailable');
    };
    const res = await approve(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, status: 'approved_r2_pending' });
    expect((await requestRow(id)).status).toBe('approved_r2_pending');
    expect(await rows('SELECT * FROM accounts WHERE member_id = ?', MEMBER)).toEqual([]);
    expect((await list()).unfinished).toEqual([{ requestId: id, memberId: MEMBER }]);

    env.SNAPSHOTS.delete = realDelete;
    const again = await approve(id);
    expect(again.status).toBe(200);
    expect((await requestRow(id)).status).toBe('approved');
    expect([...env.SNAPSHOTS.objects.keys()].filter((k) => k.startsWith(`snapshots/${MEMBER}/`))).toEqual([]);
    expect(await rows("SELECT action FROM removal_log")).toEqual([{ action: 'approve' }]);
  });

  test('an upload that passed the route check before approval and commits after it leaves no D1 rows; the list sweeps its R2 orphan', async () => {
    const id = await filed();
    const realPut = env.SNAPSHOTS.put.bind(env.SNAPSHOTS);
    let approved = false;
    env.SNAPSHOTS.put = (async (key: string, body: Uint8Array, options: unknown) => {
      if (!approved) {
        approved = true;
        expect((await approve(id)).status).toBe(200); // lands after the upload's checks, before its archive write and D1 commit
      }
      return realPut(key, body, options as any);
    }) as typeof env.SNAPSHOTS.put;
    const res = await save(MEMBER, { firstName: 'Late', capturedAt: Date.now() + 1 });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'removed' });
    for (const t of ['accounts', 'account_current', 'account_snapshots', 'account_slugs']) {
      expect(await rows(`SELECT * FROM ${t} WHERE member_id = ?`, MEMBER)).toEqual([]);
    }
    expect([...env.SNAPSHOTS.objects.keys()].filter((k) => k.startsWith(`snapshots/${MEMBER}/`))).toHaveLength(1);
    await list();
    expect([...env.SNAPSHOTS.objects.keys()].filter((k) => k.startsWith(`snapshots/${MEMBER}/`))).toEqual([]);
  });

  test('a backfill that commits after approval leaves no D1 rows', async () => {
    const { createAccountStore } = await import('../src/accounts-store');
    const id = await filed();
    await approve(id);
    const { extractProfileFacts, scoreProfile } = await import('@fpr/core');
    const raw = fakeSnapshot({ memberId: MEMBER });
    const facts = extractProfileFacts(raw, raw.capturedAt ?? Date.now());
    const store = createAccountStore(env.DB);
    const write = { observed: { ...facts, memberId: MEMBER }, score: scoreProfile(facts, 1), changes: [], r2Key: 'k', capturedAt: 1, ipHash: 'h' };
    await store.commitBackfill(write);
    expect(await store.commitNewest(write, null, { facts, score: scoreProfile(facts, 1) })).toBe(false);
    for (const t of ['accounts', 'account_current', 'account_snapshots', 'account_slugs']) {
      expect(await rows(`SELECT * FROM ${t} WHERE member_id = ?`, MEMBER)).toEqual([]);
    }
  });

  test('after approval, saves and reports of the member get 410 removed, and reads 404', async () => {
    const id = await filed();
    await approve(id);
    const s = await save();
    expect(s.status).toBe(410);
    expect(await s.json()).toEqual({ error: 'removed' });
    const r = await report(KEY_B);
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: 'removed' });
    expect((await app.request(`/api/accounts/${MEMBER}`, {}, env)).status).toBe(404);
    expect((await ask(KEY_B, '2.2.2.2')).status).toBe(404); // nothing stored to remove
  });

  test('approving one request settles every pending request for the member', async () => {
    const a = await filed(KEY_A, '1.1.1.1', 'a@example.test');
    const b = await filed(KEY_B, '2.2.2.2', 'b@example.test');
    expect((await approve(a)).status).toBe(200);
    expect(await requestRow(b)).toMatchObject({ status: 'approved', contact: null });
    expect((await list()).members).toEqual([]);
  });

  test('a decided request cannot be approved', async () => {
    const id = await filed();
    await deny(id, 'merits');
    expect((await approve(id)).status).toBe(409);
    expect(await rows('SELECT member_id FROM accounts')).toHaveLength(1);
    expect((await approve(999)).status).toBe(404);
  });

  test('on the old schema plus 0001, with an account_reports row for the member, succeeds and the row is gone', async () => {
    const dir = join(import.meta.dir, '..');
    env = makeEnv(createTestD1([readFileSync(join(dir, 'test/schema-2026.11.23.1.sql'), 'utf8'), readFileSync(join(dir, 'migrations/0001-additive.sql'), 'utf8')]));
    expect((await save()).status).toBe(201);
    await env.DB.prepare("INSERT INTO account_reports (member_id, score, ip_hash, created_at) VALUES (?, 40, 'h', 1)").bind(MEMBER).run();
    const id = await filed();
    const res = await approve(id);
    expect(res.status).toBe(200);
    expect(await rows('SELECT * FROM account_reports')).toEqual([]);
    expect(await rows('SELECT * FROM accounts')).toEqual([]);
  });
});

describe('deny and restore', () => {
  test('deny leaves the profile untouched, clears the contact and logs without it', async () => {
    const id = await filed(KEY_A, '1.1.1.1', 'reach-me@example.test');
    const res = await deny(id, 'merits');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'denied_merits' });
    expect((await app.request(`/api/accounts/${MEMBER}`, {}, env)).status).toBe(200);
    expect(await requestRow(id)).toMatchObject({ status: 'denied_merits', contact: null });
    const log = await rows('SELECT * FROM removal_log');
    expect(log).toMatchObject([{ request_id: id, member_id: MEMBER, action: 'deny_merits' }]);
    expect(JSON.stringify(log)).not.toContain('reach-me');
    expect((await admin(`/api/admin/removals/${id}/deny`, { body: { reason: 'nope' } })).status).toBe(400);
    expect((await deny(id, 'code')).status).toBe(409);
  });

  test('restore lifts the block; a new snapshot is accepted, and deleted data stays deleted', async () => {
    await report(KEY_B);
    const id = await filed();
    await approve(id);
    expect((await restore()).status).toBe(200);
    expect(await rows('SELECT * FROM removed_members')).toEqual([]);
    expect((await requestRow(id)).status).toBe('restored');
    expect((await rows('SELECT action, request_id FROM removal_log ORDER BY id')).map((r: any) => [r.action, r.request_id])).toEqual([['approve', id], ['restore', null]]);
    expect((await save()).status).toBe(201);
    expect(((await (await app.request(`/api/accounts/${MEMBER}`, {}, env)).json()) as any).counts.reports).toBe(0);
    expect((await restore()).status).toBe(404); // not removed any more
  });
});

describe('scheduled retention', () => {
  test('clears contacts pending over 90 days, deletes requests decided over 90 days ago, and expired bot-check and counter rows', async () => {
    const now = Date.now();
    const ins = (status: string, created: number, decided: number | null, contact: string | null) =>
      env.DB.prepare('INSERT INTO removal_requests (member_id, reporter, ip_hash, code, contact, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .bind(MEMBER, 'r', 'i', 'c', contact, status, created, decided)
        .first<{ id: number }>()
        .then((r) => r!.id);
    const oldPending = await ins('pending', now - 91 * DAY, null, 'old@example.test');
    const newPending = await ins('pending', now - 10 * DAY, null, 'new@example.test');
    const oldDecided = await ins('denied_code', now - 200 * DAY, now - 91 * DAY, null);
    const newDecided = await ins('denied_merits', now - 30 * DAY, now - 10 * DAY, null);
    const stuck = await ins('approved_r2_pending', now - 200 * DAY, now - 91 * DAY, null);
    await env.DB.prepare('INSERT INTO verify_challenges (id, reporter, created_at, expires_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)').bind('a'.repeat(32), 'r', now - 2, now - 1, 'b'.repeat(32), 'r', now, now + 60_000).run();
    await env.DB.prepare('INSERT INTO verified_reporters (reporter, verified_at, expires_at) VALUES (?, ?, ?), (?, ?, ?)').bind('old', 0, now - 1, 'new', now, now + DAY).run();
    await env.DB.prepare("INSERT INTO daily_counts (scope, subject, day, count) VALUES ('x', 's', '2000-01-01', 1), ('x', 's', ?, 1)").bind(new Date(now).toISOString().slice(0, 10)).run();

    await app.scheduled({ scheduledTime: now, cron: '17 3 * * *', noRetry() {} } as ScheduledController, env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);

    expect((await rows('SELECT id, contact FROM removal_requests ORDER BY id')).map((r: any) => [r.id, r.contact])).toEqual([
      [oldPending, null],
      [newPending, 'new@example.test'],
      [newDecided, null],
      [stuck, null],
    ]);
    expect(oldDecided).toBeNumber();
    expect((await rows<{ id: string }>('SELECT id FROM verify_challenges')).map((r) => r.id)).toEqual(['b'.repeat(32)]);
    expect((await rows<{ reporter: string }>('SELECT reporter FROM verified_reporters')).map((r) => r.reporter)).toEqual(['new']);
    expect(await rows('SELECT day FROM daily_counts')).toEqual([{ day: new Date(now).toISOString().slice(0, 10) }]);
  });
});
