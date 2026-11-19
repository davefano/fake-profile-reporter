// The LinkedIn data layer must stay reusable: it may not depend on scoring.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

describe('layers', () => {
  test('src/linkedin imports nothing from src/scam', () => {
    const offenders = files(join(SRC, 'linkedin')).filter((f) => /from ['"][./]*(?:\.\.\/)+scam\b|from ['"]\.\.\/(?:\.\.\/)*scam\//.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
