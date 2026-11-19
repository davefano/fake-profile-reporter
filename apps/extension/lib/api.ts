// The directory API (worker), from the background.

import { API_BASE } from '@/lib/config';
import type { ErrorResponse } from '@/lib/runtime';

export async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: any } | ErrorResponse> {
  try {
    const isBytes = body instanceof Uint8Array;
    const res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : isBytes ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch {
    return { error: 'network_error', message: `Can't reach ${API_BASE}. Is the worker running?` };
  }
}
