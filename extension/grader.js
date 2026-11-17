// Rule-based "fakeness" grader. Shared by the Chrome extension (live preview)
// and the Cloudflare Worker (authoritative scoring at report time).
//
// Works as an ES module in browsers/workers. Also exposed as a plain function.

const CRYPTO = [
  'crypto', 'web3', 'nft', 'token', 'blockchain', 'defi', 'coin', 'bitcoin',
  'ethereum', 'airdrop', 'metaverse',
];

const GURU = [
  'guru', 'evangelist', 'visionary', 'thought leader', 'disruptor',
  'serial entrepreneur', 'futurist', 'influencer', 'coach', 'mentor',
  'founder & ceo', 'chief visionary', 'change maker',
];

const BUZZ = [
  'ai enthusiast', 'passionate about', 'helping businesses', 'growth hacker',
  'digital marketing expert', 'open to opportunities', 'dm me',
  'let\'s connect', 'synergy', 'leveraging', 'empowering',
];

function countMatches(haystack, needles) {
  const s = (haystack || '').toLowerCase();
  let n = 0;
  const hits = [];
  for (const needle of needles) {
    if (s.includes(needle)) {
      n++;
      hits.push(needle.trim());
    }
  }
  return { n, hits };
}

function digits(str) {
  if (str == null) return null;
  const m = String(str).replace(/[^0-9]/g, '');
  return m ? parseInt(m, 10) : null;
}

/**
 * @param {object} p
 * @param {string} [p.name]
 * @param {string} [p.headline]
 * @param {string} [p.about]
 * @param {number} [p.connections]
 * @param {number} [p.followers]
 * @param {boolean} [p.hasPhoto]
 * @param {string} [p.photoUrl]
 * @param {number} [p.endorsements]
 * @param {number} [p.experienceCount]
 * @param {number} [p.accountAgeDays]
 * @returns {{ score:number, level:'low'|'medium'|'high', reasons:Array<{label:string, weight:number}>, signals:object }}
 */
export function gradeProfile(p = {}) {
  const reasons = [];
  let score = 0;

  const add = (label, weight) => {
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

  const conns = p.connections != null ? p.connections : digits(p.connectionsText);
  if (conns != null) {
    if (conns <= 10) add(`Very few connections (${conns})`, 20);
    else if (conns < 100) add(`Low connection count (${conns})`, 10);
    else if (conns > 25000) add(`Suspiciously high connections (${conns})`, 10);
  } else {
    add('Connection count unavailable', 5);
  }

  const hasPhoto = p.hasPhoto != null ? p.hasPhoto : !!(p.photoUrl && !/ghost/i.test(p.photoUrl));
  if (!hasPhoto) add('No profile photo', 15);
  else if (p.photoUrl && p.photoUrl.length < 60) add('Placeholder/short photo URL', 5);

  const endorsements = p.endorsements != null ? p.endorsements : null;
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
  const level = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';

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

export default gradeProfile;
