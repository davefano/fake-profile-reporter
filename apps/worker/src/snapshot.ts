// Uploaded snapshots are untrusted. Keep only the payloads we know, with the
// types we expect; anything else (including the old mutual-connections text,
// which named the uploader's contacts) is dropped before storing or parsing.

import { SNAPSHOT_SCHEMA, type RawSnapshot } from '@flr/core';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function cleanSnapshot(v: unknown): RawSnapshot | null {
  if (!isObject(v) || v.schema !== SNAPSHOT_SCHEMA || typeof v.slug !== 'string' || !isObject(v.payloads)) return null;
  const p = v.payloads;
  const payloads: RawSnapshot['payloads'] = {};
  for (const k of ['resolve', 'fullProfile', 'followingState'] as const) if (isObject(p[k])) payloads[k] = p[k];
  for (const k of ['about', 'activity'] as const) if (typeof p[k] === 'string') payloads[k] = p[k] as string;
  if (Array.isArray(p.profilePageCounts)) payloads.profilePageCounts = p.profilePageCounts.filter((x): x is string => typeof x === 'string').slice(0, 20);
  // profilePageMutualCount is relative to whoever captured the profile: not stored.
  const errors: Record<string, string> = {};
  if (isObject(v.errors)) for (const [k, e] of Object.entries(v.errors)) if (typeof e === 'string') errors[k] = e.slice(0, 200);
  return {
    schema: SNAPSHOT_SCHEMA,
    capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : NaN,
    slug: v.slug.slice(0, 200),
    profileId: typeof v.profileId === 'string' ? v.profileId : null,
    payloads,
    errors,
  };
}
