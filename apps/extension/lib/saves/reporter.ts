// This browser's reporter keys. One random master key stays here; each server
// gets its own key, HMAC-SHA256(master key, server origin), so one server
// can't act as you on another. A server stores only a hash of the key it gets.
// Export carries the master key to another browser.

const KEY = 'reporterMasterKey';
const VALID = /^[A-Za-z0-9_-]{32,128}$/;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The master key, if this browser has made one. */
export async function storedMasterKey(): Promise<string | null> {
  const k = (await browser.storage.local.get(KEY))[KEY];
  return typeof k === 'string' && VALID.test(k) ? k : null;
}

let making: Promise<string> | null = null;

/** The master key, made on first use: 32 random bytes, base64url. Callers racing on first use share one. */
export async function masterKey(): Promise<string> {
  const have = await storedMasterKey();
  if (have) return have;
  making ??= (async () => {
    const key = base64url(crypto.getRandomValues(new Uint8Array(32)));
    await browser.storage.local.set({ [KEY]: key });
    return key;
  })().finally(() => (making = null));
  return making;
}

export async function setMasterKey(key: string) {
  if (!VALID.test(key)) throw new Error('Not a reporter key.');
  await browser.storage.local.set({ [KEY]: key });
}

/** The key `server` gets: HMAC-SHA256(master, server origin), base64url (43 characters). */
export async function deriveReporterKey(master: string, server: string): Promise<string> {
  const enc = new TextEncoder();
  const hmac = await crypto.subtle.importKey('raw', enc.encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, enc.encode(new URL(server).origin))));
}

/** The reporter key to send to `server`. */
export const reporterKeyFor = async (server: string) => deriveReporterKey(await masterKey(), server);
