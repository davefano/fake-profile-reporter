// Word lists for text signals. Weak on their own; real people use buzzwords too.

// No "token": engineers write about auth tokens far more than scammers do.
export const CRYPTO = [
  'crypto', 'web3', 'nft', 'blockchain', 'defi', 'coin', 'bitcoin',
  'ethereum', 'airdrop', 'metaverse',
];

export const GURU = [
  'guru', 'evangelist', 'visionary', 'thought leader', 'disruptor',
  'serial entrepreneur', 'futurist', 'influencer', 'coach', 'mentor',
  'founder & ceo', 'chief visionary', 'change maker',
];

export const BUZZ = [
  'ai enthusiast', 'passionate about', 'helping businesses', 'growth hacker',
  'digital marketing expert', 'open to opportunities', 'dm me',
  'let\'s connect', 'synergy', 'leveraging', 'empowering',
];

/**
 * Which phrases appear as whole words (a plural "s" is fine), ignoring case:
 * "defi" matches "DeFi" but not "define", "crypto" not "cryptography".
 */
export function countMatches(haystack: string, needles: string[]): { n: number; hits: string[] } {
  const s = (haystack || '').replace(/[‘’]/g, "'"); // LinkedIn text often uses curly apostrophes
  const hits = needles.filter((needle) => wholeWord(needle).test(s)).map((n) => n.trim());
  return { n: hits.length, hits };
}

const cache = new Map<string, RegExp>();
function wholeWord(phrase: string): RegExp {
  let re = cache.get(phrase);
  if (!re) {
    const body = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}s?(?![\\p{L}\\p{N}])`, 'iu');
    cache.set(phrase, re);
  }
  return re;
}
