// "This is my profile": the person asks the server Save to points at to remove
// their own profile. The panel issues a random code, they put it
// in their headline or About, and "Check and send" reads the profile again
// (read-only, their own session) and sends the request only when the code is
// there. The check is a convenience: the maintainer reads the profile and
// decides, and nothing changes until then. A server that wants the bot check
// first gets it here as it does for reports (verify.ts).

import type { RemovalRequest, RemovalResponse } from '@fpr/core/wire';
import type { ApiError } from '@/lib/api';
import { isError } from '@/lib/runtime';
import type { Area } from '@/lib/saves/store';
import { sendMessage, type ScanResponse } from '@/lib/scan/messages';
import { ago, esc, host, panelError } from './format';
import { errorText, type Destination } from './report-form';
import { mountCheck } from './verify';

// --- the code ---------------------------------------------------------------------
/** 32 letters and digits without the look-alikes i, l, o and 1, so 256 % 32 leaves no bias. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz023456789';

/** A fresh code in the server's format (6 to 64 of A-Z a-z 0-9 _ -): "fpr-" and 10 random characters. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `fpr-${[...bytes].map((b) => ALPHABET[b % 32]).join('')}`;
}

/** True when `text` holds `code` as a whole token: same case, no code character on either side. */
export function hasCode(text: string | null | undefined, code: string): boolean {
  if (!text) return false;
  return new RegExp(`(?<![A-Za-z0-9_-])${code}(?![A-Za-z0-9_-])`).test(text);
}

// --- kept per profile ---------------------------------------------------------------
export type RemovalState = { state: 'issued'; code: string; at: number } | { state: 'sent'; server: string; at: number };

const stateKey = (memberId: number) => `removal:${memberId}`;

/** A profile's removal request in this browser: a code until it's sent or cancelled, then that it was sent. */
export function removalStore(area: Area) {
  const get = async (memberId: number): Promise<RemovalState | null> => ((await area.get(stateKey(memberId)))[stateKey(memberId)] as RemovalState | null | undefined) ?? null;
  const put = (memberId: number, s: RemovalState | null) => area.set({ [stateKey(memberId)]: s });
  return {
    get,
    /** The code already issued for this profile, or a new one. Refuses once the request was sent. */
    async issue(memberId: number, now = Date.now()): Promise<Extract<RemovalState, { state: 'issued' }>> {
      const s = await get(memberId);
      if (s?.state === 'sent') throw new Error('already sent');
      if (s) return s;
      const next = { state: 'issued' as const, code: newCode(), at: now };
      await put(memberId, next);
      return next;
    },
    cancel: (memberId: number) => put(memberId, null),
    markSent: (memberId: number, server: string, now = Date.now()) => put(memberId, { state: 'sent', server, at: now }),
  };
}

const localRemovals = () => removalStore(browser.storage.local);

// --- check and send -----------------------------------------------------------------
export type RemovalOutcome =
  | { kind: 'sent' }
  | { kind: 'missing' }
  | { kind: 'other_profile' }
  | { kind: 'scan_failed'; message?: string }
  | { kind: 'verify'; verifyUrl: string }
  | { kind: 'refused'; error: string; message?: string };

type Send = (req: RemovalRequest) => Promise<RemovalResponse | ApiError>;

/** The request as sent: the contact only when given. */
export function removalRequest(memberId: number, code: string, contact: string): RemovalRequest {
  const c = contact.trim();
  return { memberId, code, ...(c && { contact: c }) };
}

/** What a send's answer means for the panel. */
export function answerOutcome(res: RemovalResponse | ApiError): RemovalOutcome {
  if (!isError(res)) return { kind: 'sent' };
  if (res.error === 'verification_required' && res.verifyUrl) return { kind: 'verify', verifyUrl: res.verifyUrl };
  return { kind: 'refused', error: res.error, ...(res.message && { message: res.message }) };
}

/**
 * Read the open profile again (`scan`, forced and read-only) and send the
 * request only if it's still `memberId` and its headline or About holds `code`.
 */
