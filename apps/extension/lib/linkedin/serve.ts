// The content-script side of the LinkedIn bridge. Runs on www.linkedin.com, so
// signed-in requests are same-origin and use the viewer's session.

import { captureProfile, extractProfileFacts, fetchCompanyExtras, fetchJobExtras, type RawSnapshot } from '@flr/core/linkedin';
import { serve, type ErrorResponse } from '@/lib/runtime';
import { isLinkedInRequest, type LinkedInRequest, type ProfileResult } from './protocol';

// Relative URLs resolve against the page in Chrome but not in every browser's
// content-script context, so make them absolute.
const pageFetch = (input: string, init?: RequestInit) => fetch(input.startsWith('/') ? location.origin + input : input, init);
const opts = { fetch: pageFetch };

let last: { slug: string; gz: Uint8Array } | null = null;

export function serveLinkedIn() {
  serve<LinkedInRequest>((msg) => {
    if (!isLinkedInRequest(msg)) return undefined;
    switch (msg.type) {
      case 'LI_PROFILE':
        return profile(msg.slug, msg.includeActivity);
      case 'LI_PROFILE_SNAPSHOT':
        return snapshot(msg.slug);
      case 'LI_COMPANY_EXTRAS':
        return wrap(() => fetchCompanyExtras(msg.slug, opts));
      case 'LI_JOB_EXTRAS':
        return wrap(() => fetchJobExtras(msg.jobId, opts));
      default:
        return undefined;
    }
  });
}

const wrap = <T>(fn: () => Promise<T>): Promise<T | ErrorResponse> => fn().catch((e) => ({ error: 'linkedin_failed', message: String(e) }));

async function profile(slug: string, includeActivity = true): Promise<ProfileResult | ErrorResponse> {
  try {
    const snap: RawSnapshot = await captureProfile(slug, { ...opts, includeActivity });
    const facts = extractProfileFacts(snap, snap.capturedAt);
    if (!facts.memberId) return { error: 'profile_unavailable', message: Object.values(snap.errors)[0] ?? 'Profile not found' };
    const gz = await gzip(JSON.stringify(snap));
    last = { slug, gz };
    return { slug, facts, capturedAt: snap.capturedAt, errors: snap.errors, snapshotBytes: gz.byteLength };
  } catch (e) {
    return { error: 'capture_failed', message: String(e) };
  }
}

async function snapshot(slug: string): Promise<{ gzipBase64: string } | ErrorResponse> {
  if (!last || last.slug !== slug) return { error: 'no_snapshot', message: 'Read the profile again first.' };
  return { gzipBase64: toBase64(last.gz) };
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
