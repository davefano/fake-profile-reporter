// lib/linkedin is the extension's reusable LinkedIn bridge: it may use the
// LinkedIn data layer and the generic runtime, and nothing feature-specific.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DIR = join(import.meta.dir, '../lib/linkedin');
const PACKAGES = [/^@flr\/core\/linkedin$/, /^@\/lib\/runtime$/];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

test('lib/linkedin imports only the LinkedIn layer, the runtime, and itself', () => {
  const offenders = sourceFiles(DIR).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1]!)
      // Relative imports must stay inside lib/linkedin; packages must be on the list.
      .filter((spec) => (spec.startsWith('.') ? !resolve(dirname(f), spec).startsWith(DIR + sep) : !PACKAGES.some((re) => re.test(spec))))
      .map((spec) => `${relative(DIR, f)} -> ${spec}`),
  );
  expect(offenders).toEqual([]);
});
