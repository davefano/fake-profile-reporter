import { describe, expect, test } from 'bun:test';
import { captureProfile, carryForwardProfile, diffProfileFacts, observeProfile, estimateJoinedAt, extractProfileFacts, memberIdFromProfileId, parseAbout, parseCountText, postTimestampMs, rscTexts } from '../src/linkedin';
import { scoreProfile } from '../src/scam';
import { DAY, fakeSnapshot, postIdAt, profileIdFor } from './fixtures';

const NOW = Date.UTC(2026, 10, 17);

describe('ids', () => {
  test('member ID round-trips through a profile ID', () => {
    for (const id of [1, 251_749_025, 810_000_000, 4_000_000_000]) {
      expect(memberIdFromProfileId(profileIdFor(id))).toBe(id);
    }
  });

  test('rejects junk profile IDs', () => {
    expect(memberIdFromProfileId('')).toBeNull();
    expect(memberIdFromProfileId('not an id!')).toBeNull();
    expect(memberIdFromProfileId('ACoAA')).toBeNull();
  });

  test('post IDs encode their creation time', () => {
    const t = Date.UTC(2026, 10, 14, 18, 11, 59, 974);
    expect(postTimestampMs(postIdAt(t))).toBe(t);
  });
});

test('estimateJoinedAt interpolates between calibration points', () => {
  expect(new Date(estimateJoinedAt(251_749_025, NOW)!).toISOString().slice(0, 7)).toBe('2013-05');
  const mid = estimateJoinedAt(531_000_000, NOW)!;
  expect(mid).toBeGreaterThan(Date.UTC(2016, 0, 1));
  expect(mid).toBeLessThan(Date.UTC(2017, 11, 31));
  expect(estimateJoinedAt(1, NOW)).toBe(Date.UTC(2003, 4, 5)); // member 1 = launch
  expect(estimateJoinedAt(9_000_000_000, NOW)).toBeLessThan(NOW); // never in the future
});

describe('rsc', () => {
  test('rscTexts skips references and decodes escapes', () => {
    const s = '0:["$","p",null,{"children":["$L1"]}]\n1:["$","p",null,{"children":["Alex doesn\\u2019t have any"]}]';
    expect(rscTexts(s)).toEqual(['Alex doesn’t have any']);
  });

  test('parseCountText', () => {
    expect(parseCountText('500+ connections', 'connections')).toEqual({ count: 500, capped: true });
    expect(parseCountText('1 connection', 'connections')).toEqual({ count: 1, capped: false });
    expect(parseCountText('40,830,057 followers', 'followers')).toEqual({ count: 40_830_057, capped: false });
    expect(parseCountText('no numbers here', 'followers')).toBeNull();
  });

  test('parseAbout reads join date and verifications', () => {
    const s = fakeSnapshot({ joinedAt: Date.UTC(2013, 4, 15), verifications: [['Identity', 'Verified by LinkedIn in April 2026']] });
    const a = parseAbout(s.payloads.about!);
    expect(new Date(a.joinedAt!).toISOString().slice(0, 7)).toBe('2013-05');
    expect(a.verifications).toEqual(['Identity: Verified by LinkedIn in April 2026']);
    expect(parseAbout(fakeSnapshot().payloads.about!).verifications).toEqual([]);
  });
});

