// The bot check: a reporter key passes Cloudflare Turnstile once per 90 days
// on this server before its reports (and removal requests) count.
//
//   GET  /verify?challenge=&parentOrigin=   the widget page, framed by the extension
//   GET  /verify?challenge=&mode=tab        the same page in a tab (Safari), posting itself
//   POST /api/verify                        VerifyRequest → VerifyResponse
//   GET  /api/verify/status                 VerifyStatusResponse for x-reporter-key
//
// A gated route calls requireVerified, which answers verification_required
// with a verifyUrl carrying a random challenge ID bound to the reporter hash
// for 10 minutes. The ID is the widget's cData, so neither the key nor its
// hash appears in URLs or in Turnstile. Verifying consumes the challenge in
// one statement, so it can't be used twice, and only then calls Siteverify.
//
// Off when VERIFY_HOST is unset: no route here exists and nothing is gated.
// VERIFY_HOST set without both Turnstile keys refuses gated routes (503)
// rather than accepting them unchecked.

import { Hono, type Context } from 'hono';
import { CHALLENGE_MS, type VerificationRequired, type VerifyResponse, type VerifyStatusResponse } from '@fpr/core';
import type { Env } from './env';
import { clientIp, hashIp, hashReporter, REPORTER_KEY, toHex } from './ip';
import { countDaily, DAY_MS } from './limits';

/** The extension's own origins: the only ones that get CORS or may frame /verify. */
export const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9-]+$/i;

const CHALLENGE = /^[0-9a-f]{32}$/;
const VERIFIED_MS = 90 * DAY_MS;
const ATTEMPTS_PER_IP = 20;
const ACTION = 'register';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type C = Context<{ Bindings: Env }>;

const configured = (env: Env) => Boolean(env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);

async function verifiedUntil(db: D1Database, reporter: string, now: number): Promise<number | null> {
  const row = await db.prepare('SELECT expires_at FROM verified_reporters WHERE reporter = ? AND expires_at > ?').bind(reporter, now).first<{ expires_at: number }>();
  return row ? Number(row.expires_at) : null;
}

/**
 * For a gated route: null when this reporter may go ahead, otherwise the
 * response to send (503 misconfigured, or 403 verification_required with a
 * fresh challenge).
 */
