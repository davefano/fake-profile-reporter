// What changed between two observations of the same profile, company, or job.
// A field is compared only when both observations actually loaded it: a failed
// request is not an edit.

import type { CompanyFacts } from './company/facts';
import type { JobFacts } from './job/facts';
import type { ProfileFacts } from './profile/facts';

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
// From the full profile record. Activity and follower churn are left out as noise.
const PROFILE_RECORD: Array<keyof ProfileFacts & string> = [
  'firstName', 'lastName', 'headline', 'summary', 'countryCode', 'geoName', 'industry',
  'premium', 'creator', 'influencer', 'photo', 'background', 'positions', 'educations',
];

export function diffProfileFacts(prev: ProfileFacts, next: ProfileFacts): FactChange[] {
  const changes = diffFields(prev, next, PROFILE_IDENTITY);
  if (prev.profileLoaded && next.profileLoaded) changes.push(...diffFields(prev, next, PROFILE_RECORD));
  if (prev.about && next.about) changes.push(...diffFields(prev, next, ['about']));
  if (prev.connections && next.connections && prev.connections.count !== next.connections.count) {
    changes.push({ field: 'connections', from: prev.connections, to: next.connections });
  }
  return changes;
}

const COMPANY_FIELDS: Array<keyof CompanyFacts & string> = [
  'slug', 'name', 'tagline', 'website', 'industry', 'headquarters', 'type', 'foundedYear', 'claimedSize', 'logo',
];

export function diffCompanyFacts(prev: CompanyFacts, next: CompanyFacts): FactChange[] {
  return diffFields(prev, next, COMPANY_FIELDS);
}

const JOB_FIELDS: Array<keyof JobFacts & string> = ['title', 'company', 'location', 'salary', 'apply', 'description'];

export function diffJobFacts(prev: JobFacts, next: JobFacts): FactChange[] {
  return diffFields(prev, next, JOB_FIELDS);
}
