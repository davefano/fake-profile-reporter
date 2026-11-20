// Job details only a signed-in viewer gets: the external apply link, exact
// listing dates and reposts, state, hiring team, and the "Verified job" badge.

import { endpoints } from '../endpoints';
import { sessionFrom, type ReaderOptions } from '../session';

export interface JobExtras {
  /** Where "Apply" sends you, for jobs that apply on another site. */
  applyUrl: string | null;
  listedAt: number | null;
  /** First listing; earlier than listedAt when the job was reposted. */
  originalListedAt: number | null;
  expireAt: number | null;
  /** "LISTED", "CLOSED", … */
  state: string | null;
  remote: boolean | null;
  thirdPartySourced: boolean | null;
  /** LinkedIn's "Verified job" badge; null when the page couldn't be read. */
  verified: boolean | null;
  /** People named in "Meet the hiring team". */
  hiringTeam: Array<{ slug: string; name: string | null }>;
}

export function parseJobRecord(json: any): Omit<JobExtras, 'verified'> {
  const d = json?.data ?? {};
  const included: any[] = json?.included ?? [];
  const team: JobExtras['hiringTeam'] = [];
  for (const e of included) {
    if (typeof e?.publicIdentifier === 'string' && /Profile$/.test(e.$type ?? '')) {
      team.push({ slug: e.publicIdentifier, name: [e.firstName, e.lastName].filter(Boolean).join(' ') || null });
    }
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    applyUrl: typeof d.applyMethod?.companyApplyUrl === 'string' ? d.applyMethod.companyApplyUrl : null,
    listedAt: num(d.listedAt),
    originalListedAt: num(d.originalListedAt),
    expireAt: num(d.expireAt),
    state: typeof d.jobState === 'string' ? d.jobState : null,
    remote: typeof d.workRemoteAllowed === 'boolean' ? d.workRemoteAllowed : null,
    thirdPartySourced: typeof d.thirdPartySourced === 'boolean' ? d.thirdPartySourced : null,
    hiringTeam: team,
  };
}

/** The logged-in job page marks verified postings with an accessible label. */
export function pageShowsVerifiedJob(html: string): boolean {
  return /aria-label="Verified job"|\(Verified job\)/.test(html);
}

export async function fetchJobExtras(jobId: string, opts: ReaderOptions = {}): Promise<JobExtras> {
  const s = sessionFrom(opts);
  const record = parseJobRecord(await s.voyager(endpoints.jobRecord(jobId)));
  let verified: boolean | null = null;
  try {
    verified = pageShowsVerifiedJob(await s.html(endpoints.jobPage(jobId)));
  } catch {
    // leave unknown
  }
  return { ...record, verified };
}