describe('extractProfileFacts', () => {
  test('extracts identity, history, counts, and activity', () => {
    const f = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123, postTimes: [Date.UTC(2026, 9, 1), Date.UTC(2026, 5, 1)] }), NOW);
    expect(f.memberId).toBe(700_000_123);
    expect(f.slug).toBe('jordan-sample-0a1b2c');
    expect(f.geoName).toBe('Springfield, United States');
    expect(f.industry).toBe('Software Development');
    expect(f.positions).toEqual([{ title: 'Software Engineer', company: 'Example Corp', companyId: null, start: { year: 2018, month: 1 }, end: null }]);
    expect(f.photo).toEqual({ present: true, uploadedAt: 1_600_000_000_000 });
    expect(f.connections).toEqual({ count: 500, capped: true });
    expect(f.followers).toBe(300);
    expect(f.joined?.source).toBe('about');
    expect(f.activity).toEqual({ postCount: 2, newestAt: Date.UTC(2026, 9, 1), oldestAt: Date.UTC(2026, 5, 1) });
  });

  test('falls back to a member-ID join estimate without the About payload', () => {
    const f = extractProfileFacts(fakeSnapshot({ memberId: 251_749_025, joinedAt: null }), NOW);
    expect(f.joined?.source).toBe('memberId');
    expect(f.about).toBeNull();
  });

  test('survives a snapshot where every request failed', () => {
    const f = extractProfileFacts({ schema: 1, capturedAt: NOW, slug: 'x', profileId: null, payloads: {}, errors: { fullProfile: 'HTTP 500' } }, NOW);
    expect(f.memberId).toBeNull();
    expect(f.positions).toEqual([]);
  });
});

test('diffProfileFacts reports slug, headline, and connection changes', () => {
  const a = extractProfileFacts(fakeSnapshot({ slug: 'old-slug', connections: '12 connections' }), NOW);
  const b = extractProfileFacts(fakeSnapshot({ slug: 'new-slug', headline: 'CEO', connections: '40 connections' }), NOW);
  expect(diffProfileFacts(a, b).map((c) => c.field).sort()).toEqual(['connections', 'headline', 'slug']);
  expect(diffProfileFacts(a, a)).toEqual([]);
});

test('carryForwardProfile keeps the last good values for parts that failed', () => {
  const good = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123, headline: 'Engineer' }), NOW);
  const failed = { ...good, profileLoaded: false, headline: null, firstName: null, positions: [], about: null, connections: null };
  const carried = carryForwardProfile(good, failed);
  expect(carried).toMatchObject({ profileLoaded: true, headline: 'Engineer', firstName: good.firstName, about: good.about, connections: good.connections });
  // A change made after the failed capture is still reported against the carried baseline.
  const later = { ...good, headline: 'CEO' };
  expect(diffProfileFacts(carried, later).map((c) => c.field)).toEqual(['headline']);
});

test('a failed About read keeps the join date LinkedIn gave, not the member-ID estimate', () => {
  const good = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123, joinedAt: Date.UTC(2026, 6, 15) }), NOW);
  const snap = fakeSnapshot({ memberId: 700_000_123 });
  delete snap.payloads.about;
  const failed = extractProfileFacts(snap, NOW);
  expect(failed.joined?.source).toBe('memberId');
  const { current, changes } = observeProfile(good, failed);
  expect(current.joined).toEqual({ at: Date.UTC(2026, 6, 15), source: 'about' });
  expect(changes).toEqual([]);
  expect(scoreProfile(current, NOW).score).toBe(scoreProfile(good, NOW).score);
});

test('malformed nested payloads parse to empty facts instead of throwing', () => {
  for (const payloads of [
    { resolve: { included: 'x' }, fullProfile: { included: {} } },
    { resolve: { included: [{ entityUrn: 123 }] }, fullProfile: { included: [null, 7, { $type: 'x.identity.profile.Profile', entityUrn: 5, firstName: {} }] } },
  ]) {
    const f = extractProfileFacts({ schema: 1, capturedAt: NOW, slug: 'x', profileId: null, payloads: payloads as any, errors: {} }, NOW);
    expect(f.memberId).toBeNull();
    expect(f.firstName).toBeNull();
  }
});

test('diffProfileFacts ignores parts that failed to load', () => {
  const a = extractProfileFacts(fakeSnapshot({ memberId: 700_000_123 }), NOW);
  const failed = { ...a, profileLoaded: false, headline: null, positions: [], about: null, connections: null };
  expect(diffProfileFacts(a, failed)).toEqual([]);
  expect(diffProfileFacts(failed, a)).toEqual([]);
});