export async function checkAndSend(o: { memberId: number; code: string; contact: string; scan: () => Promise<ScanResponse>; send: Send }): Promise<RemovalOutcome> {
  const read: ScanResponse = await o.scan().catch((e): ApiError => panelError(e));
  if (isError(read)) return { kind: 'scan_failed', message: read.message ?? read.error };
  if (read.kind !== 'profile' || read.facts.memberId !== o.memberId) return { kind: 'other_profile' };
  // A part that failed shows the earlier check's headline and About: not a fresh read.
  if (read.cached || !read.facts.profileLoaded || read.carried?.includes('profile')) return { kind: 'scan_failed' };
  if (!hasCode(read.facts.headline, o.code) && !hasCode(read.facts.summary, o.code)) return { kind: 'missing' };
  return answerOutcome(await o.send(removalRequest(o.memberId, o.code, o.contact)));
}


const REFUSED: Record<string, (server: string) => string> = {
  already_pending: () => 'You already have a request pending for this profile. The maintainer reviews it; nothing changes until then.',
  recently_denied: () => 'A recent request for this profile was declined, so this server is not taking a new one yet.',
  queue_full: () => 'Too many removal requests are waiting for review right now. Try again in a few days.',
  daily_limit_reached: () => 'Daily limit reached. Try again tomorrow.',
  not_found: (s) => `${host(s)} doesn't hold this profile, so there's nothing there to remove.`,
  removed: (s) => `${host(s)} already removed this profile at its owner's request.`,
};

/** The line the panel shows for an outcome from `server`. */
export function outcomeText(o: RemovalOutcome, server: string): string {
  switch (o.kind) {
    case 'sent':
      return `Sent to ${host(server)}. The maintainer reads your profile and its reports before deciding; nothing changes until then. Leave the code in place for now.`;
    case 'missing':
      return "The code isn't in your headline or About yet. Add it on LinkedIn, save, then check again.";
    case 'other_profile':
      return 'This tab now shows a different profile. Go back to your own profile and check again.';
    case 'scan_failed':
      return `Couldn't read your headline and About just now${o.message ? ` (${o.message})` : ''}. Try again.`;
    case 'verify':
      return 'The server needs a quick check first.';
    case 'refused':
      return REFUSED[o.error]?.(server) ?? errorText(o);
  }
}

// --- the panel ------------------------------------------------------------------------
/** The quiet link under a profile result; mountRemoval fills the box. */
const LINK = `<p class="me-link"><button type="button" class="lnk quiet" id="meBtn">This is my profile</button> <span>Ask for its removal. Only for your own profile.</span></p>`;
export const removalMarkup = () => `<section class="me" id="removal">${LINK}</section>`;

const failed = (e: unknown): ApiError => panelError(e);

