// Legacy v0 grader for the old page-scraped ProfileObservation (still used by
// /api/report and the leaderboard). New scoring lives in profile.ts.
//
// Rule-based "fakeness" grader. Shared by the Chrome extension (live preview)
// and the Cloudflare Worker (authoritative scoring at report time).
//
import type { GradeReason, GradeResult, ProfileObservation } from '../types';
import { levelFor } from './signals';
import { BUZZ, CRYPTO, GURU, countMatches } from './wordlists';

function digits(str: string | null | undefined): number | null {
  if (str == null) return null;
  const m = String(str).replace(/[^0-9]/g, '');
  return m ? parseInt(m, 10) : null;
}

export function gradeProfile(p: ProfileObservation = {}): GradeResult {
  const reasons: GradeReason[] = [];
  let score = 0;

  const add = (label: string, weight: number) => {
    score += weight;
    reasons.push({ label, weight });
  };

  const headline = p.headline || '';
  const about = p.about || '';
  const allText = [p.name, headline, about].filter(Boolean).join(' \n ');

  const crypto = countMatches(allText, CRYPTO);
  if (crypto.n > 0) add(`Crypto/web3 buzzwords (${crypto.hits.join(', ')})`, Math.min(25, crypto.n * 8));

  const guru = countMatches(allText, GURU);
  if (guru.n > 0) add(`Guru/self-promo language (${guru.hits.join(', ')})`, Math.min(20, guru.n * 6));

  const buzz = countMatches(allText, BUZZ);
  if (buzz.n > 0) add(`Generic buzzphrases (${buzz.hits.join(', ')})`, Math.min(15, buzz.n * 5));

  const conns = p.connections ?? digits(p.connectionsText);
  if (conns != null) {
    if (conns <= 10) add(`Very few connections (${conns})`, 20);
    else if (conns < 100) add(`Low connection count (${conns})`, 10);
    else if (conns > 25000) add(`Suspiciously high connections (${conns})`, 10);
  } else {
    add('Connection count unavailable', 5);
  }

  const hasPhoto = p.hasPhoto ?? !!(p.photoUrl && !/ghost/i.test(p.photoUrl));
  if (!hasPhoto) add('No profile photo', 15);
  else if (p.photoUrl && p.photoUrl.length < 60) add('Placeholder/short photo URL', 5);

  const endorsements = p.endorsements ?? null;
  if (endorsements === 0) add('Zero endorsements', 8);
  else if (endorsements != null && endorsements < 3) add(`Very few endorsements (${endorsements})`, 4);

  const exp = p.experienceCount;
  if (exp === 0) add('No experience listed', 12);
  else if (exp === 1) add('Only one experience entry', 4);

  const age = p.accountAgeDays;
  if (age != null) {
    if (age < 30) add(`New account (~${age} days old)`, 18);
    else if (age < 180) add(`Recent account (~${age} days old)`, 8);
  }

  const aboutLen = about.trim().length;
  if (aboutLen === 0) add('Empty "About" section', 6);
  else if (aboutLen < 40) add('Very short "About" section', 3);

  if ((p.name || '').trim().length <= 3) add('Extremely short name', 6);

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = levelFor(score);

  return {
    score,
    level,
    reasons: reasons.sort((a, b) => b.weight - a.weight),
    signals: {
      cryptoHits: crypto.hits,
      guruHits: guru.hits,
      buzzHits: buzz.hits,
      connections: conns,
      hasPhoto,
      endorsements,
      experienceCount: exp ?? null,
      accountAgeDays: age ?? null,
      aboutLength: aboutLen,
    },
  };
}

