// A save server's API (the worker), from the background. Every success is a
// JSON body of the expected shape; anything else comes back as an ErrorResponse.

import type { ErrorResponse } from '@/lib/runtime';

export async function api<T>(base: string, method: 'GET' | 'POST', path: string, body?: Uint8Array | object): Promise<T | ErrorResponse> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
    });
  } catch {
    return { error: 'network_error', message: `Can't reach ${new URL(base).host}.` };
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) return { error: data?.error ?? `http_${res.status}`, message: data?.error ? undefined : `The server answered HTTP ${res.status}.` };
  if (!data || typeof data !== 'object') return { error: 'bad_response', message: 'The server sent an unexpected response.' };
  return data;
}
