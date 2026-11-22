// Messages for reading LinkedIn through the user's LinkedIn tab. Feature-free:
// anything in the extension that needs LinkedIn data (scam checks, profile
// tips, …) uses these through client.ts.

import type { CompanyExtras, JobExtras, ProfileFacts } from '@fpr/core/linkedin';
import type { ErrorResponse } from '@/lib/runtime';

export interface ProfileResult {
  slug: string;
  facts: ProfileFacts;
  capturedAt: number;
  /** Payloads that failed, e.g. { about: "HTTP 403" }. */
  errors: Record<string, string>;
  /** The raw snapshot, gzipped and base64-encoded; only when asked for (includeSnapshot). */
  snapshotGzipBase64?: string;
}

export interface LinkedInMessages {
  LI_PROFILE: {
    req: { type: 'LI_PROFILE'; slug: string; includeActivity?: boolean; includeSnapshot?: boolean };
    res: ProfileResult | ErrorResponse;
  };
  LI_COMPANY_EXTRAS: { req: { type: 'LI_COMPANY_EXTRAS'; slug: string }; res: CompanyExtras | ErrorResponse };
  LI_JOB_EXTRAS: { req: { type: 'LI_JOB_EXTRAS'; jobId: string }; res: JobExtras | ErrorResponse };
}
