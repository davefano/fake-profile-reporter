import { beforeEach, expect, test } from 'bun:test';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

let env: Env;

beforeEach(() => {
  env = { DB: createTestD1(), RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test' };
});

test('an empty leaderboard', async () => {
  const res = (await (await app.request('/api/leaderboard', {}, env)).json()) as any;
  expect(res).toEqual({ stats: { reports: 0, accounts: 0 }, rows: [] });
});

test('unknown routes 404 and CORS preflight is allowed', async () => {
  expect((await app.request('/nope', {}, env)).status).toBe(404);
  const pre = await app.request('/api/snapshots', { method: 'OPTIONS', headers: { origin: 'chrome-extension://x', 'access-control-request-method': 'POST' } }, env);
  expect(pre.status).toBe(204);
  expect(pre.headers.get('access-control-allow-origin')).toBe('*');
});

test('there is no public web page, only the API', async () => {
  expect((await app.request('/', {}, env)).status).toBe(404);
  expect((await app.request('/leaderboard', {}, env)).status).toBe(404);
});
