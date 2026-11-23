// The shape every suspicion score shares: explained signals, a 0–100 total,
// a level, and the evidence that couldn't be checked.

export type RiskLevel = 'low' | 'medium' | 'high';

export const HIGH_THRESHOLD = 60;
export const MEDIUM_THRESHOLD = 30;

export function levelFor(score: number): RiskLevel {
  return score >= HIGH_THRESHOLD ? 'high' : score >= MEDIUM_THRESHOLD ? 'medium' : 'low';
}


export const SCORE_VERSION = 4;

/**
 * - `discrepancy`: the profile's claims don't fit together. A verification task, not proof.
 * - `weak`: thin or new footprint. Weak alone; real newcomers look like this too.
 * - `trust`: evidence that lowers suspicion.
 */
export type SignalKind = 'discrepancy' | 'weak' | 'trust';

export interface Signal {
  id: string;
  label: string;
  weight: number;
  kind: SignalKind;
}

export interface Score {
  version: typeof SCORE_VERSION;
  score: number;
  level: RiskLevel;
  signals: Signal[];
  /** Evidence we could not inspect. Unverified, so it adds no suspicion. */
  missing: string[];
}

// A discrepancy this strong keeps the level at least medium, however much
// trust the rest of the profile earns.
const OVERRIDE_WEIGHT = 15;

/**
 * `add(id, label, weight, kind?)`. Without an explicit kind: negative weights
 * are trust, `pattern.*` ids are discrepancies, everything else is weak.
 */
export function signalAdder(signals: Signal[]) {
  return (id: string, label: string, weight: number, kind?: SignalKind) =>
    signals.push({ id, label, weight, kind: kind ?? (weight < 0 ? 'trust' : id.startsWith('pattern.') ? 'discrepancy' : 'weak') });
}

/** Sum, clamp, sort, and apply the discrepancy override. Shared by every scorer. */
export function finishScore(signals: Signal[], missing: string[]): Score {
  const raw = signals.reduce((s, x) => s + x.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  let level = levelFor(score);
  if (level === 'low' && signals.some((x) => x.kind === 'discrepancy' && x.weight >= OVERRIDE_WEIGHT)) level = 'medium';
  return { version: SCORE_VERSION, score, level, signals, missing };
}
