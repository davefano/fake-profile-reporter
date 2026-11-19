// Snapshot ingestion and account lookup.
//
//   POST /api/snapshots           raw snapshot JSON (optionally gzipped) → stored in R2 + D1
//   GET  /api/accounts/:memberId  latest facts, slug history, snapshot history
//   GET  /api/accounts?slug=…     same, looked up by any slug the account has used

import { Hono } from 'hono';
import { diffProfileFacts, extractProfileFacts, scoreProfile, SNAPSHOT_SCHEMA, type RawSnapshot } from '@flr/core';
import type { Env } from './env';
import { clientIp, hashIp } from './ip';
import { createAccountStore } from './accounts-store';

const MAX_BYTES = 25 * 1024 * 1024;
const SNAPSHOT_DAILY_LIMIT = 200; // per IP
const SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000; // per IP per account

export const accounts = new Hono<{ Bindings: Env }>();

const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

accounts.post('/api/snapshots', async (c) => {
  const declared = Number(c.req.header('content-length') || 0);
  if (declared > MAX_BYTES) return c.json({ error: 'too_large' }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_BYTES) return c.json({ error: 'too_large' }, 413);

  // Accept plain or gzipped JSON; always store gzipped.
  let gz: Uint8Array;
  let snap: RawSnapshot;
  try {
    const json = isGzip(body) ? new TextDecoder().decode(await pipe(body, new DecompressionStream('gzip'))) : new TextDecoder().decode(body);
    snap = JSON.parse(json);
    gz = isGzip(body) ? body : await pipe(body, new CompressionStream('gzip'));
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  if (snap?.schema !== SNAPSHOT_SCHEMA || typeof snap.slug !== 'string' || !snap.payloads || typeof snap.payloads !== 'object') {
    return c.json({ error: 'bad_snapshot' }, 400);
  }
  snap.errors ??= {};

  const now = Date.now();
  const capturedAt = Number.isFinite(snap.capturedAt) ? Math.min(snap.capturedAt, now) : now;
  const facts = extractProfileFacts(snap, capturedAt);
  if (!facts.memberId) return c.json({ error: 'no_member_id' }, 422);
  const memberId = facts.memberId;

  const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_SALT);
  const kv = c.env.RATE_KV;
  const cooldownKey = `snapcd:${memberId}:${ipHash}`;
  const last = await kv.get(cooldownKey);
  if (last && now - Number(last) < SNAPSHOT_COOLDOWN_MS) return c.json({ error: 'captured_recently' }, 429);
  const dayKey = `snapday:${ipHash}:${new Date(now).toISOString().slice(0, 10)}`;
  const count = Number((await kv.get(dayKey)) || 0);
  if (count >= SNAPSHOT_DAILY_LIMIT) return c.json({ error: 'daily_limit_reached' }, 429);

  const score = scoreProfile(facts, capturedAt);
  const store = createAccountStore(c.env.DB);
  const prev = await store.latestFacts(memberId);
  const changes = prev ? diffProfileFacts(prev, facts) : [];

  const r2Key = `snapshots/${memberId}/${new Date(capturedAt).toISOString()}-${ipHash.slice(0, 8)}.json.gz`;
  await c.env.SNAPSHOTS.put(r2Key, gz, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    customMetadata: { slug: facts.slug ?? '', schema: String(snap.schema) },
  });
  await store.addSnapshot({ facts: { ...facts, memberId }, score, changes, r2Key, capturedAt, ipHash });

  await kv.put(cooldownKey, String(now), { expirationTtl: SNAPSHOT_COOLDOWN_MS / 1000 });
  await kv.put(dayKey, String(count + 1), { expirationTtl: 60 * 60 * 48 });

  return c.json({ ok: true, memberId, slug: facts.slug, score, changes }, 201);
});

accounts.get('/api/accounts', async (c) => {
  const slug = c.req.query('slug');
  if (!slug) return c.json({ error: 'slug_required' }, 400);
  const store = createAccountStore(c.env.DB);
  const memberId = await store.memberIdForSlug(slug);
  return memberId ? accountResponse(c, memberId) : c.json({ error: 'not_found' }, 404);
});

accounts.get('/api/accounts/:memberId{[0-9]+}', (c) => accountResponse(c, Number(c.req.param('memberId'))));

async function accountResponse(c: any, memberId: number) {
  const data = await createAccountStore(c.env.DB).getAccount(memberId);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({
    account: data.account,
    slugs: data.slugs,
    snapshots: data.snapshots.map(({ changes_json, ...s }) => ({ ...s, changes: JSON.parse(changes_json) })),
  });
}
