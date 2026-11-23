// What a person can say about a profile, company or job: that it looks
// suspicious, that someone used this person's identity to contact them, or
// that they know it's real. Shared by the extension (the form) and the worker
// (validation), so both accept exactly the same choices.

export type ReportStance = 'report' | 'impersonated' | 'vouch';
export type ReportConfidence = 'suspected' | 'confirmed';
export type ReportKind = 'profile' | 'company' | 'job';

export interface ReportReason {
  id: string;
  label: string;
}

export const REPORT_REASONS: readonly ReportReason[] = [
  { id: 'fake-recruiter', label: 'Fake recruiter or job offer' },
  { id: 'fake-applicant', label: 'Fake job applicant' },
  { id: 'impersonates-someone', label: 'Copies or pretends to be a real person' },
  { id: 'asked-money', label: 'Asked for money, gift cards, crypto, or to buy equipment' },
  { id: 'off-platform', label: 'Moved the conversation to Telegram, WhatsApp or Signal' },
  { id: 'details-dont-add-up', label: "Profile details don't add up" },
  { id: 'bought-account', label: 'Looks like a bought or taken-over account' },
  { id: 'other', label: 'Other' },
];

/**
 * "Someone used this person's identity to contact me." The profile belongs to
 * the victim of the impersonation, so this is shown as a warning and never
 * counts against the profile.
 */
export const IMPERSONATED_REASONS: readonly ReportReason[] = [
  { id: 'contacted-me', label: 'Someone using their name or photo contacted me' },
  { id: 'fake-copy', label: 'There is a copy of this profile' },
  { id: 'other', label: 'Other' },
];

export const VOUCH_REASONS: readonly ReportReason[] = [
  { id: 'know-personally', label: 'I know them personally' },
  { id: 'worked-together', label: 'We worked together' },
  { id: 'verified-on-call', label: 'Verified them on a video call' },
  { id: 'other', label: 'Other' },
];

export const NOTE_MAX = 500;

/** The stances each kind of target accepts: impersonation only applies to people. */
export function stancesFor(kind: ReportKind): ReportStance[] {
  return kind === 'profile' ? ['report', 'impersonated', 'vouch'] : ['report', 'vouch'];
}

export function reasonsFor(stance: ReportStance): readonly ReportReason[] {
  return stance === 'report' ? REPORT_REASONS : stance === 'vouch' ? VOUCH_REASONS : IMPERSONATED_REASONS;
}

export const reasonLabel = (stance: ReportStance, id: string) => reasonsFor(stance).find((r) => r.id === id)?.label ?? id;

export interface ReportCounts {
  /** Active "looks suspicious" reports: the only ones that count against the target. */
  reports: number;
  /** Active "someone used this person's identity" reports. */
  impersonated: number;
  vouches: number;
}

export interface CleanReport {
  stance: ReportStance;
  reasons: string[];
  confidence: ReportConfidence | null;
  note: string | null;
}

/**
 * Check a report against the lists. Returns the cleaned report, or an error
 * code: unknown stance or reason, no reasons, or a stance the target can't take.
 */
export function cleanReport(kind: ReportKind, v: unknown): CleanReport | { error: string } {
  const r = v as { stance?: unknown; reasons?: unknown; confidence?: unknown; note?: unknown } | null;
  if (!r || typeof r !== 'object') return { error: 'bad_report' };
  const stance = r.stance as ReportStance;
  if (!stancesFor(kind).includes(stance)) return { error: 'bad_stance' };
  if (!Array.isArray(r.reasons) || !r.reasons.length || r.reasons.length > 20) return { error: 'bad_reasons' };
  const allowed = new Set(reasonsFor(stance).map((x) => x.id));
  if (!r.reasons.every((x) => typeof x === 'string' && allowed.has(x))) return { error: 'bad_reasons' };
  const reasons = [...new Set(r.reasons as string[])];
  let confidence: ReportConfidence | null = null;
  if (stance === 'report') {
    if (r.confidence !== undefined && r.confidence !== 'suspected' && r.confidence !== 'confirmed') return { error: 'bad_confidence' };
    confidence = (r.confidence as ReportConfidence | undefined) ?? 'suspected';
  }
  if (r.note != null && typeof r.note !== 'string') return { error: 'bad_note' };
  const note = typeof r.note === 'string' ? r.note.trim().slice(0, NOTE_MAX) || null : null;
  return { stance, reasons, confidence, note };
}
