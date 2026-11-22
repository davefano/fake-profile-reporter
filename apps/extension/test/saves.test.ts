import { describe, expect, test } from 'bun:test';
import { normalizeServer } from '../lib/saves/settings';
import { exportFile, mergeItem, parseExport, pendingFor, saveStore, type Area, type SavedItem } from '../lib/saves/store';

function fakeArea(): Area {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
  };
}

const item = (o: Partial<SavedItem> = {}): SavedItem => ({
  key: 'company:example-brand-careers',
  kind: 'company',
  url: 'https://www.linkedin.com/company/example-brand-careers/',
  name: 'Example Brand Careers',
  detail: 'Software Development',
  score: 72,
  level: 'high',
  savedAt: 1_000,
  reportedAt: null,
  uploadedTo: [],
  payload: { kind: 'company', id: '4242', facts: {} as any },
  ...o,
});

describe('normalizeServer', () => {
  test('keeps only the origin and defaults to https', () => {
    expect(normalizeServer('reports.example.org/')).toBe('https://reports.example.org');
    expect(normalizeServer(' http://host.example:8787/api/health ')).toBe('http://host.example:8787');
  });
  test('rejects what is not a web address', () => {
    expect(normalizeServer('')).toBeNull();
    expect(normalizeServer('ftp://host.example')).toBeNull();
    expect(normalizeServer('javascript:alert(1)')).toBeNull();
    expect(normalizeServer('http://')).toBeNull();
  });
});

describe('saveStore', () => {
  test('lists newest first and updates in place', async () => {
    const s = saveStore(fakeArea());
    await s.put(item());
    await s.put(item({ key: 'job:4400000009', kind: 'job', url: 'https://www.linkedin.com/jobs/view/4400000009/', savedAt: 2_000, payload: { kind: 'job', id: '4400000009', facts: {} as any, company: null } }));
    await s.put(item({ savedAt: 3_000, score: 80 }));
    const list = await s.list();
    expect(list.map((i) => [i.key, i.savedAt])).toEqual([
      ['company:example-brand-careers', 3_000],
      ['job:4400000009', 2_000],
    ]);
  });

  test('tracks which servers have each save', async () => {
    const s = saveStore(fakeArea());
    await s.put(item());
    await s.markUploaded(item().key, 'https://a.example');
    await s.markUploaded(item().key, 'https://a.example');
    const list = await s.list();
    expect(list[0]!.uploadedTo).toEqual(['https://a.example']);
    expect(pendingFor(list, 'https://a.example')).toEqual([]);
    expect(pendingFor(list, 'https://b.example')).toHaveLength(1);
  });

  test('merge adds new items, keeps the newer save, and never drops a report', async () => {
    const s = saveStore(fakeArea());
    await s.put(item({ savedAt: 5_000, reportedAt: 4_000 }));
    const res = await s.merge([item({ savedAt: 6_000, score: 10, level: 'low' }), item({ key: 'company:other', url: 'https://www.linkedin.com/company/other/' })]);
    expect(res).toEqual({ added: 1, updated: 1 });
    const got = await s.get(item().key);
    expect(got).toMatchObject({ savedAt: 6_000, score: 10, reportedAt: 4_000 });
    expect(await s.merge([item({ savedAt: 1_000 })])).toEqual({ added: 0, updated: 0 });
  });
});

describe('mergeItem', () => {
  test('unions uploads only for the same save', () => {
    expect(mergeItem(item({ uploadedTo: ['a'] }), item({ uploadedTo: ['b'] })).uploadedTo.sort()).toEqual(['a', 'b']);
    expect(mergeItem(item({ uploadedTo: ['a'] }), item({ savedAt: 2_000, uploadedTo: [] })).uploadedTo).toEqual([]);
  });
});

describe('export and import', () => {
  test('round trips', () => {
    const items = [item(), item({ key: 'profile:someone', kind: 'profile', url: 'https://uk.linkedin.com/in/someone/', payload: { kind: 'profile', snapshotGzipBase64: 'H4sI' } })];
    expect(parseExport(exportFile(items))).toEqual({ items, skipped: 0 });
  });

  test('reads exports made under the old name', () => {
    const old = exportFile([item()]).replace('fake-profile-reporter/saves', 'fake-linkedin-reporter/saves');
    expect(parseExport(old)).toEqual({ items: [item()], skipped: 0 });
  });

  test('rejects other files and skips items that do not look right', () => {
    expect(() => parseExport('{nope')).toThrow("isn't JSON");
    expect(() => parseExport('{"items":[]}')).toThrow("isn't a Fake Profile Reporter export");
    expect(() => parseExport(JSON.stringify({ format: 'fake-profile-reporter/saves', version: 2, items: [] }))).toThrow('newer version');
    const bad = [
      item({ url: 'https://evil.example/company/x/' }),
      item({ url: 'javascript:alert(1)' }),
      item({ level: 'severe' as any }),
      item({ key: 'job:1' }),
      { ...item(), payload: { kind: 'job', id: '1', facts: {} } },
    ];
    const text = exportFile([item(), ...(bad as SavedItem[])]);
    expect(parseExport(text)).toEqual({ items: [item()], skipped: bad.length });
  });
});
