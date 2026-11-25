import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { fakeSnapshot } from '@fpr/core/test/fixtures';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

const HOST = 'api.example.test';
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);
const PARENT = 'chrome-extension://abcdefghijklmnop';
const MEMBER = 700_000_001;
const report = { stance: 'report', reasons: ['fake-applicant'] };

let env: Env;
let siteverify: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
/** What the mocked Siteverify answers; `cdata` defaults to the challenge in the request. */
let answer: Record<string, unknown>;

beforeEach(async () => {
  env = { DB: createTestD1(), RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test', VERIFY_HOST: HOST, TURNSTILE_SITEKEY: '1x00000000000000000000AA', TURNSTILE_SECRET: 'test-secret' };
  answer = { success: true, hostname: HOST, action: 'register' };
  const realFetch = globalThis.fetch;
  siteverify = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return realFetch(input, init);
    const sent = JSON.parse(String(init?.body));
    await Bun.sleep(1);
    return Response.json({ cdata: challengeOf(sent), ...answer });
  }) as typeof fetch);
  await app.request('/api/snapshots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fakeSnapshot({ memberId: MEMBER })) }, env);
});

afterEach(() => {
  siteverify.mockRestore();
  setSystemTime();
});

// The mock echoes back the cData the widget would have carried: tests pass it as the token.
const challengeOf = (sent: { response: string }) => sent.response.replace(/^token-/, '');
const siteverifyCalls = () => siteverify.mock.calls.filter(([u]) => String(u).includes('siteverify')).length;

function put(key: string | null = KEY_A, body: unknown = report) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': '1.1.1.1' };
  if (key) headers['x-reporter-key'] = key;
  return app.request(`/api/reports/profile/${MEMBER}`, { method: 'PUT', headers, body: JSON.stringify(body) }, env);
}

function verify(challenge: string, key: string | null = KEY_A, token = `token-${challenge}`, ip = '1.1.1.1') {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
  if (key) headers['x-reporter-key'] = key;
  return app.request('/api/verify', { method: 'POST', headers, body: JSON.stringify({ token, challenge }) }, env);
}

/** A fresh challenge for `key`, from a gated PUT. */
async function challengeFor(key = KEY_A) {
  const res = await put(key);
  expect(res.status).toBe(403);
  const body = (await res.json()) as any;
  return new URL(body.verifyUrl).searchParams.get('challenge')!;
}

const verifiedRows = async () => (await env.DB.prepare('SELECT reporter FROM verified_reporters').all()).results.length;

describe('the gate', () => {
  test('a fresh key gets verification_required with a verifyUrl on the Worker host and no key material', async () => {
    const res = await put();
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe('verification_required');
    const url = new URL(body.verifyUrl);
    expect(url.origin).toBe(`https://${HOST}`);
    expect(url.pathname).toBe('/verify');
    expect(url.searchParams.get('challenge')).toMatch(/^[0-9a-f]{32}$/);
    expect(body.verifyUrl).not.toContain(KEY_A);
    const reporterHashes = (await env.DB.prepare('SELECT reporter FROM verify_challenges').all<{ reporter: string }>()).results.map((r) => r.reporter);
    for (const h of reporterHashes) expect(body.verifyUrl).not.toContain(h);
  });

  test('after a passing check the report sends (AE5)', async () => {
    const challenge = await challengeFor();
    const v = await verify(challenge);
    expect(v.status).toBe(200);
    expect(((await v.json()) as any).ok).toBe(true);
    expect((await put()).status).toBe(200);
  });

  test('a verified row older than 90 days asks again', async () => {
    await verify(await challengeFor());
    setSystemTime(new Date(Date.now() + 91 * 86_400_000));
    expect(((await (await put()).json()) as any).error).toBe('verification_required');
  });

  test('withdrawing never needs the check', async () => {
    await verify(await challengeFor());
    expect((await put()).status).toBe(200);
    await env.DB.prepare('DELETE FROM verified_reporters').run();
    const res = await app.request(`/api/reports/profile/${MEMBER}`, { method: 'DELETE', headers: { 'x-reporter-key': KEY_A } }, env);
    expect(res.status).toBe(200);
  });

  test('the key in the body instead of the header is refused', async () => {
    expect((await put(null, { ...report, reporterKey: KEY_A })).status).toBe(401);
  });

  test('VERIFY_HOST unset: no check, and no verify routes', async () => {
    env = { ...env, VERIFY_HOST: undefined };
    expect((await put()).status).toBe(200);
    expect((await app.request(`/verify?challenge=${'0'.repeat(32)}&parentOrigin=${PARENT}`, {}, env)).status).toBe(404);
    expect((await verify('0'.repeat(32))).status).toBe(404);
    expect((await app.request('/api/verify/status', { headers: { 'x-reporter-key': KEY_A } }, env)).status).toBe(404);
  });

  test('VERIFY_HOST set but a secret missing: reports are refused, not accepted unchecked', async () => {
    env = { ...env, TURNSTILE_SECRET: undefined };
    const res = await put();
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe('verify_unconfigured');
    env = { ...env, TURNSTILE_SECRET: 'x', TURNSTILE_SITEKEY: undefined };
    expect((await put()).status).toBe(503);
  });
});

