// This browser's reporter key: a random secret sent with every report, so the
// server knows which reports are yours and only you can change them. The
// server stores only a hash of it. Export carries it to another browser.

const KEY = 'reporterKey';
const VALID = /^[A-Za-z0-9_-]{32,128}$/;

/** The key, if this browser has made one. */
export async function storedReporterKey(): Promise<string | null> {
  const k = (await browser.storage.local.get(KEY))[KEY];
  return typeof k === 'string' && VALID.test(k) ? k : null;
}

/** The key, made on first use: 32 random bytes, base64url. */
export async function reporterKey(): Promise<string> {
  const have = await storedReporterKey();
  if (have) return have;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await browser.storage.local.set({ [KEY]: key });
  return key;
}

export async function setReporterKey(key: string) {
  if (!VALID.test(key)) throw new Error('Not a reporter key.');
  await browser.storage.local.set({ [KEY]: key });
}
