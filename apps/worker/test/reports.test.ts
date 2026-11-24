import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { CompanyFacts } from '@fpr/core';
import { fakeSnapshot } from '@fpr/core/test/fixtures';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

let env: Env;
beforeEach(() => {
  env = { DB: createTestD1(), RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test' };
});

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const KEY_C = 'c'.repeat(40);

const saveProfile = (memberId: number, firstName = 'Alex') =>
  app.request('/api/snapshots', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.0.0.${memberId % 200}` }, body: JSON.stringify(fakeSnapshot({ memberId, firstName })) }, env);

const company = (): CompanyFacts => ({
  companyId: 4242,
  slug: 'example-brand-careers',
  name: 'Example Brand Careers',
  tagline: null,
  industry: 'Software Development',
  headquarters: null,
  type: 'Privately Held',
  foundedYear: 2001,
  claimedSize: { min: 1001, max: 5000, label: '1,001-5,000 employees' },
  employeesOnLinkedIn: 2,
  followers: 12,
  website: null,
  specialties: [],
  logo: { present: false, uploadedAt: null },
  logoUrl: null,
  posts: { count: 0, newestAt: null },
});

function put(kind: string, id: string | number, body: unknown, key: string | null = KEY_A, ip = '1.1.1.1') {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
  if (key) headers['x-reporter-key'] = key;
  return app.request(`/api/reports/${kind}/${id}`, { method: 'PUT', headers, body: JSON.stringify(body) }, env);
}
const withdraw = (kind: string, id: string | number, key = KEY_A) =>
  app.request(`/api/reports/${kind}/${id}`, { method: 'DELETE', headers: { 'x-reporter-key': key, 'cf-connecting-ip': '1.1.1.1' } }, env);

const suspicious = { stance: 'report', reasons: ['fake-applicant'], confidence: 'suspected', note: 'Camera off the whole call.' };
const board = async () => (await (await app.request('/api/leaderboard', {}, env)).json()) as any;
const account = async (id: number) => (await (await app.request(`/api/accounts/${id}`, {}, env)).json()) as any;

describe('PUT /api/reports', () => {
  test('reports a saved profile, and the leaderboard ranks it', async () => {
    await saveProfile(700_000_001);
    await saveProfile(700_000_002, 'Sam');
    const res = await put('profile', 700_000_001, suspicious);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ ok: true, kind: 'profile', id: '700000001', stance: 'report', reasons: ['fake-applicant'], confidence: 'suspected' });
    expect(body.counts).toEqual({ reports: 1, impersonated: 0, vouches: 0 });
    await put('profile', 700_000_002, suspicious, KEY_A);
    await put('profile', 700_000_002, suspicious, KEY_B, '2.2.2.2');
    const b = await board();
    expect(b.stats).toEqual({ reports: 3, accounts: 2 });
    expect(b.rows.map((r: any) => [r.memberId, r.reports])).toEqual([[700_000_002, 2], [700_000_001, 1]]);
    expect(b.rows[0]).toMatchObject({ name: 'Sam Sample', impersonated: 0, vouches: 0 });
  });

  test('one report per reporter: reporting again edits it, keeping when it was first made', async () => {
    await saveProfile(700_000_001);
    const first = (await (await put('profile', 700_000_001, suspicious)).json()) as any;
    await Bun.sleep(5);
    const edited = (await (await put('profile', 700_000_001, { stance: 'report', reasons: ['asked-money', 'off-platform'], confidence: 'confirmed' })).json()) as any;
    expect(edited).toMatchObject({ reasons: ['asked-money', 'off-platform'], confidence: 'confirmed', createdAt: first.createdAt });
    expect(edited.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(edited.counts.reports).toBe(1);
  });

  test('withdrawing removes it from the counts; reporting again brings it back', async () => {
    await saveProfile(700_000_001);
    await put('profile', 700_000_001, suspicious);
    const res = await withdraw('profile', 700_000_001);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).counts).toEqual({ reports: 0, impersonated: 0, vouches: 0 });
    expect((await board()).rows).toEqual([]);
    expect((await account(700_000_001)).counts.reports).toBe(0);
    expect((await withdraw('profile', 700_000_001)).status).toBe(404); // nothing active left
    expect((await withdraw('profile', 700_000_001, KEY_B)).status).toBe(404); // someone else's key
    const again = (await (await put('profile', 700_000_001, suspicious)).json()) as any;
    expect(again.counts.reports).toBe(1);
  });

  test('only the key that made a report can change it', async () => {
    await saveProfile(700_000_001);
    await put('profile', 700_000_001, suspicious, KEY_A);
    await put('profile', 700_000_001, { stance: 'vouch', reasons: ['know-personally'] }, KEY_B, '2.2.2.2');
    const got = await account(700_000_001);
    expect(got.counts).toEqual({ reports: 1, impersonated: 0, vouches: 1 });
  });

  test('"someone used this identity" is a warning, never a report against the owner', async () => {
    await saveProfile(700_000_001);
    await put('profile', 700_000_001, { stance: 'impersonated', reasons: ['contacted-me'] }, KEY_A);
    await put('profile', 700_000_001, { stance: 'vouch', reasons: ['worked-together'] }, KEY_B, '2.2.2.2');
    expect((await board()).rows).toEqual([]); // not on the leaderboard
    expect((await board()).stats.reports).toBe(0);
    expect((await account(700_000_001)).counts).toEqual({ reports: 0, impersonated: 1, vouches: 1 });
    // Shown alongside reports when the profile is also reported.
    await put('profile', 700_000_001, suspicious, KEY_C, '3.3.3.3');
    expect((await board()).rows[0]).toMatchObject({ reports: 1, impersonated: 1, vouches: 1 });
  });

  test('works for companies and jobs, which can be reported or vouched for but not "impersonated"', async () => {
    await app.request('/api/entities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'company', id: '4242', facts: company() }) }, env);
    expect((await put('company', '4242', { stance: 'report', reasons: ['fake-recruiter'] })).status).toBe(200);
    expect((await put('company', '4242', { stance: 'impersonated', reasons: ['contacted-me'] }, KEY_B)).status).toBe(400);
    const got = (await (await app.request('/api/entities/company/4242', {}, env)).json()) as any;
    expect(got.counts).toEqual({ reports: 1, impersonated: 0, vouches: 0 });
  });

  test('notes are stored but never returned', async () => {
    await saveProfile(700_000_001);
    const put1 = await (await put('profile', 700_000_001, suspicious)).text();
    expect(put1).not.toContain('Camera off');
    for (const path of ['/api/accounts/700000001', '/api/leaderboard']) {
      expect(await (await app.request(path, {}, env)).text()).not.toContain('Camera off');
    }
    const row = await env.DB.prepare('SELECT note, score_json FROM reports').first<{ note: string; score_json: string }>();
    expect(row?.note).toBe('Camera off the whole call.');
    expect(JSON.parse(row!.score_json).signals).toBeArray(); // the score when reported, for building heuristics
  });

  test('requires a reporter key, a saved target, and choices from the lists', async () => {
    await saveProfile(700_000_001);
    expect((await put('profile', 700_000_001, suspicious, null)).status).toBe(401);
    expect((await put('profile', 700_000_001, suspicious, 'short')).status).toBe(401);
    expect((await put('profile', 700_000_999, suspicious)).status).toBe(404); // never saved
    expect((await put('person', 1, suspicious)).status).toBe(400);
    expect((await put('profile', 'abc', suspicious)).status).toBe(400);
    for (const bad of [
      { stance: 'banana', reasons: ['other'] },
      { stance: 'report', reasons: [] },
      { stance: 'report', reasons: ['made-up'] },
      { stance: 'vouch', reasons: ['fake-applicant'] }, // a report reason on a vouch
      { stance: 'report', reasons: ['other'], confidence: 'certain' },
      { stance: 'report', reasons: ['other'], note: 42 },
    ]) {
      expect((await put('profile', 700_000_001, bad)).status).toBe(400);
    }
    const r = await app.request('/api/reports/profile/700000001', { method: 'PUT', headers: { 'x-reporter-key': KEY_A }, body: '{nope' }, env);
    expect(r.status).toBe(400);
  });

  test('long notes are trimmed and capped', async () => {
    await saveProfile(700_000_001);
    await put('profile', 700_000_001, { ...suspicious, note: `  ${'x'.repeat(900)}  ` });
    const row = await env.DB.prepare('SELECT note FROM reports').first<{ note: string }>();
    expect(row?.note).toHaveLength(500);
  });

  test('CORS lets the extension send reports and withdrawals', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const pre = await app.request(
        '/api/reports/profile/1',
        { method: 'OPTIONS', headers: { origin: 'chrome-extension://abcdefghijklmnop', 'access-control-request-method': method, 'access-control-request-headers': 'content-type,x-reporter-key' } },
        env,
      );
      expect(pre.headers.get('access-control-allow-methods')).toContain(method);
      expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-reporter-key');
    }
  });
});

describe('daily report caps', () => {
  afterEach(() => setSystemTime());
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`.padEnd(40, 'x'));
  const statuses = async (reqs: Array<Response | Promise<Response>>) => {
    const res = await Promise.all(reqs);
    const bodies = (await Promise.all(res.map((r) => r.json()))) as any[];
    return { ok: res.filter((r) => r.status === 200).length, limited: bodies.filter((b) => b.error === 'daily_limit_reached').length };
  };

  test('60 reports at once from one key, with a cap of 50 a day: exactly 50 count', async () => {
    await saveProfile(700_000_001);
    const got = await statuses(Array.from({ length: 60 }, () => put('profile', 700_000_001, suspicious, KEY_A)));
    expect(got).toEqual({ ok: 50, limited: 10 });
  });

  test('205 reports at once from one IP across keys, with a cap of 200 a day: exactly 200 count', async () => {
    await saveProfile(700_000_001);
    const got = await statuses(keys(5).flatMap((k) => Array.from({ length: 41 }, () => put('profile', 700_000_001, suspicious, k))));
    expect(got).toEqual({ ok: 200, limited: 5 });
  });

  test('withdrawing still works past the cap, and is not counted', async () => {
    await saveProfile(700_000_001);
    for (let i = 0; i < 50; i++) await put('profile', 700_000_001, suspicious, KEY_A);
    expect((await put('profile', 700_000_001, suspicious, KEY_A)).status).toBe(429);
    expect((await withdraw('profile', 700_000_001, KEY_A)).status).toBe(200);
  });

  test("yesterday's counts don't count today, and are deleted on today's first report", async () => {
    await saveProfile(700_000_001);
    setSystemTime(new Date(Date.UTC(2026, 10, 23, 12)));
    for (let i = 0; i < 51; i++) await put('profile', 700_000_001, suspicious, KEY_A);
    expect((await put('profile', 700_000_001, suspicious, KEY_A)).status).toBe(429);
    setSystemTime(new Date(Date.UTC(2026, 10, 24, 0, 0, 1)));
    expect((await put('profile', 700_000_001, suspicious, KEY_A)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM daily_counts WHERE day < '2026-11-24'").first()).toEqual({ n: 0 });
  });
});