/** Wire the removal request for the profile `memberId` in `box`. `dest` reads Settings › Save to. */
export async function mountRemoval(box: HTMLElement, memberId: number, dest: () => Destination) {
  const store = localRemovals();
  let check: AbortController | null = null;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
  const send: Send = (req) => sendMessage<'FPR_REMOVAL'>({ type: 'FPR_REMOVAL', ...req }).catch(failed);

  function idle() {
    box.innerHTML = LINK;
    q('#meBtn').addEventListener('click', open);
  }

  function sent(s: Extract<RemovalState, { state: 'sent' }>, line?: string) {
    box.innerHTML = `<div class="done"><p class="what"><b>You asked for this profile's removal</b></p>
      <p class="sub">${esc(line ?? `Sent to ${host(s.server)} ${ago(s.at)}. The maintainer reviews it; nothing changes until then.`)}</p></div>`;
  }

  /** "Just me": nothing is shared, so there's no one to ask. */
  function local() {
    box.innerHTML = `<div class="sheet me-sheet"><h3>Ask to remove your profile</h3>
      <p class="me-p">A removal request goes to a server, and Save to is set to Just me, so nothing here is shared. To ask a server that holds your profile, choose it in Settings › Save to.</p>
      <div class="row"><button type="button" class="btn secondary" id="meClose">Close</button></div></div>`;
    q('#meClose').addEventListener('click', idle);
  }

  function form(code: string) {
    box.innerHTML = `<form class="sheet me-sheet" novalidate>
      <h3>Ask to remove your profile</h3>
      <p class="me-p">Only for your own profile. Add this code anywhere in your headline or About on LinkedIn and save it there, then check and send.</p>
      <div class="me-code"><code>${esc(code)}</code><button type="button" class="lnk" id="meCopy">Copy</button></div>
      <div><label class="fl-l" for="meContact">How to reach you <span>optional</span></label>
        <input class="field" id="meContact" type="text" maxlength="200" autocomplete="off" spellcheck="false" />
        <p class="me-small">Only the maintainer sees it, and it's deleted once your request is decided.</p></div>
      <p class="me-small">The maintainer reads your profile, and looks at its signals and reports, before approving or declining. Nothing is hidden or removed until then.</p>
      <p class="err" id="meError" role="alert"></p>
      <div class="check hidden" id="meCheck"></div>
      <div class="row">
        <button type="button" class="btn secondary" id="meCancel">Cancel</button>
        <button type="submit" class="btn primary grow" id="meSend">Check and send</button>
      </div>
    </form>`;
    q('#meCopy').addEventListener('click', async () => {
      const ok = await navigator.clipboard?.writeText(code).then(() => true, () => false);
      if (ok) q('#meCopy').textContent = 'Copied';
      else getSelection()?.selectAllChildren(q('code'));
    });
    q('#meCancel').addEventListener('click', async () => {
      check?.abort();
      await store.cancel(memberId).catch(() => {});
      idle();
      q('#meBtn').focus();
    });
    q<HTMLFormElement>('form').addEventListener('submit', (e) => {
      e.preventDefault();
      void submit(code);
    });
  }

  const busy = (on: boolean, label = 'Check and send') => {
    const btn = q<HTMLButtonElement>('#meSend');
    btn.disabled = on;
    btn.textContent = label;
    q<HTMLInputElement>('#meContact').disabled = on;
  };

  async function show(out: RemovalOutcome, server: string) {
    if (out.kind === 'sent' || (out.kind === 'refused' && out.error === 'already_pending')) {
      await store.markSent(memberId, server).catch(() => {});
      const s = await store.get(memberId).catch(() => null);
      return sent(s?.state === 'sent' ? s : { state: 'sent', server, at: Date.now() }, outcomeText(out, server));
    }
    if (out.kind === 'verify') return runCheck(server, out.verifyUrl);
    q('#meError').textContent = outcomeText(out, server);
  }

  async function submit(code: string) {
    const server = dest().base;
    if (!server) return local();
    q('#meError').textContent = '';
    busy(true, 'Checking your profile…');
    const contact = q<HTMLInputElement>('#meContact').value;
    const out = await checkAndSend({
      memberId,
      code,
      contact,
      scan: () => sendMessage<'FPR_SCAN'>({ type: 'FPR_SCAN', force: true }),
      send,
    });
    busy(false);
    await show(out, server);
  }

  /** The bot check in the form, then the request once more (its code was already found). */
  async function runCheck(server: string, verifyUrl: string) {
    const s = await store.get(memberId).catch(() => null);
    if (s?.state !== 'issued') return;
    const req = removalRequest(memberId, s.code, q<HTMLInputElement>('#meContact').value);
    check?.abort();
    const ctl = (check = new AbortController());
    busy(true, 'Waiting for the check…');
    let done: RemovalOutcome | null = null;
    const renew = async () => {
      const out = answerOutcome(await send(req));
      if (out.kind === 'verify') return out.verifyUrl;
      done = out;
      return null;
    };
    const passed = await mountCheck(q('#meCheck'), { server, verifyUrl, renew, signal: ctl.signal });
    if (ctl.signal.aborted) return;
    check = null;
    busy(false);
    if (!passed) return;
    q('#meCheck').classList.add('hidden');
    const out = done ?? answerOutcome(await send(req));
    // Once is enough: a second refusal shows as a message, not another check.
    await show(out.kind === 'verify' ? { kind: 'refused', error: 'verification_required' } : out, server);
  }

  async function open() {
    if (!dest().base) return local();
    const s = await store.issue(memberId).catch(() => null);
    if (!s) return render();
    form(s.code);
    q('#meCopy').focus();
  }

  async function render() {
    const s = await store.get(memberId).catch(() => null);
    if (s?.state === 'sent') return sent(s);
    if (s?.state === 'issued') return form(s.code);
    idle();
  }

  await render();
}
