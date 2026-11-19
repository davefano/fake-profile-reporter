// Word lists for text signals. Weak on their own; real people use buzzwords too.

export const CRYPTO = [
  'crypto', 'web3', 'nft', 'token', 'blockchain', 'defi', 'coin', 'bitcoin',
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

export function countMatches(haystack: string, needles: string[]): { n: number; hits: string[] } {
  const s = (haystack || '').toLowerCase();
  let n = 0;
  const hits: string[] = [];
  for (const needle of needles) {
    if (s.includes(needle)) {
      n++;
      hits.push(needle.trim());
    }
  }
  return { n, hits };
}

