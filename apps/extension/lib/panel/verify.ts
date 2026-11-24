// The bot check in the panel (KTD6). A server that wants it answers a report
// with `verification_required` and a `verifyUrl`; the panel frames that page
// inline, takes the token it posts back, and hands it to the background. The
// Safari popup can't keep a frame open, so it opens the page in a tab instead
// and the background polls until the check has passed.
//
// startCheck() is the inline flow with its browser parts passed in; mountCheck()
// wires it to a box in the panel. U9's removal request reuses both.

import type { VerifyMessage } from '@fpr/core/wire';
import { isError } from '@/lib/runtime';
import { sendMessage } from '@/lib/scan/messages';
import { esc } from './format';

/** Without a load by then, the check didn't render. */
export const LOAD_WAIT_MS = 15_000;
/** Challenges last 10 minutes on the server: ask for a fresh one a little before. */
export const RENEW_MS = 9 * 60_000;
const CHALLENGE = /^[0-9a-f]{32}$/;

/**
 * `verifyUrl` with `extra` query values added, if it is the selected
 * server's own /verify page over https with only a challenge ID on it;
 * otherwise null, and nothing is framed or opened.
 */
export function verifyPageUrl(verifyUrl: string, server: string, extra: Record<string, string>): URL | null {
  let u: URL;
  let s: URL;
  try {
    u = new URL(verifyUrl);
    s = new URL(server);
  } catch {
    return null;
  }
  const keys = [...u.searchParams.keys()];
  if (u.protocol !== 'https:' || u.host !== s.host || u.pathname !== '/verify' || u.username || u.password || u.hash) return null;
  if (keys.length !== 1 || keys[0] !== 'challenge' || !CHALLENGE.test(u.searchParams.get('challenge')!)) return null;
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u;
}

interface MessageLike {
  origin: string;
  source: unknown;
  data: unknown;
}

/** The token, if `e` came from the framed page itself (its origin and its window) for its challenge. */
export function verifyMessage(e: MessageLike, frame: { origin: string; window: unknown; challenge: string }): VerifyMessage | null {
  if (e.origin !== frame.origin || e.source == null || e.source !== frame.window) return null;
  const d = e.data as Partial<VerifyMessage> | null;
  if (!d || typeof d !== 'object' || d.type !== 'fpr-verify' || d.challenge !== frame.challenge) return null;
  if (typeof d.token !== 'string' || !d.token || d.token.length > 2048) return null;
  return { type: 'fpr-verify', challenge: d.challenge, token: d.token };
}

export type CheckState =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'checking' }
  | { state: 'not_loaded' }
  | { state: 'failed'; message: string }
  | { state: 'done' };

export interface CheckFrame {
  window: unknown;
  focus(): void;
  remove(): void;
}

export interface CheckDeps {
  server: string;
  /** This extension's origin, where the page posts its token. */
  parentOrigin: string;
  view: {
    show(s: CheckState): void;
    /** Frame `url`, calling `loaded` once it has loaded. */
    frame(url: string, loaded: () => void): CheckFrame;
  };
  listen(fn: (e: MessageLike) => void): () => void;
  /** Hand the token to the server: true when it passed, or a message to show. */
  verify(token: string, challenge: string): Promise<true | string>;
  /** A fresh challenge's verifyUrl, or null when no check is needed any more. */
  renew(): Promise<string | null>;
  timers?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
}

/**
 * Run the inline check from `verifyUrl`. `done` is true once it passed (retry
 * the report then, once), false when stopped. `retry` asks for a fresh
 * challenge, after a check that didn't load or didn't pass.
 */
export function startCheck(verifyUrl: string, deps: CheckDeps): { done: Promise<boolean>; retry(): void; stop(): void } {
  const timers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
  let resolve!: (v: boolean) => void;
  const done = new Promise<boolean>((r) => (resolve = r));
  let stopped = false;
  let frame: CheckFrame | null = null;
  let pending: unknown[] = [];
  let unlisten = () => {};

  function teardown() {
    pending.forEach((t) => timers.clear(t));
    pending = [];
    unlisten();
    unlisten = () => {};
    frame?.remove();
    frame = null;
  }

  function finish(ok: boolean) {
    if (stopped) return;
    stopped = true;
    teardown();
    if (ok) deps.view.show({ state: 'done' });
    resolve(ok);
  }

  function load(url: string) {
    teardown();
    const page = verifyPageUrl(url, deps.server, { parentOrigin: deps.parentOrigin });
    if (!page) return deps.view.show({ state: 'failed', message: "The server asked for a check from another address, so it wasn't opened." });
    const challenge = page.searchParams.get('challenge')!;
    deps.view.show({ state: 'loading' });
    const f = deps.view.frame(page.href, () => {
      if (frame !== f) return;
      pending.forEach((t) => timers.clear(t));
      pending = [timers.set(renew, RENEW_MS)];
      deps.view.show({ state: 'ready' });
      f.focus();
    });
    frame = f;
    pending = [timers.set(() => frame === f && (teardown(), deps.view.show({ state: 'not_loaded' })), LOAD_WAIT_MS)];
    unlisten = deps.listen((e) => {
      const msg = frame === f ? verifyMessage(e, { origin: page.origin, window: f.window, challenge }) : null;
      if (msg) onToken(msg.token, challenge);
    });
  }

  async function onToken(token: string, challenge: string) {
    teardown();
    deps.view.show({ state: 'checking' });
    const res = await deps.verify(token, challenge).catch(() => "Couldn't reach the extension's background. Try again.");
    if (stopped) return;
    if (res === true) finish(true);
    else deps.view.show({ state: 'failed', message: res });
  }

  async function renew() {
    teardown();
    if (stopped) return;
    deps.view.show({ state: 'loading' });
    const next = await deps.renew().catch(() => undefined);
    if (stopped) return;
    if (next === null) finish(true);
    else if (next) load(next);
    else deps.view.show({ state: 'failed', message: "Couldn't get a new check from the server." });
  }

  load(verifyUrl);
  return {
    done,
    retry: () => void renew(),
    stop() {
      if (stopped) return;
      stopped = true;
      teardown();
      resolve(false);
    },
  };
}

