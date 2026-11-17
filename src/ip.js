// Anonymous reporter identity: hash(IP + salt) with SHA-256. Never store raw IPs.
// Used for per-profile dedupe and daily rate limiting.

export async function hashIp(ip, salt = '') {
  const data = new TextEncoder().encode(`${salt}:${ip || 'unknown'}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
