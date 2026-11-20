// lib/linkedin is the extension's reusable LinkedIn bridge: it may use the
// LinkedIn data layer and the generic runtime, and nothing feature-specific.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dir, '../lib/linkedin');
const ALLOWED = [/^\.\//, /^@flr\/core\/linkedin$/, /^@\/lib\/runtime$/];

test('lib/linkedin imports only the LinkedIn layer, the runtime, and itself', () => {
  const offenders = readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) =>
      [...readFileSync(join(DIR, f), 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)]
        .map((m) => m[1]!)
        .filter((spec) => !ALLOWED.some((re) => re.test(spec)))
        .map((spec) => `${f} -> ${spec}`),
    );
  expect(offenders).toEqual([]);
});
