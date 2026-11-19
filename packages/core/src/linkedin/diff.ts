// What changed between two snapshots of the same account.

import type { ProfileFacts } from './profile/facts';

export interface FactChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Fields worth tracking over time. Activity/follower churn is excluded as noise. */
const TRACKED: Array<keyof ProfileFacts> = [
  'slug', 'firstName', 'lastName', 'headline', 'summary', 'countryCode', 'geoName', 'industry',
  'premium', 'creator', 'influencer', 'photo', 'background', 'positions', 'educations', 'about',
];

export function diffProfileFacts(prev: ProfileFacts, next: ProfileFacts): FactChange[] {
  const changes: FactChange[] = [];
  for (const field of TRACKED) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
      changes.push({ field, from: prev[field], to: next[field] });
    }
  }
  if (prev.connections?.count !== next.connections?.count) {
    changes.push({ field: 'connections', from: prev.connections, to: next.connections });
  }
  return changes;
}

/** Changes in the named fields between two observations of the same thing. */
export function diffFields<T extends object>(prev: T, next: T, fields: Array<keyof T & string>): FactChange[] {
  return fields
    .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]))
    .map((k) => ({ field: k, from: prev[k], to: next[k] }));
}
