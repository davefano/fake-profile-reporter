// The content-script side of the LinkedIn bridge. Runs on www.linkedin.com, so
// signed-in requests are same-origin and use the viewer's session. Stateless:
// every answer is complete in itself.

import { captureProfile, extractProfileFacts, fetchCompanyExtras, fetchJobExtras } from '@fpr/core/linkedin';
import { errorText, serve, type ErrorResponse } from '@/lib/runtime';
import type { LinkedInMessages, ProfileResult } from './protocol';

// Relative URLs resolve against the page in Chrome but not in every browser's
// content-script context, so make them absolute.
const pageFetch = (input: string, init?: RequestInit) => fetch(input.startsWith('/') ? location.origin + input : input, init);
const opts = { fetch: pageFetch };

export function serveLinkedIn() {
  // The background re-injects this script into tabs that predate the
  // extension; a second listener would run every read twice.
  const g = globalThis as { __fprLinkedInServing?: boolean };
  if (g.__fprLinkedInServing) return;
  g.__fprLinkedInServing = true;

  serve<LinkedInMessages>({
    LI_PROFILE: (msg) => profile(msg.slug, msg.includeActivity, msg.includeSnapshot),
    LI_COMPANY_EXTRAS: (msg) => wrap(() => fetchCompanyExtras(msg.slug, opts)),
    LI_JOB_EXTRAS: (msg) => wrap(() => fetchJobExtras(msg.jobId, opts)),
  });
}

const wrap = <T>(fn: () => Promise<T>): Promise<T | ErrorResponse> => fn().catch((e) => ({ error: 'linkedin_failed', message: errorText(e) }));

async function profile(slug: string, includeActivity = true, includeSnapshot = false): Promise<ProfileResult | ErrorResponse> {
  try {
    const snap = await captureProfile(slug, { ...opts, includeActivity });
    const facts = extractProfileFacts(snap, snap.capturedAt);
    if (!facts.memberId) return { error: 'profile_unavailable', message: Object.values(snap.errors)[0] ?? 'Profile not found' };
    const result: ProfileResult = { slug, facts, capturedAt: snap.capturedAt, errors: snap.errors };
    if (includeSnapshot) result.snapshotGzipBase64 = toBase64(await gzip(JSON.stringify(snap)));
    return result;
  } catch (e) {
    return { error: 'capture_failed', message: errorText(e) };
  }
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
