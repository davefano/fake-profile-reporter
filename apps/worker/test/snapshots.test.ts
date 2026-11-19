import { beforeEach, describe, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fakeSnapshot } from '@flr/core/test/fixtures';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

let env: Env & { SNAPSHOTS: ReturnType<typeof createTestR2> };

beforeEach(() => {
  env = { DB: createTestD1(), RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test' };
});

function post(body: unknown, { gzip = false, ip = '1.1.1.1' } = {}) {
  const json = JSON.stringify(body);
  return app.request(
    '/api/snapshots',
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

    const acct = (await (await app.request('/api/accounts/700000001', {}, env)).json()) as any;
    expect(acct.account.joined_source).toBe('about');
    expect(acct.account.connections).toBe(500);
    expect(acct.account.connections_capped).toBe(1);
    expect(acct.account.verified).toBe(0);
    expect(acct.account.snapshot_count).toBe(1);
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

    const byOldSlug = (await (await app.request('/api/accounts?slug=FIRST-SLUG', {}, env)).json()) as any;
    expect(byOldSlug.account.slug).toBe('second-slug');
    expect(byOldSlug.slugs.map((s: any) => s.slug)).toEqual(['first-slug', 'second-slug']);
    expect(byOldSlug.account.snapshot_count).toBe(2);
    expect(byOldSlug.snapshots[0].changes).toHaveLength(2);
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
});

test('GET /api/accounts 404s for unknown accounts', async () => {
  expect((await app.request('/api/accounts/123', {}, env)).status).toBe(404);
  expect((await app.request('/api/accounts?slug=nobody', {}, env)).status).toBe(404);
  expect((await app.request('/api/accounts', {}, env)).status).toBe(400);
});
