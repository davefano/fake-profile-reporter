// Messages for reading LinkedIn through the user's LinkedIn tab. Feature-free:
// anything in the extension that needs LinkedIn data (scam checks, profile
// tips, …) uses these through client.ts.

import type { CompanyExtras, JobExtras, ProfileFacts } from '@flr/core/linkedin';
import type { ErrorResponse } from '@/lib/runtime';

export interface ProfileResult {
  slug: string;
  facts: ProfileFacts;
  capturedAt: number;
  /** Payloads that failed, e.g. { about: "HTTP 403" }. */
  errors: Record<string, string>;
  /** Gzipped raw snapshot size; the snapshot itself stays in the tab until asked for. */
  snapshotBytes: number;
}

export interface LinkedInMessages {
  LI_PROFILE: { req: { type: 'LI_PROFILE'; slug: string; includeActivity?: boolean }; res: ProfileResult | ErrorResponse };
  LI_PROFILE_SNAPSHOT: { req: { type: 'LI_PROFILE_SNAPSHOT'; slug: string }; res: { gzipBase64: string } | ErrorResponse };
  LI_COMPANY_EXTRAS: { req: { type: 'LI_COMPANY_EXTRAS'; slug: string }; res: CompanyExtras | ErrorResponse };
  LI_JOB_EXTRAS: { req: { type: 'LI_JOB_EXTRAS'; jobId: string }; res: JobExtras | ErrorResponse };
}

export type LinkedInRequest = LinkedInMessages[keyof LinkedInMessages]['req'];
export const isLinkedInRequest = (m: { type?: unknown }) => typeof m?.type === 'string' && m.type.startsWith('LI_');
