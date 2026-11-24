// Removal requests: someone asks for their own profile to be removed, and the
// maintainer reviews it. Nothing is hidden before approval.
//
//   POST /api/removals                          RemovalRequest → RemovalResponse (x-reporter-key)
//   GET  /api/admin/removals                    AdminRemovalsResponse
//   POST /api/admin/removals/:id/approve        AdminApproveRequest → AdminDecisionResponse
//   POST /api/admin/removals/:id/deny           AdminDenyRequest → AdminDecisionResponse
//   POST /api/admin/removed/:memberId/restore   → AdminDecisionResponse
//
// The extension checks the code is on the profile before sending, but a
// snapshot can be forged, so the server trusts nothing it sends: the
// maintainer reads the profile, and weighs its signals and reports too,
// because a scammer controls their own fake.
//
// Admin routes need `authorization: Bearer <ADMIN_TOKEN>` and answer 404 while
// the secret is unset or short. They get no CORS headers (index.ts), and
// nothing here logs their bodies or headers.
//
// Approving deletes the member's D1 rows and blocks the member in one batch,
// then deletes its archived snapshots in R2; the request is `approved` only
// once a listing comes back empty, and approve can be re-run until then.
// Restoring lifts the block; deleted data stays deleted.

import { Hono, type Context } from 'hono';
import { scoreProfile, type AdminDecisionResponse, type AdminRemovalsResponse, type RemovalResponse, type RemovalStatus } from '@fpr/core';
import type { Env } from './env';
import { createAccountStore } from './accounts-store';
import { clientIp, hashIp, hashReporter, REPORTER_KEY } from './ip';
import { countDaily } from './limits';
import { countsFrom, reportCounts } from './reports-store';
import { requireVerified } from './verify';

const DAY_MS = 86_400_000;
const DENIED_MS = 90 * DAY_MS; // a denial blocks new requests this long
const RETAIN_MS = 90 * DAY_MS; // contacts on pending requests, and decided requests
const ORPHAN_SWEEP_MS = 7 * DAY_MS; // approvals the admin list sweeps R2 for again
const REQUESTS_PER_REPORTER = 3;
const REQUESTS_PER_IP = 5;
const MAX_PENDING = 100;
const ADMIN_FAILS_PER_IP = 10;
const MIN_ADMIN_TOKEN = 43; // 32 random bytes, base64url
const SWEEP_PAGES = 20; // R2 listings per approve; re-run approve for more
const CODE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_CONTACT = 200;
const MAX_BODY = 1024;

type C = Context<{ Bindings: Env }>;

export const removals = new Hono<{ Bindings: Env }>();

/** A small JSON body, or null. */
async function smallJson(c: C): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const isMemberId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