describe('extractProfileFacts profile selection', () => {
  test('uses the requested profile when the payload bundles other people first', () => {
    const f = extractProfileFacts(fakeSnapshot({ strangers: 3 }), NOW);
    expect(f.slug).toBe('jordan-sample-0a1b2c');
    expect(f.firstName).toBe('Jordan');
    expect(f.positions.map((p) => p.company)).toEqual(['Example Corp']);
  });
});

describe('scoreProfile', () => {
  test('an established, verified, active account scores low', () => {
    const s = scoreProfile(
      extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2012, 0, 15), verifications: [['Identity', 'Verified by LinkedIn in May 2025']] }), NOW),
      NOW,
    );
    expect(s.score).toBe(0);
    expect(s.level).toBe('low');
  });

  test('a brand-new, empty "recruiter" with no network scores high', () => {
    const s = scoreProfile(
      extractProfileFacts(
        fakeSnapshot({
          joinedAt: NOW - 10 * DAY,
          headline: 'Senior Talent Acquisition Director | Hiring now, DM me',
          summary: null,
          photoUploadedAt: null,
          positions: [{ title: 'Director', company: 'Big Tech', startYear: 2012 }],
          educations: 0,
          skills: 0,
          connections: '3 connections',
          postTimes: [],
        }),
        NOW,
      ),
      NOW,
    );
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['age.new', 'connections.tiny', 'pattern.senior-no-network', 'pattern.career-vs-age', 'activity.none', 'photo.none']) {
      expect(ids).toContain(id);
    }
  });

  test('a months-old recruiter persona with a long big-company career scores high', () => {
    // Shape of a reported fake recruiter: complete-looking profile, nothing behind it.
    const s = scoreProfile(
      extractProfileFacts(
        fakeSnapshot({
          joinedAt: NOW - 120 * DAY,
          headline: 'Human Resources & Business Management Leader | Talent Development',
          summary: null,
          positions: [
            { title: 'HR & Business Management Leader', company: 'Example Corp', startYear: 2020, companyId: 111 },
            { title: 'HR Manager', company: 'Sample Systems', startYear: 2016, endYear: 2020, companyId: 222 },
            { title: 'HR Manager', company: 'Demo Labs', startYear: 2009, endYear: 2016, companyId: 333 },
          ],
          skills: 20,
          connections: null,
          followers: 770,
          postTimes: [],
        }),
        NOW,
      ),
      NOW,
    );
    expect(s.level).toBe('high');
    const ids = s.signals.map((x) => x.id);
    for (const id of ['age.recent', 'pattern.career-vs-age', 'pattern.recruiter-new', 'pattern.employer-unverified', 'pattern.followers-no-activity']) {
      expect(ids).toContain(id);
    }
  });

  test('workplace verification for the claimed employer clears the employer signal', () => {
    const f = extractProfileFacts(
      fakeSnapshot({
        joinedAt: NOW - 300 * DAY,
        positions: [{ title: 'Recruiter', company: 'Example Corp', startYear: 2024, companyId: 111 }],
        verifications: [['Example Corp', 'Verified using work email in March 2026']],
      }),
      NOW,
    );
    const ids = scoreProfile(f, NOW).signals.map((x) => x.id);
    expect(ids).not.toContain('pattern.employer-unverified');
    expect(ids).not.toContain('pattern.recruiter-new');
  });

  test('missing evidence is listed, not scored', () => {
    const f = extractProfileFacts(fakeSnapshot({ connections: null, headline: 'Engineer', summary: null }), NOW);
    const s = scoreProfile({ ...f, profileLoaded: false, positions: [], educations: [], skills: [], about: null, joined: null, activity: null }, NOW);
    expect(s.signals.filter((x) => x.weight > 0)).toEqual([]);
    expect(s.missing.length).toBe(5);
  });

  test('a strong discrepancy keeps the level at least medium', () => {
    const f = extractProfileFacts(
      fakeSnapshot({
        joinedAt: NOW - 200 * DAY,
        positions: [{ title: 'Engineer', company: 'Example Corp', startYear: 2010 }],
        verifications: [['Identity', 'Verified by LinkedIn in May 2026']],
        followers: 20_000,
      }),
      NOW,
    );
    const s = scoreProfile({ ...f, influencer: true }, NOW);
    expect(s.signals.find((x) => x.id === 'pattern.career-vs-age')?.kind).toBe('discrepancy');
    expect(s.score).toBeLessThan(35);
    expect(s.level).toBe('medium');
  });

  test('an old faceless, inactive account is flagged as a possible shell', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2011, 6, 15), photoUploadedAt: null, postTimes: [] }), NOW);
    const ids = scoreProfile(f, NOW).signals.map((x) => x.id);
    expect(ids).toContain('aged.shell');
    expect(ids).not.toContain('aged.refreshed');
  });

  test('an old inactive account with freshly changed contact info is flagged as refreshed', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2014, 2, 15), postTimes: [] }), NOW);
    const s = scoreProfile({ ...f, about: { ...f.about!, contactInfoUpdated: 'Updated less than 6 months ago' } }, NOW);
    expect(s.signals.find((x) => x.id === 'aged.refreshed')?.label).toContain('contact info');
  });

  test('aged-account checks leave active accounts alone', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: Date.UTC(2011, 6, 15), photoUploadedAt: null, postTimes: [NOW - 30 * DAY] }), NOW);
    const ids = scoreProfile({ ...f, about: { ...f.about!, contactInfoUpdated: 'Updated less than 6 months ago' } }, NOW).signals.map((x) => x.id);
    expect(ids.filter((id) => id.startsWith('aged.'))).toEqual([]);
  });

  test('a recruiter is not penalized for verifications that were never read', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: null, headline: 'Senior Recruiter' }), NOW);
    const ids = scoreProfile({ ...f, about: null, joined: { at: NOW - 100 * DAY, source: 'memberId' } }, NOW).signals.map((x) => x.id);
    expect(ids).not.toContain('pattern.recruiter-new');
    expect(ids).not.toContain('pattern.recruiter-unverified');
  });

  test('member-ID age estimates count for half', () => {
    const f = extractProfileFacts(fakeSnapshot({ joinedAt: null }), NOW);
    const sig = scoreProfile({ ...f, joined: { at: NOW - 10 * DAY, source: 'memberId' } }, NOW).signals.find((x) => x.id === 'age.new');
    expect(sig?.weight).toBe(17.5);
  });
});

