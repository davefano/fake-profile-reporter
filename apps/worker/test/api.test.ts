import { beforeEach, describe, expect, test } from 'bun:test';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

let env: Env;

beforeEach(() => {
  env = { DB: createTestD1(), RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test' };
});

function report(body: unknown, ip = '1.1.1.1') {
  return app.request(
    '/api/report',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('POST /api/report', () => {
  test('stores a report and grades it server-side', async () => {
    const res = await report({ url: 'linkedin.com/in/Jane-Doe/', profile: { name: 'Jane', headline: 'Web3 guru' } });
    expect(res.status).toBe(201);
    const data = (await res.json()) as any;
    expect(data.url).toBe('https://www.linkedin.com/in/jane-doe');
    expect(data.grader.score).toBeGreaterThan(0);
  });

  test('rejects non-profile URLs and bad JSON', async () => {
    expect((await report({ url: 'https://example.com/in/x' })).status).toBe(400);
    const bad = await app.request('/api/report', { method: 'POST', body: '{nope' }, env);
    expect(bad.status).toBe(400);
  });

  test('enforces the per-IP cooldown but allows other reporters', async () => {
    const body = { url: 'https://www.linkedin.com/in/jane', profile: {} };
    expect((await report(body)).status).toBe(201);
    const again = await report(body);
    expect(again.status).toBe(429);
    expect(((await again.json()) as any).error).toBe('already_reported_recently');
    expect((await report(body, '2.2.2.2')).status).toBe(201);
  });
});

test('leaderboard ranks by report count and fills profile fields', async () => {
  await report({ url: 'https://www.linkedin.com/in/a', profile: { name: 'A' } }, '1.1.1.1');
  await report({ url: 'https://www.linkedin.com/in/b', profile: { name: 'B' } }, '1.1.1.1');
  await report({ url: 'https://www.linkedin.com/in/b', profile: {} }, '2.2.2.2');

  const res = await app.request('/api/leaderboard', {}, env);
  const data = (await res.json()) as any;
  expect(data.stats).toEqual({ reports: 3, profiles: 2 });
  expect(data.rows.map((r: any) => [r.handle, r.reports, r.name])).toEqual([
    ['b', 2, 'B'],
    ['a', 1, 'A'],
  ]);
});

test('GET /api/profile returns reports or 404', async () => {
  await report({ url: 'https://www.linkedin.com/in/a', profile: { name: 'A' } });
  const ok = (await (await app.request('/api/profile?url=linkedin.com/in/a', {}, env)).json()) as any;
  expect(ok.name).toBe('A');
  expect(ok.reports).toHaveLength(1);
  expect((await app.request('/api/profile?url=linkedin.com/in/zzz', {}, env)).status).toBe(404);
});

test('unknown routes 404 and CORS preflight is allowed', async () => {
  expect((await app.request('/nope', {}, env)).status).toBe(404);
  const pre = await app.request('/api/report', { method: 'OPTIONS', headers: { origin: 'chrome-extension://x', 'access-control-request-method': 'POST' } }, env);
  expect(pre.status).toBe(204);
  expect(pre.headers.get('access-control-allow-origin')).toBe('*');
});
