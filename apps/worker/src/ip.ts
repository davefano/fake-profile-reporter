// Anonymous reporter identity: hash(IP + salt) with SHA-256. Never store raw IPs.
// Used for per-profile dedupe and daily rate limiting.

export const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hashIp(ip: string, salt = ''): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${ip || 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest)).slice(0, 32);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1'
  );
}

/** The secret key the extension sends as x-reporter-key: at least 32 URL-safe characters. */
export const REPORTER_KEY = /^[A-Za-z0-9_-]{32,128}$/;

/** Anonymous reporter: hash(salt + key). The key itself is never stored. */
export const hashReporter = (key: string, salt = '') => hashIp(`reporter:${key}`, salt);
