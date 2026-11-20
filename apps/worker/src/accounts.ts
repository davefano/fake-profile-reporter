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
import {
  diffProfileFacts,
  extractProfileFacts,
  scoreProfile,
  SNAPSHOT_SCHEMA,
  type LeaderboardResponse,
  type RawSnapshot,
  type SnapshotResponse,
} from '@flr/core';
import type { Env } from './env';
import { createAccountStore } from './accounts-store';
import { gunzipLimited, gzip, safeJson, TooLarge } from './json';
import { reporterLimits } from './limits';

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
  let snap: RawSnapshot;
  try {
    const json = isGzip(body) ? await gunzipLimited(body, MAX_BYTES) : body;
    snap = JSON.parse(new TextDecoder().decode(json));
  } catch (e) {
    return e instanceof TooLarge ? c.json({ error: 'too_large' }, 413) : c.json({ error: 'bad_json' }, 400);
  }
  if (snap?.schema !== SNAPSHOT_SCHEMA || typeof snap.slug !== 'string' || !snap.payloads || typeof snap.payloads !== 'object') {
    return c.json({ error: 'bad_snapshot' }, 400);
  }
  snap.errors ??= {};
  // Mutual connections are relative to whoever captured the profile: not a
  // fact about the account, so they're neither stored nor scored here.
  delete snap.payloads.profilePageMutualCount;

  const now = Date.now();
  const capturedAt = Number.isFinite(snap.capturedAt) ? Math.min(snap.capturedAt, now) : now;
  const facts = extractProfileFacts(snap, capturedAt);
  if (!facts.memberId) return c.json({ error: 'no_member_id' }, 422);
  const memberId = facts.memberId;

  const limits = await reporterLimits(c, now);
  const day = await limits.daily('snapshots', DAILY_LIMIT);
  if (!day.ok) return c.json({ error: 'daily_limit_reached' }, 429);
  const reportCd = report ? await limits.cooldown(`report:${memberId}`, REPORT_COOLDOWN_MS) : null;
  if (reportCd && !reportCd.ok) return c.json({ error: 'already_reported_recently' }, 429);
  // Within the snapshot cooldown a report still counts; only the snapshot is skipped.
  const snapCd = await limits.cooldown(`snapshot:${memberId}`, SNAPSHOT_COOLDOWN_MS);
  if (!snapCd.ok && !report) return c.json({ error: 'captured_recently' }, 429);

  const store = createAccountStore(c.env.DB);
  const score = scoreProfile(facts, capturedAt);
  const prev = await store.latest(memberId);
  // A backfilled (older) snapshot is stored but doesn't produce a change list.
  const changes = prev && prev.capturedAt <= capturedAt ? diffProfileFacts(prev.facts, facts) : [];

  if (snapCd.ok || !prev) {
    const r2Key = `snapshots/${memberId}/${new Date(capturedAt).toISOString()}-${limits.ipHash.slice(0, 8)}.json.gz`;
    // Store what we kept (after removing viewer-relative data), not the upload as sent.
    await c.env.SNAPSHOTS.put(r2Key, await gzip(new TextEncoder().encode(JSON.stringify(snap))), {
      httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      customMetadata: { slug: facts.slug ?? '', schema: String(snap.schema) },
    });
    await store.addSnapshot({ facts: { ...facts, memberId }, score, changes, r2Key, capturedAt, ipHash: limits.ipHash });
    await snapCd.commit();
  }
  if (reportCd) {
    await store.addReport({ memberId, score: (await store.currentScore(memberId)) ?? score.score, ipHash: limits.ipHash, createdAt: now });
    await reportCd.commit();
  }
  await day.commit();

  const res: SnapshotResponse = { ok: true, memberId, slug: facts.slug, score, changes, reported: report };
  return c.json(res, 201);
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
  const data = await createAccountStore(c.env.DB).getAccount(memberId);
  if (!data) return c.json({ error: 'not_found' }, 404);
  return c.json({
    account: data.account,
    slugs: data.slugs,
    reports: data.reports,
    snapshots: data.snapshots.map(({ changes_json, ...s }) => ({ ...s, changes: safeJson(changes_json, []) })),
  });
}
