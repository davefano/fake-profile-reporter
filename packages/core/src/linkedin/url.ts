// Canonicalize a LinkedIn profile URL so the same person always maps to one row.
// Handles: absolute/relative, trailing slashes, query strings, /in/<slug>,
// locale prefixes (/en/in/<slug>), and mobile m./www. hosts.

export interface NormalizedProfileUrl {
  url: string;
  handle: string;
}

export function normalizeProfileUrl(input: unknown): NormalizedProfileUrl | null {
  if (!input) return null;
  let raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;

  const segments = u.pathname.split('/').filter(Boolean);
  const inIdx = segments.findIndex((s) => s.toLowerCase() === 'in');
  if (inIdx === -1) return null;
  const slug = (segments[inIdx + 1] || '').trim();
  if (!slug) return null;

  return { url: `https://www.linkedin.com/in/${slug.toLowerCase()}`, handle: slug };
}

/** "https://www.example.co.uk/careers" → "example.co.uk". */
export function siteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Same site: equal domains, or one a subdomain of the other. */
export function sameSite(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