removals.post('/api/removals', async (c) => {
  const key = c.req.header('x-reporter-key') ?? '';
  if (!REPORTER_KEY.test(key)) return c.json({ error: 'reporter_key_required' }, 401);
  const body = await smallJson(c);
  const memberId = body?.memberId;
  const code = body?.code;
  const contact = body?.contact;
  if (!isMemberId(memberId) || typeof code !== 'string' || !CODE.test(code) || (contact !== undefined && (typeof contact !== 'string' || contact.length > MAX_CONTACT))) {
    return c.json({ error: 'bad_request' }, 400);
  }

  const now = Date.now();
  const db = c.env.DB;
  const reporter = await hashReporter(key, c.env.IP_SALT);
  const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_SALT);
  const within = await countDaily(
    db,
    [
      { scope: 'removals.reporter', subject: reporter, max: REQUESTS_PER_REPORTER },
      { scope: 'removals.ip', subject: ipHash, max: REQUESTS_PER_IP },
    ],
    now,
  );
  if (!within) return c.json({ error: 'daily_limit_reached' }, 429);
  const gate = await requireVerified(c, reporter, now);
  if (gate) return gate;

  // ?1 member, ?2 reporter, ?3 IP hash, ?7 denials since, ?8 pending cap. The
  // insert carries every rule, so parallel requests can't slip past one; the
  // flags, read in the same transaction, only say which rule refused it.
  const stored = 'EXISTS (SELECT 1 FROM accounts WHERE member_id = ?1) AND NOT EXISTS (SELECT 1 FROM removed_members WHERE member_id = ?1)';
  const pending = "EXISTS (SELECT 1 FROM removal_requests WHERE member_id = ?1 AND status = 'pending' AND (reporter = ?2 OR ip_hash = ?3))";
  const denied = "EXISTS (SELECT 1 FROM removal_requests WHERE member_id = ?1 AND decided_at > ?7 AND (status = 'denied_merits' OR (status = 'denied_code' AND reporter = ?2)))";
  const full = "(SELECT COUNT(*) FROM removal_requests WHERE status = 'pending') >= ?8";
  const params = [memberId, reporter, ipHash, code, contact?.trim() || null, now, now - DENIED_MS, MAX_PENDING];
  const [flagRes, insRes] = await db.batch([
    db.prepare(`SELECT ${stored} AS stored, ${pending} AS pending, ${denied} AS denied, ${full} AS full`).bind(...params),
    db
      .prepare(
        `INSERT INTO removal_requests (member_id, reporter, ip_hash, code, contact, status, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6 WHERE ${stored} AND NOT ${pending} AND NOT ${denied} AND NOT ${full}`,
      )
      .bind(...params),
  ]);
  if (insRes?.meta?.changes) return c.json({ ok: true } satisfies RemovalResponse, 201);
  const f = (flagRes?.results[0] ?? {}) as Record<'stored' | 'pending' | 'denied' | 'full', number>;
  if (!f.stored) return c.json({ error: 'not_found' }, 404);
  if (f.pending) return c.json({ error: 'already_pending' }, 409);
  if (f.denied) return c.json({ error: 'recently_denied' }, 429);
  return c.json({ error: 'queue_full' }, 503);
});

