// Formatting helpers for the panel.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthYear(ms: number) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = s / 86400;
  if (d < 45) return `${Math.floor(d)} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return monthYear(ms);
}
export function monthDay(ms: number) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${d.getUTCFullYear() !== new Date().getUTCFullYear() ? `, ${d.getUTCFullYear()}` : ''}`;
}
export function ageText(ms: number) {
  const days = Math.max(0, (Date.now() - ms) / 86_400_000);
  return days < 60 ? `${Math.floor(days)} days old` : days < 730 ? `${Math.floor(days / 30)} months old` : `${Math.floor(days / 365.25)} years old`;
}
export function compact(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n.toLocaleString();
}
export function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** A server address as people read it: its host. */
export const host = (base: string) => new URL(base).host;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A failed message to the background, as the panel shows errors. */
export const panelError = (e: unknown) => ({ error: 'panel_error', message: String(e) });
