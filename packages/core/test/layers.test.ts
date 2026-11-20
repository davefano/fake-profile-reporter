// The LinkedIn data layer must stay reusable: it may not depend on scoring or
// anything outside itself. Scoring may read LinkedIn types but never fetch.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SRC = join(import.meta.dir, '../src');

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

export function imports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

/** Imports from `dir` that leave it: relative paths outside it, or any package. */
function leaving(dir: string, allowPackages: (spec: string) => boolean = () => false) {
  return sourceFiles(dir).flatMap((f) =>
    imports(f)
      .filter((spec) => (spec.startsWith('.') ? !resolve(dirname(f), spec).startsWith(dir + sep) : !allowPackages(spec)))
      .map((spec) => `${relative(SRC, f)} -> ${spec}`),
  );
}

describe('layers', () => {
  test('src/linkedin imports nothing outside itself', () => {
    expect(leaving(join(SRC, 'linkedin'))).toEqual([]);
  });

  test('src/scam imports only its own files and LinkedIn facts types (never a reader)', () => {
    const scam = join(SRC, 'scam');
    // Pure modules only: facts types and URL helpers. The barrel re-exports readers, so it isn't allowed.
    const allowed = ['linkedin/profile/facts', 'linkedin/company/facts', 'linkedin/job/facts', 'linkedin/url'].map((p) => join(SRC, p));
    const offenders = sourceFiles(scam).flatMap((f) =>
      imports(f)
        .filter((spec) => {
          if (!spec.startsWith('.')) return true;
          const target = resolve(dirname(f), spec);
          return !target.startsWith(scam + sep) && !allowed.includes(target);
        })
        .map((spec) => `${relative(SRC, f)} -> ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