test('captureProfile makes the expected requests and assembles a snapshot', async () => {
  const fixture = fakeSnapshot();
  const calls: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    const p = fixture.payloads;
    const json = (b: unknown) => new Response(JSON.stringify(b));
    if (url.includes('graphql')) return json(p.resolve);
    if (url.includes('dash/profiles')) return json(p.fullProfile);
    if (url.includes('followingStates')) return json(p.followingState);
    if (url.includes('ProfileVerificationDetailsDialog')) return new Response(p.about);
    if (url.includes('profileCardsActivity')) return new Response(p.activity);
    if (url.startsWith('/in/')) return new Response(
        // Real markup splits the number from the word.
        '<p class="a">300 followers</p><span>·</span><p class="b">500+</p></div><a href="#"><p class="c">connections</p>' +
          '<span><strong>Sam</strong> are mutual connections</span>',
      );
    return new Response('nope', { status: 404 });
  }) as typeof fetch;

  const snap = await captureProfile('jordan-sample-0a1b2c', { fetch: fakeFetch, csrf: 'ajax:test' });
  expect(snap.errors).toEqual({});
  expect(snap.profileId).toBe(fixture.profileId);
  expect(snap.payloads.profilePageCounts).toEqual(['300 followers', '500+ connections']);
  expect(calls).toHaveLength(6);
  expect(extractProfileFacts(snap, NOW).memberId).toBe(700_000_001);
});
