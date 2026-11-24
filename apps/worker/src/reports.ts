// Reports on saved profiles, companies and jobs: one per reporter per target,
// which its reporter can change or withdraw.
//
//   PUT    /api/reports/:kind/:id   ReportRequest → ReportResponse (create or replace)
//   DELETE /api/reports/:kind/:id   withdraw → WithdrawResponse
//
// The reporter is the x-reporter-key header: a random secret the extension
// keeps. Only its hash is stored, so only the key's holder can change the
// report. The target must already be saved (POST /api/snapshots or
// /api/entities), and the report stores the target's score at that moment.
// Notes are stored for building heuristics and never returned.
// Reporting needs the bot check where the server has one (verify.ts);
// withdrawing never does.

import { Hono, type Context } from 'hono';
import { cleanReport, scoreProfile, type ReportKind, type ReportResponse, type StoredScore, type WithdrawResponse } from '@fpr/core';
import type { Env } from './env';
import { createAccountStore } from './accounts-store';
import { clientIp, hashIp, hashReporter, REPORTER_KEY } from './ip';
import { safeJson } from './json';
import { countDaily } from './limits';
import { countsFrom, reportCounts } from './reports-store';
import { requireVerified } from './verify';

const MAX_BODY = 8 * 1024;
// Reports and edits per UTC day. Withdrawals don't count.
const REPORTS_PER_REPORTER = 50;
const REPORTS_PER_IP = 200;

export const reports = new Hono<{ Bindings: Env }>();

const ID: Record<ReportKind, RegExp> = { profile: /^\d{1,20}$/, company: /^[\w-]{1,200}$/, job: /^\d{1,20}$/ };
const isKind = (k: string): k is ReportKind => k in ID;

/** The target and reporter from the path and header, or an error response. */
async function who(c: Context<{ Bindings: Env }>) {
  const kind = c.req.param('kind') ?? '';
  const id = c.req.param('id') ?? '';
  if (!isKind(kind) || !ID[kind].test(id)) return { error: c.json({ error: 'bad_target' }, 400) };
  const key = c.req.header('x-reporter-key') ?? '';
  if (!REPORTER_KEY.test(key)) return { error: c.json({ error: 'reporter_key_required' }, 401) };
  return { kind, id, reporter: await hashReporter(key, c.env.IP_SALT) };
}

/** The target's score now, or null if it was never saved. */
async function targetScore(env: Env, kind: ReportKind, id: string): Promise<StoredScore | null> {
  if (kind === 'profile') {
    const current = await createAccountStore(env.DB).current(Number(id));
    return current ? scoreProfile(current.facts, current.capturedAt) : null;
  }
  const row = await env.DB.prepare('SELECT signals_json FROM entities WHERE kind = ? AND entity_id = ?').bind(kind, id).first<{ signals_json: string }>();
  return row ? safeJson<StoredScore | null>(row.signals_json, null) : null;
}

reports.put('/api/reports/:kind/:id', async (c) => {
  const w = await who(c);
  if ('error' in w) return w.error;
  const { kind, id, reporter } = w;

  const text = await c.req.text();
  if (text.length > MAX_BODY) return c.json({ error: 'too_large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  const r = cleanReport(kind, body);
  if ('error' in r) return c.json({ error: r.error }, 400);

  const now = Date.now();
  const ipHash = await hashIp(clientIp(c.req.raw), c.env.IP_SALT);
  const within = await countDaily(
    c.env.DB,
    [
      { scope: 'reports.reporter', subject: reporter, max: REPORTS_PER_REPORTER },
      { scope: 'reports.ip', subject: ipHash, max: REPORTS_PER_IP },
    ],
    now,
  );
  if (!within) return c.json({ error: 'daily_limit_reached' }, 429);
  const gate = await requireVerified(c, reporter, now);
  if (gate) return gate;

  const score = await targetScore(c.env, kind, id);
  if (!score) return c.json({ error: 'not_saved' }, 404);

  const db = c.env.DB;
  // Editing keeps the original created_at; reporting again after a withdrawal starts over.
  const [, rowRes, countRes] = await db.batch([
    db
      .prepare(
        `INSERT INTO reports (kind, target_id, reporter, stance, reasons_json, confidence, note, score_json, ip_hash, created_at, updated_at, withdrawn_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL)
         ON CONFLICT (kind, target_id, reporter) DO UPDATE SET
           stance = excluded.stance, reasons_json = excluded.reasons_json, confidence = excluded.confidence,
           note = excluded.note, score_json = excluded.score_json, ip_hash = excluded.ip_hash,
           created_at = CASE WHEN reports.withdrawn_at IS NULL THEN reports.created_at ELSE excluded.created_at END,
           updated_at = excluded.updated_at, withdrawn_at = NULL`,
      )
      .bind(kind, id, reporter, r.stance, JSON.stringify(r.reasons), r.confidence, r.note, JSON.stringify(score), ipHash, now),
    db.prepare('SELECT created_at, updated_at FROM reports WHERE kind = ? AND target_id = ? AND reporter = ?').bind(kind, id, reporter),
    reportCounts(db, kind, id),
  ]);
  const row = rowRes?.results[0] as { created_at: number; updated_at: number } | undefined;
  const res: ReportResponse = {
    ok: true,
    kind,
    id,
    stance: r.stance,
    reasons: r.reasons,
    confidence: r.confidence,
    createdAt: Number(row?.created_at ?? now),
    updatedAt: Number(row?.updated_at ?? now),
    counts: countsFrom(countRes?.results[0]),
  };
  return c.json(res);
});

reports.delete('/api/reports/:kind/:id', async (c) => {
  const w = await who(c);
  if ('error' in w) return w.error;
  const { kind, id, reporter } = w;
  const now = Date.now();
  const db = c.env.DB;
  const [upd, countRes] = await db.batch([
    db.prepare('UPDATE reports SET withdrawn_at = ? WHERE kind = ? AND target_id = ? AND reporter = ? AND withdrawn_at IS NULL').bind(now, kind, id, reporter),
    reportCounts(db, kind, id),
  ]);
  if (!(upd?.meta?.changes ?? 0)) return c.json({ error: 'not_reported' }, 404);
  const res: WithdrawResponse = { ok: true, counts: countsFrom(countRes?.results[0]) };
  return c.json(res);
});
