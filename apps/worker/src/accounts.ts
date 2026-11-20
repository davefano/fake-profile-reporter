// Profile snapshots, reports, and account lookup.
//
//   POST /api/snapshots[?report=1]  raw snapshot JSON (optionally gzipped) → R2 + D1; with
//                                   report=1, also reports the account as suspicious
//   GET  /api/accounts/:memberId     latest facts, slug history, snapshot history, report count
//   GET  /api/accounts?slug=…        same, looked up by any slug the account has used
//   GET  /api/leaderboard            reported accounts, ranked
//
// The server re-parses and re-scores every snapshot itself: the client's own
// score is never trusted.

import { Hono, type Context } from 'hono';
import { extractProfileFacts, observeProfile, scoreProfile, type FactChange, type LeaderboardResponse, type ProfileFacts, type RawSnapshot, type Score, type SnapshotResponse } from '@flr/core';
import type { Env } from './env';
import { createAccountStore } from './accounts-store';
import { gunzipLimited, gzip, TooLarge } from './json';
import { reporterLimits } from './limits';
import { cleanSnapshot } from './snapshot';

const MAX_BYTES = 25 * 1024 * 1024;
const DAILY_LIMIT = 200; // snapshots + reports per reporter per day
const SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000; // per reporter per account
const REPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // per reporter per account

export const accounts = new Hono<{ Bindings: Env }>();

const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b;

accounts.post('/api/snapshots', async (c) => {
  if (Number(c.req.header('content-length') || 0) > MAX_BYTES) return c.json({ error: 'too_large' }, 413);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_BYTES) return c.json({ error: 'too_large' }, 413);
  const report = c.req.query('report') === '1';

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
  const reportCd = report ? await limits.cooldown(`report:${memberId}`, REPORT_COOLDOWN_MS) : null;
  if (reportCd && !reportCd.ok) return c.json({ error: 'already_reported_recently' }, 429);
  const snapCd = await limits.cooldown(`snapshot:${memberId}`, SNAPSHOT_COOLDOWN_MS);
  if (!snapCd.ok && !report) return c.json({ error: 'captured_recently' }, 429);

  const store = createAccountStore(c.env.DB);
  const finish = async (score: Score, changes: FactChange[]) => {
    // Recorded and returned: the directory's score for the account now.
    if (reportCd) {
      await store.addReport({ memberId, score: score.score, ipHash: limits.ipHash, createdAt: now });
      await reportCd.commit();
    }
    await day.commit();
    const res: SnapshotResponse = { ok: true, memberId, slug: facts.slug, score, changes, reported: report };
    return c.json(res, 201);
  };

  // A report inside the snapshot cooldown: record it against what's stored.
  if (!snapCd.ok) {
    const stored = await store.current(memberId);
    if (stored) return finish(scoreProfile(stored.facts, stored.capturedAt), []);
  }

  // Store the snapshot. Archive first: if that fails, nothing in D1 has changed.
  const r2Key = `snapshots/${memberId}/${new Date(capturedAt).toISOString()}-${limits.ipHash.slice(0, 8)}.json.gz`;
  await c.env.SNAPSHOTS.put(r2Key, await gzip(new TextEncoder().encode(JSON.stringify(raw))), {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    customMetadata: { slug: facts.slug ?? '', schema: String(raw.schema) },
  });
  const observedScore = scoreProfile(facts, capturedAt);
  await store.ensureAccount(memberId, facts, observedScore, capturedAt);
  const write = { observed: { ...facts, memberId }, score: observedScore, changes: [] as FactChange[], r2Key, capturedAt, ipHash: limits.ipHash };

  // Merge with the account's current facts and commit, all or nothing, from the
  // version read here. If another upload moved the account first, merge again.
  for (let attempt = 0; attempt < 3; attempt++) {
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
