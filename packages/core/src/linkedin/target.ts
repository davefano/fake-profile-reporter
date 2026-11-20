// What a LinkedIn URL points at: a profile, a company page, or a job posting.

/** What a LinkedIn URL points at. */
export type LinkedInTarget =
  | { kind: 'profile'; slug: string }
  | { kind: 'company'; slug: string }
  | { kind: 'job'; id: string };

export function linkedInTarget(url: string | null | undefined): LinkedInTarget | null {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null;
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // a malformed escape: match on the raw path
  }
  const job = u.searchParams.get('currentJobId') ?? /^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?/.exec(path)?.[1];
  if (job && /^\d+$/.test(job)) return { kind: 'job', id: job };
  // Optional locale prefix: /en/in/<slug>.
  const profile = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?in\/([^/]+)/i.exec(path)?.[1];
  if (profile) return { kind: 'profile', slug: profile };
  const company = /^\/(?:company|showcase|school)\/([^/]+)/.exec(path)?.[1];
  if (company) return { kind: 'company', slug: company };
  return null;
}
