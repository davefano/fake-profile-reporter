import { describe, expect, test } from 'bun:test';
import { gradeProfile } from './grader';
import { levelFor } from './signals';

describe('gradeProfile', () => {
  test('a well-established profile scores low with no reasons', () => {
    const g = gradeProfile({
      name: 'Bob Real',
      headline: 'Engineer',
      about: 'I write code and ship things reliably every week.',
      connections: 500,
      hasPhoto: true,
      endorsements: 20,
      experienceCount: 3,
      accountAgeDays: 1500,
    });
    expect(g.score).toBe(0);
    expect(g.level).toBe('low');
    expect(g.reasons).toEqual([]);
  });

  test('stacks suspicious signals and sorts reasons by weight', () => {
    const g = gradeProfile({
      name: 'Jane',
      headline: 'AI Enthusiast | Crypto Guru | DM me',
      about: '',
      connections: 4,
      hasPhoto: false,
      endorsements: 0,
      experienceCount: 1,
    });
    expect(g.score).toBe(77);
    expect(g.level).toBe('high');
    expect(g.reasons[0]).toEqual({ label: 'Very few connections (4)', weight: 20 });
    const weights = g.reasons.map((r) => r.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  test('caps keyword categories and clamps the total to 100', () => {
    const g = gradeProfile({
      headline: 'crypto web3 nft token blockchain defi bitcoin ethereum',
      connections: 1,
      hasPhoto: false,
      endorsements: 0,
      experienceCount: 0,
      accountAgeDays: 3,
    });
    expect(g.reasons.find((r) => r.label.startsWith('Crypto'))?.weight).toBe(25);
    expect(g.score).toBe(100);
  });

  test('falls back to connectionsText when no number is given', () => {
    expect(gradeProfile({ connectionsText: '42 connections' }).signals.connections).toBe(42);
  });

  test('treats ghost avatar URLs as no photo', () => {
    expect(gradeProfile({ photoUrl: 'https://static.licdn.com/ghost-person.png' }).signals.hasPhoto).toBe(false);
  });
});

test('levelFor thresholds', () => {
  expect(levelFor(29)).toBe('low');
  expect(levelFor(30)).toBe('medium');
  expect(levelFor(59)).toBe('medium');
  expect(levelFor(60)).toBe('high');
});