const TEXT: Record<Exclude<CheckState['state'], 'failed' | 'done'>, string> = {
  loading: 'Loading a quick check…',
  ready: 'One quick check before your first report to this server. It lasts 90 days.',
  checking: 'Checking…',
  not_loaded: "The check didn't load.",
};

/** The Safari popup: no frames, so the check opens in a tab. */
const inPopup = () => location.pathname.includes('popup');

/**
 * Show the check for `server` in `box` and run it. `renew` asks for a fresh
 * challenge (by sending again). Resolves true once passed (inline) or once
 * the tab check passed and `key` was sent (popup).
 */
export async function mountCheck(
  box: HTMLElement,
  o: { server: string; verifyUrl: string; key?: string; renew: () => Promise<string | null>; signal?: AbortSignal },
): Promise<boolean> {
  box.classList.add('check');
  box.classList.remove('hidden');
  if (inPopup()) {
    const page = verifyPageUrl(o.verifyUrl, o.server, { mode: 'tab' });
    if (!page) {
      box.innerHTML = `<p class="check-msg err">${esc("The server asked for a check from another address, so it wasn't opened.")}</p>`;
      return false;
    }
    box.innerHTML = `<p class="check-msg">${esc('Finish the quick check in the tab that opened. What you wrote is saved in this browser and sends once the check passes.')}</p>`;
    const waiting = sendMessage<'FPR_VERIFY_WAIT'>({ type: 'FPR_VERIFY_WAIT', server: o.server, key: o.key });
    await browser.tabs.create({ url: page.href });
    const res = await waiting.catch(() => null);
    const ok = !!res && !isError(res) && res.verified && (!res.sync || !isError(res.sync));
    if (!ok) box.innerHTML = `<p class="check-msg err">${esc("The check didn't finish. What you wrote is still saved in this browser; use Send now to try again.")}</p>`;
    return ok;
  }

  box.innerHTML = `<div class="check-frame"><p class="check-msg"></p></div><div class="check-row" hidden><button type="button" class="lnk">Try again</button></div>`;
  const holder = box.querySelector<HTMLElement>('.check-frame')!;
  const msg = box.querySelector<HTMLElement>('.check-msg')!;
  const row = box.querySelector<HTMLElement>('.check-row')!;
  const check = startCheck(o.verifyUrl, {
    server: o.server,
    parentOrigin: location.origin,
    view: {
      show(s) {
        holder.dataset.state = s.state;
        row.hidden = s.state !== 'not_loaded' && s.state !== 'failed';
        msg.className = `check-msg${s.state === 'failed' || s.state === 'not_loaded' ? ' err' : ''}`;
        msg.textContent = s.state === 'failed' ? s.message : s.state === 'done' ? '' : TEXT[s.state];
        if (s.state === 'done') box.classList.add('hidden');
      },
      frame(url, loaded) {
        const iframe = Object.assign(document.createElement('iframe'), { src: url, title: 'Quick check before reporting', referrerPolicy: 'no-referrer' });
        iframe.addEventListener('load', loaded, { once: true });
        holder.append(iframe);
        return { window: iframe.contentWindow, focus: () => iframe.focus(), remove: () => iframe.remove() };
      },
    },
    listen(fn) {
      window.addEventListener('message', fn);
      return () => window.removeEventListener('message', fn);
    },
    async verify(token, challenge) {
      const res = await sendMessage<'FPR_VERIFY'>({ type: 'FPR_VERIFY', server: o.server, token, challenge });
      if (!isError(res)) return true;
      return res.error === 'verify_failed' ? "That check didn't pass. Try again." : (res.message ?? res.error);
    },
    renew: o.renew,
  });
  row.querySelector('button')!.addEventListener('click', () => check.retry());
  o.signal?.addEventListener('abort', () => check.stop(), { once: true });
  return check.done;
}
