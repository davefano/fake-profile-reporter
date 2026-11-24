// The shape every suspicion score shares: explained signals, a 0–100 total,
// a level, and the evidence that couldn't be checked.

export type RiskLevel = 'low' | 'medium' | 'high';

export const HIGH_THRESHOLD = 60;
export const MEDIUM_THRESHOLD = 30;

export function levelFor(score: number): RiskLevel {
  return score >= HIGH_THRESHOLD ? 'high' : score >= MEDIUM_THRESHOLD ? 'medium' : 'low';
}


export const SCORE_VERSION = 6;

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
  /** Set by scorers on patterns and verifications. Absent: |weight| ≥ 12 reads as major. */
  strength?: 'major' | 'minor';
  /** A second line: why the signal matters. */
  detail?: string;
  /** The lowest level this signal allows, whatever the number says. */
  floor?: Exclude<RiskLevel, 'low'>;
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
const MEDIUM_FLOOR_WEIGHT = 15;

export type SignalOptions = Pick<Signal, 'strength' | 'detail' | 'floor'> & { kind?: SignalKind };

/**
 * `add(id, label, weight, kindOrOptions?)`. Without an explicit kind: negative
 * weights are trust, `pattern.*` ids are discrepancies, everything else is weak.
 * A discrepancy of weight ≥ 15 gets a medium floor unless one is given.
 */
export function signalAdder(signals: Signal[]) {
  return (id: string, label: string, weight: number, opts?: SignalKind | SignalOptions) => {
    const { kind: k, ...extra } = typeof opts === 'string' ? { kind: opts } : (opts ?? {});
    const kind = k ?? (weight < 0 ? 'trust' : id.startsWith('pattern.') ? 'discrepancy' : 'weak');
    const signal: Signal = { id, label, weight, kind };
    const floor = extra.floor ?? (kind === 'discrepancy' && weight >= MEDIUM_FLOOR_WEIGHT ? 'medium' : undefined);
    if (extra.strength) signal.strength = extra.strength;
    if (extra.detail) signal.detail = extra.detail;
    if (floor) signal.floor = floor;
    signals.push(signal);
  };
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Sum, clamp, sort, and raise the level to the highest floor. Shared by every scorer. */
export function finishScore(signals: Signal[], missing: string[]): Score {
  const raw = signals.reduce((s, x) => s + x.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  let level = levelFor(score);
  for (const x of signals) if (x.floor && RANK[x.floor] > RANK[level]) level = x.floor;
  return { version: SCORE_VERSION, score, level, signals, missing };
}
