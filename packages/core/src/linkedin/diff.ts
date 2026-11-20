// What changed between two observations of the same profile, company, or job.
// A field is compared only when both observations actually loaded it: a failed
// request is not an edit.

import type { CompanyFacts } from './company/facts';
import type { JobFacts } from './job/facts';
import { carryForward, PROFILE_RECORD_FIELDS, type ProfileFacts, type ProfilePart } from './profile/facts';

/** A short, stable digest of a job description, so history needn't keep the text (it can be 30 KB). */
export function compactJobFacts(job: JobFacts): JobFacts {
  if (job.description.startsWith('digest:')) return job;
  let h = 5381;
  for (let i = 0; i < job.description.length; i++) h = ((h << 5) + h + job.description.charCodeAt(i)) | 0;
  return { ...job, description: `digest:${(h >>> 0).toString(36)}:${job.description.length}` };
}

export interface FactChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Changes in the named fields between two observations of the same thing. */
export function diffFields<T extends object>(prev: T, next: T, fields: Array<keyof T & string>): FactChange[] {
  return fields
    .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]))
    .map((k) => ({ field: k, from: prev[k], to: next[k] }));
}

// From the identity lookup, present whenever the profile resolved.
const PROFILE_IDENTITY: Array<keyof ProfileFacts & string> = ['slug'];
// From the full profile record, minus what isn't worth reporting as an edit:
// signed display URLs, LinkedIn's partial skill list, and internal versions.
const NOT_DIFFED = new Set<string>(['photoUrl', 'skills', 'versionTag', 'memorialized']);
const PROFILE_RECORD = PROFILE_RECORD_FIELDS.filter((k) => !NOT_DIFFED.has(k));

export function diffProfileFacts(prev: ProfileFacts, next: ProfileFacts): FactChange[] {
  const changes = diffFields(prev, next, PROFILE_IDENTITY);
  if (prev.profileLoaded && next.profileLoaded) changes.push(...diffFields(prev, next, PROFILE_RECORD));
  if (prev.about && next.about) changes.push(...diffFields(prev, next, ['about']));
  if (prev.connections && next.connections && prev.connections.count !== next.connections.count) {
    changes.push({ field: 'connections', from: prev.connections, to: next.connections });
  }
  return changes;
}

/**
 * Take in a new capture of a profile seen before: the current facts (failed
 * parts carried forward from `prev`) and what changed. One rule for every
 * caller, so the extension, the CLI and the directory agree.
 */
export function observeProfile(
  prev: ProfileFacts | null,
  next: ProfileFacts,
): { current: ProfileFacts; changes: FactChange[]; carried: ProfilePart[] } {
  const { current, carried } = carryForward(prev, next);
  return { current, changes: prev ? diffProfileFacts(prev, current) : [], carried };
}

const COMPANY_FIELDS: Array<keyof CompanyFacts & string> = [
  'slug', 'name', 'tagline', 'website', 'industry', 'headquarters', 'type', 'foundedYear', 'claimedSize', 'logo',
];

export function diffCompanyFacts(prev: CompanyFacts, next: CompanyFacts): FactChange[] {
  return diffFields(prev, next, COMPANY_FIELDS);
}

const JOB_FIELDS: Array<keyof JobFacts & string> = ['title', 'company', 'location', 'salary', 'apply', 'description'];

/** Descriptions are compared by digest, so either side may be compacted. */
export function diffJobFacts(prev: JobFacts, next: JobFacts): FactChange[] {
  return diffFields(compactJobFacts(prev), compactJobFacts(next), JOB_FIELDS);
}