export async function requireVerified(c: C, reporter: string, now = Date.now()): Promise<Response | null> {
  const env = c.env;
  if (!env.VERIFY_HOST) return null;
  if (!configured(env)) return c.json({ error: 'verify_unconfigured' }, 503);
  if (await verifiedUntil(env.DB, reporter, now)) return null;
  const id = toHex(crypto.getRandomValues(new Uint8Array(16)));
  // Expired challenges are never read; the nightly retention job drops them.
  await env.DB.prepare('INSERT INTO verify_challenges (id, reporter, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(id, reporter, now, now + CHALLENGE_MS).run();
  const body: VerificationRequired = { error: 'verification_required', verifyUrl: `https://${env.VERIFY_HOST}/verify?challenge=${id}` };
  return c.json(body, 403);
}

export const verify = new Hono<{ Bindings: Env }>();

// None of these routes exist unless VERIFY_HOST is set.
verify.use('/verify', async (c, next) => (c.env.VERIFY_HOST ? next() : c.notFound()));
verify.use('/api/verify/*', async (c, next) => (c.env.VERIFY_HOST ? next() : c.notFound()));

verify.get('/verify', (c) => {
  if (!configured(c.env)) return c.json({ error: 'verify_unconfigured' }, 503);
  const challenge = c.req.query('challenge') ?? '';
  const tab = c.req.query('mode') === 'tab';
  const parentOrigin = tab ? null : (c.req.query('parentOrigin') ?? '');
  if (!CHALLENGE.test(challenge) || (parentOrigin !== null && !EXTENSION_ORIGIN.test(parentOrigin))) return c.json({ error: 'bad_request' }, 400);

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`,
    `style-src 'nonce-${nonce}'`,
    'frame-src https://challenges.cloudflare.com',
    ...(tab ? ["connect-src 'self'"] : []),
    'frame-ancestors chrome-extension: moz-extension: safari-web-extension:',
  ].join('; ');
  // Values are validated above; escaping `<` keeps the inline JSON inert anyway.
  const config = JSON.stringify({ sitekey: c.env.TURNSTILE_SITEKEY, action: ACTION, challenge, parentOrigin }).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quick check</title>
<style nonce="${nonce}">body{margin:0;padding:12px;font:14px system-ui,sans-serif}p{margin:8px 0 0}</style></head>
<body><div id="widget"></div><p id="status"></p>
<script nonce="${nonce}">
const cfg = ${config};
const status = (t) => { document.getElementById('status').textContent = t; };
window.fprReady = () => turnstile.render('#widget', {
  sitekey: cfg.sitekey, action: cfg.action, cData: cfg.challenge,
  callback(token) {
    if (cfg.parentOrigin) { parent.postMessage({ type: 'fpr-verify', challenge: cfg.challenge, token }, cfg.parentOrigin); return; }
    status('Checking…');
    fetch('/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, challenge: cfg.challenge }) })
      .then((r) => status(r.ok ? 'Done. You can close this tab.' : 'That didn\\'t work. Try sending again from the extension.'))
      .catch(() => status('Could not reach the server. Try again.'));
  },
});
</script>
<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fprReady" async defer></script>
</body></html>`;
  return c.html(html, 200, { 'content-security-policy': csp });
});

verify.post('/api/verify', async (c) => {
  if (!configured(c.env)) return c.json({ error: 'verify_unconfigured' }, 503);
  // JSON only: a cross-site form can't send it without a CORS preflight.
  if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) return c.json({ error: 'json_required' }, 415);
  const key = c.req.header('x-reporter-key');
  if (key !== undefined && !REPORTER_KEY.test(key)) return c.json({ error: 'reporter_key_required' }, 401);

  const now = Date.now();
  const db = c.env.DB;
  const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_SALT);
  if (!(await countDaily(db, [{ scope: 'verify.ip', subject: ipHash, max: ATTEMPTS_PER_IP }], now))) return c.json({ error: 'daily_limit_reached' }, 429);

  const text = await c.req.text();
  let body: { token?: unknown; challenge?: unknown } | null = null;
  try {
    if (text.length <= 4096) body = JSON.parse(text);
  } catch {}
  const token = body?.token;
  const challenge = body?.challenge;
  if (typeof token !== 'string' || !token || token.length > 2048 || typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return c.json({ error: 'bad_request' }, 400);

  // Used once: delete and return in one statement, before Siteverify sees it.
  const reporter = key === undefined ? null : await hashReporter(key, c.env.IP_SALT);
  // With a key sent, the challenge must be the one issued to it.
  const consumed = await db
    .prepare('DELETE FROM verify_challenges WHERE id = ?1 AND expires_at > ?2 AND (?3 IS NULL OR reporter = ?3) RETURNING reporter')
    .bind(challenge, now, reporter)
    .first<{ reporter: string }>();
  const failed = () => c.json({ error: 'verify_failed' }, 403);
  if (!consumed) return failed();

  const res = await fetch(SITEVERIFY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: c.env.TURNSTILE_SECRET, response: token, remoteip: clientIp(c.req.raw) }),
  });
  const out = (await res.json().catch(() => null)) as { success?: boolean; hostname?: string; action?: string; cdata?: string } | null;
  const host = new URL(`https://${c.env.VERIFY_HOST}`).hostname;
  if (out?.success !== true || out.hostname !== host || out.action !== ACTION || out.cdata !== challenge) return failed();

  const until = now + VERIFIED_MS;
  await db
    .prepare('INSERT INTO verified_reporters (reporter, verified_at, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT (reporter) DO UPDATE SET verified_at = ?2, expires_at = ?3')
    .bind(consumed.reporter, now, until)
    .run();
  const ok: VerifyResponse = { ok: true, verifiedUntil: until };
  return c.json(ok);
});

verify.get('/api/verify/status', async (c) => {
  const key = c.req.header('x-reporter-key') ?? '';
  if (!REPORTER_KEY.test(key)) return c.json({ error: 'reporter_key_required' }, 401);
  const until = await verifiedUntil(c.env.DB, await hashReporter(key, c.env.IP_SALT), Date.now());
  const res: VerifyStatusResponse = { verified: until !== null, verifiedUntil: until };
  return c.json(res);
});
