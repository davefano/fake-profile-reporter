import { describe, expect, test } from 'bun:test';
import { BUZZ, CRYPTO, GURU, countMatches } from '../src/scam/wordlists';

const hits = (text: string, list: string[]) => countMatches(text, list).hits;

describe('countMatches', () => {
  test('matches whole words, any case, plural ok', () => {
    expect(hits('Building DeFi and NFTs on Ethereum', CRYPTO)).toEqual(['nft', 'defi', 'ethereum']);
    expect(hits('Career coach and mentor', GURU)).toEqual(['coach', 'mentor']);
  });

  test('ignores the same letters inside other words', () => {
    expect(hits('Defined data owners, required information, validation processes', CRYPTO)).toEqual([]);
    expect(hits('Applied cryptography; events coincide; coined the term; Coinbase alumni', CRYPTO)).toEqual([]);
    expect(hits('Coaching teams; mentorship programs', GURU)).toEqual([]);
  });

  test('auth tokens are not crypto', () => {
    expect(hits('Built token-based auth and OAuth token refresh', CRYPTO)).toEqual([]);
  });

  test('phrases tolerate extra spaces and curly apostrophes', () => {
    expect(hits('Thought   leader in fintech', GURU)).toEqual(['thought leader']);
    expect(hits('Let’s connect!', BUZZ)).toEqual(["let's connect"]);
  });
});
