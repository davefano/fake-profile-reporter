import { beforeEach, describe, expect, test } from 'bun:test';
import type { CompanyFacts, JobFacts } from '@flr/core';
import app from '../src/index';
import type { Env } from '../src/env';
import { createTestD1, createTestKv, createTestR2 } from './d1-sqlite';

let env: Env;
beforeEach(() => {
  env = { DB: createTestD1(), RATE_KV: createTestKv(), SNAPSHOTS: createTestR2(), IP_SALT: 'test' };
});

const company = (o: Partial<CompanyFacts> = {}): CompanyFacts => ({
  companyId: 4242,
  slug: 'example-brand-careers',
  name: 'Example Brand Careers',
  tagline: null,
  industry: 'Software Development',
  headquarters: null,
  type: 'Privately Held',
  foundedYear: 2001,
  claimedSize: { min: 1001, max: 5000, label: '1,001-5,000 employees' },
  employeesOnLinkedIn: 2,
  followers: 12,
  website: null,
  specialties: [],
  logo: { present: false, uploadedAt: null, url: null },
  posts: { count: 0, newestAt: null },
  ...o,
});

const job = (o: Partial<JobFacts> = {}): JobFacts => ({
  jobId: '4400000009',
  title: 'Remote Data Entry Clerk',
  company: { name: 'Example Brand Careers', slug: 'example-brand-careers' },
  location: 'Remote',
  postedText: '1 day ago',
  postedAt: Date.now() - 86_400_000,
  reposted: false,
  applicants: { count: 25, over: false },
  seniority: 'Entry level',
  employmentType: 'Full-time',
  jobFunction: null,
  industries: null,
  salary: null,
  apply: 'easy',
  description: 'Interview will be conducted via Telegram. We will send you a check to purchase equipment. '.repeat(6),
  contacts: { emails: [], phones: [], urls: [] },
  ...o,
});

const post = (body: unknown, ip = '1.1.1.1') =>
  app.request('/api/entities', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }, env);

describe('POST /api/entities', () => {
  test('stores a company and recomputes its score', async () => {
    const res = await post({ kind: 'company', id: '4242', facts: company(), report: false, score: { score: 0 } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.score.level).toBe('high'); // ours, not the client's 0

    const got = (await (await app.request('/api/entities/company/4242', {}, env)).json()) as any;
    expect(got).toMatchObject({ name: 'Example Brand Careers', observations: 1, reports: 0 });
    expect(got.url).toBe('https://www.linkedin.com/company/example-brand-careers/');
  });

  test('reports a job, scoring it with its company', async () => {
    const res = await post({ kind: 'job', id: '4400000009', facts: job(), company: company(), report: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.score.level).toBe('high');
    expect(body.score.signals.map((s: any) => s.id)).toEqual(expect.arrayContaining(['job.chat-app', 'job.pay-to-work', 'job.company-suspicious']));
    const got = (await (await app.request('/api/entities/job/4400000009', {}, env)).json()) as any;
    expect(got.reports).toBe(1);
  });

  test('rate limits: one report per IP per day, observations every 10 minutes', async () => {
    expect((await post({ kind: 'company', id: '4242', facts: company(), report: true })).status).toBe(201);
    expect((await post({ kind: 'company', id: '4242', facts: company(), report: true })).status).toBe(429);
    expect((await post({ kind: 'company', id: '4242', facts: company(), report: false })).status).toBe(429);
    expect((await post({ kind: 'company', id: '4242', facts: company(), report: true }, '2.2.2.2')).status).toBe(201);
    const got = (await (await app.request('/api/entities/company/4242', {}, env)).json()) as any;
    expect(got.reports).toBe(2);
  });

  test('rejects malformed or mismatched submissions', async () => {
    expect((await post({ kind: 'person', id: '1', facts: {} })).status).toBe(400);
    expect((await post({ kind: 'company', id: '9999', facts: company() })).status).toBe(400); // id ≠ facts
    expect((await post({ kind: 'job', id: 'abc', facts: job() })).status).toBe(400);
    expect((await post({ kind: 'job', id: '4400000001', facts: job() })).status).toBe(400); // id ≠ jobId
    const r = await app.request('/api/entities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }, env);
    expect(r.status).toBe(400);
  });

  test('unknown entities are 404', async () => {
    expect((await app.request('/api/entities/job/1', {}, env)).status).toBe(404);
  });
});
