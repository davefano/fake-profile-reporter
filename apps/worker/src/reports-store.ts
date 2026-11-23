// Report counts for a target, shared by every route that shows a target.

import type { ReportCounts, ReportKind } from '@fpr/core';

/** A statement counting a target's active reports by stance (for db.batch or .first()). */
export const reportCounts = (db: D1Database, kind: ReportKind, id: string) =>
  db
    .prepare(
      `SELECT COALESCE(SUM(stance = 'report'), 0) AS reports, COALESCE(SUM(stance = 'impersonated'), 0) AS impersonated,
              COALESCE(SUM(stance = 'vouch'), 0) AS vouches
       FROM reports WHERE kind = ? AND target_id = ? AND withdrawn_at IS NULL`,
    )
    .bind(kind, id);

export function countsFrom(row: unknown): ReportCounts {
  const r = (row ?? {}) as Partial<Record<keyof ReportCounts, number>>;
  return { reports: Number(r.reports ?? 0), impersonated: Number(r.impersonated ?? 0), vouches: Number(r.vouches ?? 0) };
}
