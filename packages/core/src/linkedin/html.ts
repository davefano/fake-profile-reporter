// Small helpers for reading LinkedIn's public (logged-out) HTML pages without
// a DOM, so the same parsers run in the extension, the worker, and Bun.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Tags to text: block tags become line breaks, whitespace collapses. */
export function htmlText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

/** Inner HTML of every element whose class list contains `cls`, in order. */
export function byClass(html: string, cls: string, tag = '[a-z0-9]+'): string[] {
  // Match the class as a whole token: "salary" must not match "salary-range".
  const re = new RegExp(`<(${tag})\\b[^>]*class="(?:[^"]*\\s)?${cls.replace(/[-]/g, '\\-')}(?:\\s[^"]*)?"[^>]*>([\\s\\S]*?)</\\1>`, 'gi');
  return [...html.matchAll(re)].map((m) => m[2]!);
}

export const firstText = (html: string, cls: string, tag?: string) => {
  const hit = byClass(html, cls, tag)[0];
  return hit == null ? null : htmlText(hit) || null;
};

/** "1,234" / "12K" / "1.2M" → number. */
export function parseCount(s: string | null | undefined): number | null {
  const m = s?.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KkMm])?/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1);
  return Math.round(n);
}

/** "…/0/1712065960987?e=…" → upload time in ms (LinkedIn media URLs). */
export function mediaUploadedAt(url: string | null | undefined): number | null {
  const m = url?.match(/\/0\/(\d{12,14})(?:[/?]|$)/);
  return m ? Number(m[1]) : null;
}

/** Approximate time from relative text such as "6 days ago" or "Reposted 2 weeks ago". */
export function parseAgo(text: string | null | undefined, now: number): number | null {
  const m = text?.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2_592_000_000, year: 31_557_600_000 }[m[2]!.toLowerCase() as 'day'];
  return now - Number(m[1]) * unit;
}

/** decodeURIComponent that returns the input instead of throwing on a malformed escape. */
export function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
