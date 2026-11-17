// Canonicalize a LinkedIn profile URL so the same person always maps to one row.
// Handles: absolute/relative, trailing slashes, query strings, /in/<slug>,
// locale prefixes (/en/in/<slug>), and mobile m./www. hosts.

export function normalizeProfileUrl(input) {
  if (!input) return null;
  let raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');
  let u;
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
