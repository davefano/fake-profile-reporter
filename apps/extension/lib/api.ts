// The directory API (worker), from the background. Every success is a JSON
// body of the expected shape; anything else comes back as an ErrorResponse.

import { API_BASE } from '@/lib/config';
import type { ErrorResponse } from '@/lib/runtime';

export async function api<T>(method: 'GET' | 'POST', path: string, body?: Uint8Array | object): Promise<T | ErrorResponse> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
    });
  } catch {
    return { error: 'network_error', message: `Can't reach ${API_BASE}. Is the worker running?` };
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) return { error: data?.error ?? `http_${res.status}`, message: data?.error ? undefined : `The directory answered HTTP ${res.status}.` };
  if (!data || typeof data !== 'object') return { error: 'bad_response', message: 'The directory sent an unexpected response.' };
  return data;
}