// ── Admin ────────────────────────────────────────────────────────────────

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/** Compares digests, so the time taken says nothing about the token. */
async function tokenMatches(given: string, token: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

removals.use('/api/admin/*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token || token.length < MIN_ADMIN_TOKEN) return c.notFound();
  const db = c.env.DB;
  const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_SALT);
  const day = new Date().toISOString().slice(0, 10);
  const fails = await db.prepare("SELECT count FROM daily_counts WHERE scope = 'admin.fails.ip' AND subject = ? AND day = ?").bind(ipHash, day).first<{ count: number }>();
  if (Number(fails?.count ?? 0) >= ADMIN_FAILS_PER_IP) return c.json({ error: 'too_many_attempts' }, 429);
  const auth = c.req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !(await tokenMatches(auth.slice(7), token))) {
    await countDaily(db, [{ scope: 'admin.fails.ip', subject: ipHash, max: ADMIN_FAILS_PER_IP }]);
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

/**
 * Deletes the member's archived snapshots in R2, a page at a time. True once a
 * listing comes back empty; false if more pages remain than one run takes.
 * Throws if R2 does.
 */
async function sweep(r2: R2Bucket, memberId: number): Promise<boolean> {
  const prefix = `snapshots/${memberId}/`;
  for (let page = 0; page <= SWEEP_PAGES; page++) {
    // Each listing starts over: the keys already deleted are gone from it.
    const listing = await r2.list({ prefix });
    if (!listing.objects.length) return true;
    await r2.delete(listing.objects.map((o) => o.key));
  }
  return false;
}

/** Sweeps R2 for the member, and marks its approvals done once nothing is left. */
async function finishApproval(env: Env, memberId: number): Promise<boolean> {
  if (!(await sweep(env.SNAPSHOTS, memberId))) return false;
  await env.DB.prepare("UPDATE removal_requests SET status = 'approved' WHERE member_id = ? AND status = 'approved_r2_pending'").bind(memberId).run();
  return true;
}

removals.get('/api/admin/removals', async (c) => {
  const env = c.env;
  const db = env.DB;
  const now = Date.now();
  // Sweep again for recent approvals: an upload in flight during approval may
  // have archived a snapshot after the first sweep (its D1 rows were refused).
  const recent = await db
    .prepare("SELECT DISTINCT member_id FROM removal_requests WHERE status = 'approved_r2_pending' OR (status = 'approved' AND decided_at > ?)")
    .bind(now - ORPHAN_SWEEP_MS)
    .all<{ member_id: number }>();
  for (const r of recent.results) {
    try {
      await finishApproval(env, Number(r.member_id));
    } catch {
      // Left approved_r2_pending, listed under `unfinished`.
    }
  }

  const [pendingRes, unfinishedRes] = await db.batch([
    db.prepare("SELECT id, member_id, code, contact, created_at FROM removal_requests WHERE status = 'pending' ORDER BY created_at, id"),
    db.prepare("SELECT id, member_id FROM removal_requests WHERE status = 'approved_r2_pending' ORDER BY id"),
  ]);
  const pending = (pendingRes?.results ?? []) as Array<{ id: number; member_id: number; code: string; contact: string | null; created_at: number }>;
  const store = createAccountStore(db);
  const members: AdminRemovalsResponse['members'] = [];
  for (const memberId of [...new Set(pending.map((p) => Number(p.member_id)))]) {
    // Only what the server stores for the member: never a slug from the request.
    const [slugRes, countRes] = await db.batch([
      db.prepare('SELECT slug FROM account_slugs WHERE member_id = ? ORDER BY last_seen DESC').bind(memberId),
      reportCounts(db, 'profile', String(memberId)),
    ]);
    const current = await store.current(memberId);
    members.push({
      memberId,
      slugs: ((slugRes?.results ?? []) as Array<{ slug: string }>).map((s) => s.slug),
      score: current ? scoreProfile(current.facts, current.capturedAt) : null,
      counts: countsFrom(countRes?.results[0]),
      requests: pending.filter((p) => Number(p.member_id) === memberId).map((p) => ({ id: p.id, code: p.code, contact: p.contact, createdAt: p.created_at })),
    });
  }
  const unfinished = ((unfinishedRes?.results ?? []) as Array<{ id: number; member_id: number }>).map((r) => ({ requestId: r.id, memberId: Number(r.member_id) }));
  return c.json({ members, unfinished } satisfies AdminRemovalsResponse);
});

const decided = (c: C, status: RemovalStatus, code: 200 | 202 = 200) => c.json({ ok: true, status } satisfies AdminDecisionResponse, code);

async function requestById(db: D1Database, id: string | undefined) {
  if (!id || !/^\d{1,15}$/.test(id)) return null;
  return db.prepare('SELECT id, member_id, status FROM removal_requests WHERE id = ?').bind(Number(id)).first<{ id: number; member_id: number; status: RemovalStatus }>();
}

removals.post('/api/admin/removals/:id/approve', async (c) => {
  const env = c.env;
  const db = env.DB;
  const req = await requestById(db, c.req.param('id'));
  if (!req) return c.json({ error: 'not_found' }, 404);
  // The member ID of the profile the maintainer read, typed back.
  const body = await smallJson(c);
  const memberId = Number(req.member_id);
  if (body?.memberId !== memberId) return c.json({ error: 'member_mismatch' }, 400);
  if (req.status !== 'pending' && req.status !== 'approved_r2_pending') return c.json({ error: 'already_decided' }, 409);

  if (req.status === 'pending') {
    const now = Date.now();
    // Until migrations/later/0002 drops it, the old report table references accounts.
    const oldReports = await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'account_reports'").first();
    await db.batch([
      db
        .prepare("INSERT INTO removal_log (request_id, member_id, action, created_at) SELECT ?1, ?2, 'approve', ?3 WHERE EXISTS (SELECT 1 FROM removal_requests WHERE id = ?1 AND status = 'pending')")
        .bind(req.id, memberId, now),
      db.prepare('DELETE FROM account_snapshots WHERE member_id = ?').bind(memberId),
      db.prepare('DELETE FROM account_current WHERE member_id = ?').bind(memberId),
      db.prepare('DELETE FROM account_slugs WHERE member_id = ?').bind(memberId),
      db.prepare("DELETE FROM reports WHERE kind = 'profile' AND target_id = ?").bind(String(memberId)),
      ...(oldReports ? [db.prepare('DELETE FROM account_reports WHERE member_id = ?').bind(memberId)] : []),
      db.prepare('DELETE FROM accounts WHERE member_id = ?').bind(memberId),
      db.prepare('INSERT INTO removed_members (member_id, request_id, removed_at) VALUES (?, ?, ?) ON CONFLICT (member_id) DO NOTHING').bind(memberId, req.id, now),
      // Every pending request for the member is settled by this approval.
      db.prepare("UPDATE removal_requests SET status = 'approved_r2_pending', contact = NULL, decided_at = ? WHERE member_id = ? AND status = 'pending'").bind(now, memberId),
    ]);
  }

  try {
    if (await finishApproval(env, memberId)) return decided(c, 'approved');
  } catch {
    // R2 failed part-way: approve again to finish.
  }
  return decided(c, 'approved_r2_pending', 202);
});

removals.post('/api/admin/removals/:id/deny', async (c) => {
  const db = c.env.DB;
  const req = await requestById(db, c.req.param('id'));
  if (!req) return c.json({ error: 'not_found' }, 404);
  const reason = (await smallJson(c))?.reason;
  if (reason !== 'code' && reason !== 'merits') return c.json({ error: 'bad_reason' }, 400);
  const status: RemovalStatus = reason === 'code' ? 'denied_code' : 'denied_merits';
  const now = Date.now();
  const [, upd] = await db.batch([
    db
      .prepare("INSERT INTO removal_log (request_id, member_id, action, created_at) SELECT ?1, member_id, ?2, ?3 FROM removal_requests WHERE id = ?1 AND status = 'pending'")
      .bind(req.id, `deny_${reason}`, now),
    db.prepare("UPDATE removal_requests SET status = ?, contact = NULL, decided_at = ? WHERE id = ? AND status = 'pending'").bind(status, now, req.id),
  ]);
  if (!upd?.meta?.changes) return c.json({ error: 'already_decided' }, 409);
  return decided(c, status);
});

removals.post('/api/admin/removed/:memberId{[0-9]+}/restore', async (c) => {
  const db = c.env.DB;
  const memberId = Number(c.req.param('memberId'));
  const now = Date.now();
  const [, , del] = await db.batch([
    db
      .prepare("INSERT INTO removal_log (request_id, member_id, action, created_at) SELECT NULL, ?1, 'restore', ?2 WHERE EXISTS (SELECT 1 FROM removed_members WHERE member_id = ?1)")
      .bind(memberId, now),
    db.prepare("UPDATE removal_requests SET status = 'restored', decided_at = ? WHERE member_id = ? AND status IN ('approved', 'approved_r2_pending')").bind(now, memberId),
    db.prepare('DELETE FROM removed_members WHERE member_id = ?').bind(memberId),
  ]);
  if (!del?.meta?.changes) return c.json({ error: 'not_found' }, 404);
  return decided(c, 'restored');
});

/**
 * The daily retention deletes (the `scheduled` handler): contacts on requests
 * pending over 90 days, requests decided over 90 days ago (except approvals
 * still sweeping R2), expired bot-check challenges and verifications, and
 * earlier days' counters.
 */
export async function retention(db: D1Database, now = Date.now()): Promise<void> {
  const cutoff = now - RETAIN_MS;
  await db.batch([
    db.prepare("UPDATE removal_requests SET contact = NULL WHERE status = 'pending' AND created_at < ? AND contact IS NOT NULL").bind(cutoff),
    db.prepare("DELETE FROM removal_requests WHERE decided_at < ? AND status != 'approved_r2_pending'").bind(cutoff),
    db.prepare('DELETE FROM verify_challenges WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM verified_reporters WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM daily_counts WHERE day < ?').bind(new Date(now).toISOString().slice(0, 10)),
  ]);
}