describe('POST /api/verify', () => {
  test("another reporter's challenge fails, with no verified row", async () => {
    const challenge = await challengeFor(KEY_A);
    const res = await verify(challenge, KEY_B);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toBe('verify_failed');
    expect(await verifiedRows()).toBe(0);
  });

  test('an expired challenge fails', async () => {
    const challenge = await challengeFor();
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect((await verify(challenge)).status).toBe(403);
    expect(await verifiedRows()).toBe(0);
  });

  test('a wrong hostname or action fails', async () => {
    answer = { success: true, hostname: 'evil.example', action: 'register' };
    expect((await verify(await challengeFor())).status).toBe(403);
    answer = { success: true, hostname: HOST, action: 'login' };
    expect((await verify(await challengeFor())).status).toBe(403);
    answer = { success: false, hostname: HOST, action: 'register' };
    expect((await verify(await challengeFor())).status).toBe(403);
    expect(await verifiedRows()).toBe(0);
  });

  test('cdata must be this challenge', async () => {
    const challenge = await challengeFor();
    const other = await challengeFor();
    expect((await verify(challenge, KEY_A, `token-${other}`)).status).toBe(403);
  });

  test('the same challenge used twice in parallel reaches Siteverify once', async () => {
    const challenge = await challengeFor();
    const results = await Promise.all([verify(challenge), verify(challenge)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(siteverifyCalls()).toBe(1);
  });

  test('attempts per IP are capped at 20 a day', async () => {
    for (let i = 0; i < 20; i++) expect((await verify('f'.repeat(32), KEY_A, 'token-x', '9.9.9.9')).status).toBe(403);
    expect((await verify(await challengeFor(), KEY_A, undefined, '9.9.9.9')).status).toBe(429);
  });

  test('a body that is not JSON is refused', async () => {
    const res = await app.request('/api/verify', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token: 't', challenge: '0'.repeat(32) }) }, env);
    expect(res.status).toBe(415);
  });

  test('tab mode: no key verifies the reporter the challenge was issued to', async () => {
    const challenge = await challengeFor(KEY_A);
    expect((await verify(challenge, null)).status).toBe(200);
    expect((await put(KEY_A)).status).toBe(200);
    expect(((await (await put(KEY_B)).json()) as any).error).toBe('verification_required');
  });

  test('tab mode: an expired challenge fails', async () => {
    const challenge = await challengeFor();
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    expect((await verify(challenge, null)).status).toBe(403);
  });

  test('the status route reports whether this key is verified', async () => {
    const status = async () => (await (await app.request('/api/verify/status', { headers: { 'x-reporter-key': KEY_A } }, env)).json()) as any;
    expect(await status()).toEqual({ verified: false, verifiedUntil: null });
    await verify(await challengeFor(), null);
    const s = await status();
    expect(s.verified).toBe(true);
    expect(s.verifiedUntil).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    expect((await app.request('/api/verify/status', {}, env)).status).toBe(401);
  });
});

describe('GET /verify', () => {
  const page = (query: string) => app.request(`/verify?${query}`, {}, env);
  const ID = '0123456789abcdef0123456789abcdef';

  test('a malformed challenge or parentOrigin is a 400', async () => {
    expect((await page(`challenge=nope&parentOrigin=${PARENT}`)).status).toBe(400);
    expect((await page(`challenge=${ID}&parentOrigin=https://evil.example`)).status).toBe(400);
    expect((await page(`challenge=${ID}`)).status).toBe(400);
    expect((await page(`challenge=${ID}&parentOrigin=${encodeURIComponent('chrome-extension://x"><script>')}`)).status).toBe(400);
  });

  test('a valid one serves the widget page with a nonce CSP that only extensions may frame', async () => {
    const res = await page(`challenge=${ID}&parentOrigin=${PARENT}&junk=${encodeURIComponent('<script>alert(1)</script>')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-ancestors chrome-extension: moz-extension: safari-web-extension:');
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).not.toContain('connect-src');
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain(ID);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('junk');
  });

  test('tab mode needs no parentOrigin and may post to its own origin', async () => {
    const res = await page(`challenge=${ID}&mode=tab`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });
});
