// Profile snapshots and account lookup. Reports are in reports.ts.
//
//   POST /api/snapshots              raw snapshot JSON (optionally gzipped) → R2 + D1
//   GET  /api/accounts/:memberId     latest facts, slug history, snapshot history, report counts
//   GET  /api/accounts?slug=…        same, looked up by any slug the account has used
//   GET  /api/leaderboard            accounts reported as suspicious, ranked
//
// The server re-parses and re-scores every snapshot itself: the client's own
// score is never trusted.

import { Hono, type Context } from 'hono';
import { extractProfileFacts, observeProfile, scoreProfile, type FactChange, type LeaderboardResponse, type ProfileFacts, type GoneError, type RawSnapshot, type Score, type SnapshotResponse } from '@fpr/core';
import type { Env } from './env';
import { createAccountStore } from './accounts-store';
import { gunzipLimited, gzip, TooLarge } from './json';
import { reporterLimits } from './limits';
import { cleanSnapshot } from './snapshot';

const MAX_BYTES = 25 * 1024 * 1024;
const DAILY_LIMIT = 200; // snapshots per reporter per day
const SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000; // per reporter per account

export const accounts = new Hono<{ Bindings: Env }>();

const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

accounts.post('/api/snapshots', async (c) => {
  // Builds up to 2026.11.23.1 reported with ?report=1. Refuse before storing anything.
  if (c.req.query('report') === '1') return c.json({ error: 'upgrade_required' satisfies GoneError }, 410);
  if (Number(c.req.header('content-length') || 0) > MAX_BYTES) return c.json({ error: 'too_large' }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_BYTES) return c.json({ error: 'too_large' }, 413);

  // Accept plain or gzipped JSON.
  let parsed: unknown;
  try {
    const json = isGzip(body) ? await gunzipLimited(body, MAX_BYTES) : body;
    parsed = JSON.parse(new TextDecoder().decode(json));
  } catch (e) {
    return e instanceof TooLarge ? c.json({ error: 'too_large' }, 413) : c.json({ error: 'bad_json' }, 400);
  }
  const snap = cleanSnapshot(parsed);
  if (!snap) return c.json({ error: 'bad_snapshot' }, 400);

  const now = Date.now();
  // Clamp the claimed capture time into [0, now]; the stored snapshot uses the same value.
  const capturedAt = snap.capturedAt != null ? Math.min(snap.capturedAt, now) : now;
  const raw: RawSnapshot = { ...snap, capturedAt };
  let facts: ProfileFacts;
  try {
    facts = extractProfileFacts(raw, capturedAt);
  } catch {
    return c.json({ error: 'bad_snapshot' }, 400); // payload shapes the parsers couldn't read
  }
  if (!facts.memberId) return c.json({ error: 'no_member_id' }, 422);
  const memberId = facts.memberId;

  const limits = await reporterLimits(c, now);
  const day = await limits.daily('snapshots', DAILY_LIMIT);
  if (!day.ok) return c.json({ error: 'daily_limit_reached' }, 429);
  const snapCd = await limits.cooldown(`snapshot:${memberId}`, SNAPSHOT_COOLDOWN_MS);
  if (!snapCd.ok) return c.json({ error: 'captured_recently' }, 429);

  const store = createAccountStore(c.env.DB);
  const finish = async (score: Score, changes: FactChange[]) => {
    await day.commit();
    // The directory's score for the account now.
    const res: SnapshotResponse = { ok: true, memberId, slug: facts.slug, score, changes };
    return c.json(res, 201);
  };

  // Answer with what's stored, without storing anything: for a capture that's already on record.
  const answerStored = async () => {
    const stored = await store.current(memberId);
    return stored ? finish(scoreProfile(stored.facts, stored.capturedAt), []) : null;
  };

  // Store the snapshot. Archive first: if that fails, nothing in D1 has changed.
  // The key is a hash of the contents, so a capture uploaded twice is stored once.
  const json = JSON.stringify(raw);
  const r2Key = `snapshots/${memberId}/${new Date(capturedAt).toISOString()}-${await sha256(json)}.json.gz`;
  if (await store.hasSnapshot(r2Key)) {
    const res = await answerStored();
    if (res) return res;
  }
  await c.env.SNAPSHOTS.put(r2Key, await gzip(new TextEncoder().encode(json)), {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    customMetadata: { slug: facts.slug ?? '', schema: String(raw.schema) },
  });
  const observedScore = scoreProfile(facts, capturedAt);
  const write = { observed: { ...facts, memberId }, score: observedScore, changes: [] as FactChange[], r2Key, capturedAt, ipHash: limits.ipHash };

  // Merge with the account's current facts and commit, all or nothing, from the
  // version read here. If another upload moved the account first, merge again.
  for (let attempt = 0; attempt < 3; attempt++) {
    // A concurrent identical upload may have recorded this capture meanwhile.
    if (attempt > 0 && (await store.hasSnapshot(r2Key))) return (await answerStored()) ?? c.json({ error: 'busy' }, 409);
    const prev = await store.current(memberId);
    if (prev && prev.capturedAt > capturedAt) {
      // An older capture (a backfill): stored, but it doesn't move the account.
      await store.commitBackfill(write);
      await snapCd.commit();
      return finish(scoreProfile(prev.facts, prev.capturedAt), []);
    }
    const { current, changes } = observeProfile(prev?.facts ?? null, facts);
    const account = { facts: current, score: scoreProfile(current, capturedAt) };
    if (await store.commitNewest({ ...write, changes }, prev?.rev ?? null, account)) {
      await snapCd.commit();
      return finish(account.score, changes);
    }
  }
  return c.json({ error: 'busy' }, 409);
});

accounts.get('/api/leaderboard', async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10) || 100, 1), 200);
  const res: LeaderboardResponse = await createAccountStore(c.env.DB).leaderboard(limit);
  return c.json(res);
});

accounts.get('/api/accounts', async (c) => {
  const slug = c.req.query('slug');
  if (!slug) return c.json({ error: 'slug_required' }, 400);
  const memberId = await createAccountStore(c.env.DB).memberIdForSlug(slug);
  return memberId ? accountResponse(c, memberId) : c.json({ error: 'not_found' }, 404);
});

accounts.get('/api/accounts/:memberId{[0-9]+}', (c) => accountResponse(c, Number(c.req.param('memberId'))));

async function accountResponse(c: Context<{ Bindings: Env }>, memberId: number) {
  const account = await createAccountStore(c.env.DB).getAccount(memberId);
  return account ? c.json(account) : c.json({ error: 'not_found' }, 404);
}
