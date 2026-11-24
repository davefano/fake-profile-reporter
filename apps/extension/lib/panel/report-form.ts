// What you say about the page: report it, flag that someone used this
// person's identity, or vouch for it. A form under the actions (stance cards,
// reason chips, a private note), and a one-line summary with Edit and
// Withdraw once you've said something. A server that wants the bot check
// first gets it inside the form (verify.ts); what you wrote is already saved
// in this browser, so nothing is lost on the way.

import { NOTE_MAX, reasonLabel, reasonsFor, stancesFor, type ReportCounts, type ReportKind, type ReportStance } from '@fpr/core/scam';
import type { ReportRequest } from '@fpr/core/wire';
import type { ApiError } from '@/lib/api';
import { isError, type ErrorResponse } from '@/lib/runtime';
import { localSaves, needsSync, type LocalReport, type SavedItem } from '@/lib/saves/store';
import { sendMessage, type SubmitResponse, type WithdrawResult } from '@/lib/scan/messages';
import { ago, esc, host, panelError, plural } from './format';
import { mountCheck } from './verify';

const NOUN: Record<ReportKind, string> = { profile: 'person', company: 'company', job: 'job' };
const WORD: Record<ReportKind, string> = { profile: 'profile', company: 'company page', job: 'job' };

function stances(kind: ReportKind): Record<ReportStance, [string, string]> {
  return {
    report: ['Looks suspicious', 'A scam, or not who it claims to be'],
    impersonated: ["Someone used this person's identity", "Doesn't count against the real owner"],
    vouch: [`I know this ${NOUN[kind]} is real`, kind === 'profile' ? 'Counts in their favor' : 'Counts in its favor'],
  };
}

function said(kind: ReportKind, stance: ReportStance) {
  if (stance === 'report') return `You reported this ${WORD[kind]} as suspicious`;
  if (stance === 'impersonated') return 'You reported that someone used this identity';
  return `You vouched that this ${NOUN[kind]} is real`;
}

/** Every stance needs at least one reason. */
export const canSend = (reasons: string[]) => reasons.length > 0;

const hosts = (list: string[]) => list.map(host).join(', ');

/**
 * The summary once you've said something: what, and whether `base` (the
 * server Save to points at; null for this browser only) has it. `why` is the
 * last send's error, when it failed.
 */
export function summaryMarkup(kind: ReportKind, item: SavedItem | undefined, base: string | null, where: string | null, why?: string) {
  const r = item?.report;
  if (!item || !r) return '';
  const reasons = r.reasons.map((x) => reasonLabel(r.stance, x)).join(', ');
  const unsent = base !== null && needsSync(item, base);
  const others = Object.keys(item.heldBy).filter((s) => s !== base && needsSync(item, s));
  const sub = unsent
    ? `Saved in this browser, but not sent${why ? `: ${why}` : '.'}`
    : [ago(r.at), base ? `shared with ${where ?? host(base)}` : 'saved in this browser only', ...(r.note ? ['note kept private'] : [])].join(' · ');
  return `<p class="what"><b>${esc(said(kind, r.stance))}</b>${reasons ? ` · ${esc(reasons)}` : ''}</p>
    <p class="sub">${esc(sub)}</p>
    ${others.length ? `<p class="sub">${esc(`${hosts(others)} still ${others.length === 1 ? 'has' : 'have'} an older version. It's updated the next time you send there.`)}</p>` : ''}
    <div class="row"><button type="button" class="lnk" id="rsEdit">Edit</button><button type="button" class="lnk quiet" id="rsWithdraw">Withdraw</button>${unsent ? '<button type="button" class="lnk" id="rsSendNow">Send now</button>' : ''}</div>`;
}

/** Markup for the summary and the form; mountReport fills them. */
export function reportMarkup(kind: ReportKind) {
  const text = stances(kind);
  const cards = stancesFor(kind)
    .map((s, i) => `<label><input type="radio" name="rfStance" value="${s}"${i === 0 ? ' checked' : ''} /><span>${esc(text[s][0])}<small>${esc(text[s][1])}</small></span></label>`)
    .join('');
  return `
    <div class="done hidden" id="reportSummary" role="status"></div>
    <form class="sheet hidden" id="reportForm" novalidate>
      <h3 id="rfTitle">Report this ${WORD[kind]}</h3>
      <fieldset class="seg"><legend class="fl-l">What do you want to say?</legend>${cards}</fieldset>
      <fieldset><legend class="fl-l" id="rfWhy">What happened? <span>pick at least one</span></legend><div class="chips" id="rfReasons"></div></fieldset>
      <fieldset id="rfSure"><legend class="fl-l">How sure are you?</legend><div class="sure">
        <label><input type="radio" name="rfConfidence" value="suspected" checked />I suspect it</label>
        <label><input type="radio" name="rfConfidence" value="confirmed" />I confirmed it</label>
      </div></fieldset>
      <div><label class="fl-l" for="rfNote">Note <span>optional</span></label>
        <textarea class="note" id="rfNote" maxlength="${NOTE_MAX}" rows="3"></textarea>
        <div class="note-meta"><span>Only stored, never shown to anyone.</span><span id="rfCount">0/${NOTE_MAX}</span></div></div>
      <p class="err" id="rfError" role="alert"></p>
      <div class="check hidden" id="rfCheck"></div>
      <div class="row">
        <button type="button" class="btn secondary" id="rfCancel">Cancel</button>
        <button type="submit" class="btn danger grow" id="rfSend">Send report</button>
      </div>
    </form>`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function countsText(c: ReportCounts) {
  const parts = [c.reports ? plural(c.reports, 'report') : '', c.vouches ? plural(c.vouches, 'vouch', 'vouches') : '', c.impersonated ? `${c.impersonated} impersonation ${c.impersonated === 1 ? 'warning' : 'warnings'}` : ''];
  return parts.filter(Boolean).join(', ') || 'no reports';
}

const ERRORS: Record<string, string> = {
  daily_limit_reached: 'Daily limit reached. Try again tomorrow.',
  not_saved: 'The server doesn’t have this page yet. Try again.',
  reporter_key_required: 'This browser has no reporter key. Reload the extension and try again.',
  upgrade_required: 'Update the extension to report.',
  verify_unconfigured: "The server's bot check isn't set up, so it can't take reports right now.",
  verification_required: 'The server needs a quick check first.',
  removed: 'This profile was removed at its owner’s request.',
};
export const errorText = (e: ErrorResponse) => ERRORS[e.error] ?? e.message ?? e.error;
const failed = (e: unknown): ApiError => panelError(e);

/** Say that something stayed in this browser, with "Send now" (never an automatic retry). */
export function showUnsent(why: string, sendNow: () => void) {
  const el = $('submitStatus');
  el.className = 'status err';
  el.innerHTML = `${esc(`Saved in this browser, but not sent: ${why}`)} <button type="button" class="lnk" id="statusSendNow">Send now</button>`;
  $('statusSendNow').addEventListener('click', sendNow, { once: true });
}

function setStatus(kind: 'ok' | 'err' | '', text: string) {
  const el = $('submitStatus');
  el.className = `status ${kind}`.trim();
  el.textContent = text;
}

/** Where saves go: the server's origin (null for "Just me") and what to call it. */
export interface Destination {
  base: string | null;
  label: string | null;
}

/**
 * Wire the report controls for the page in `key`. `dest` reads Settings ›
 * Save to; `onChange` runs after anything is sent or withdrawn.
 */
export async function mountReport(key: string, kind: ReportKind, dest: () => Destination, onChange: () => void) {
  let item = await localSaves().get(key).catch(() => undefined);
  let why: string | undefined;
  let check: AbortController | null = null;
  const form = $<HTMLFormElement>('reportForm');
  const actions = form.closest<HTMLElement>('.actions')!;
  const idle = $('actionIdle');
  const reportBtn = $<HTMLButtonElement>('reportBtn');
  const trackBtn = $<HTMLButtonElement>('trackBtn');
  const existing = (): LocalReport | null => item?.report ?? null;

  const stance = () => (form.querySelector<HTMLInputElement>('input[name="rfStance"]:checked')?.value ?? 'report') as ReportStance;
  const checked = () => [...form.querySelectorAll<HTMLInputElement>('input[name="rfReason"]:checked')].map((x) => x.value);

  function renderReasons(keep: string[] = []) {
    const s = stance();
    $('rfReasons').innerHTML = reasonsFor(s)
      .map((r) => `<label><input type="checkbox" name="rfReason" value="${r.id}"${keep.includes(r.id) ? ' checked' : ''} />${esc(r.label)}</label>`)
      .join('');
    $('rfWhy').innerHTML = `${s === 'vouch' ? 'How do you know?' : 'What happened?'} <span>pick at least one</span>`;
    $('rfSure').classList.toggle('hidden', s !== 'report');
    $<HTMLTextAreaElement>('rfNote').placeholder = s === 'vouch' ? 'How you know them' : 'What happened, in your words';
    const send = $<HTMLButtonElement>('rfSend');
    send.textContent = s === 'vouch' ? 'Vouch' : existing() ? 'Save changes' : s === 'report' ? 'Send report' : 'Send';
    send.className = `btn grow ${s === 'vouch' ? 'primary' : 'danger'}`;
  }

  function render() {
    const open = !form.classList.contains('hidden');
    const summary = $('reportSummary');
    const d = dest();
    const html = open ? '' : summaryMarkup(kind, item, d.base, d.label, why);
    summary.innerHTML = html;
    summary.classList.toggle('hidden', !html);
    summary.classList.toggle('offline', !!d.base && !!item?.report && needsSync(item, d.base));
    idle.classList.toggle('hidden', open || !!html);
    actions.classList.toggle('open', open);
    if (!html) return;
    $('rsEdit').addEventListener('click', () => openForm(existing()));
    $('rsWithdraw').addEventListener('click', withdraw);
    document.getElementById('rsSendNow')?.addEventListener('click', sendNow);
  }

  function openForm(from: LocalReport | null, preset?: ReportStance) {
    const s = from?.stance ?? preset ?? 'report';
    form.querySelectorAll<HTMLInputElement>('input[name="rfStance"]').forEach((r) => (r.checked = r.value === s));
    renderReasons(from?.reasons ?? []);
    form.querySelectorAll<HTMLInputElement>('input[name="rfConfidence"]').forEach((r) => (r.checked = r.value === (from?.confidence ?? 'suspected')));
    $<HTMLTextAreaElement>('rfNote').value = from?.note ?? '';
    $('rfCount').textContent = `${from?.note?.length ?? 0}/${NOTE_MAX}`;
    $('rfError').textContent = '';
    $('rfTitle').textContent = from ? 'Edit your report' : s === 'vouch' ? `Vouch for this ${NOUN[kind]}` : `Report this ${WORD[kind]}`;
    form.classList.remove('hidden');
    render();
    form.querySelector<HTMLInputElement>('input[name="rfStance"]:checked')?.focus();
  }

  /** Close the form. Mid-check the draft is already saved in this browser; the fields stay as they are. */
  function close() {
    check?.abort();
    check = null;
    busy(false);
    $('rfCheck').classList.add('hidden');
    form.classList.add('hidden');
    render();
    (reportBtn.offsetParent ? reportBtn : document.getElementById('rsEdit'))?.focus();
  }

  const busy = (on: boolean, label?: string) => {
    const btn = $<HTMLButtonElement>('rfSend');
    btn.disabled = on;
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea').forEach((x) => (x.disabled = on));
    if (label) btn.textContent = label;
  };

  /** Show a send's outcome; on `verification_required`, run the check in the form and send once more. */
  async function outcome(res: SubmitResponse, retried = false) {
    item = (await localSaves().get(key).catch(() => undefined)) ?? item;
    if (isError(res) && res.error === 'verification_required' && res.verifyUrl && res.server && !retried && existing()) {
      if (form.classList.contains('hidden')) openForm(existing());
      return runCheck(res.server, res.verifyUrl);
    }
    if (isError(res) && !res.savedLocally) {
      $('rfError').textContent = errorText(res);
      return;
    }
    why = isError(res) ? errorText(res) : undefined;
    if (!form.classList.contains('hidden')) close();
    trackBtn.textContent = 'Saved ✓';
    trackBtn.disabled = true;
    render();
    const d = dest();
    if (isError(res)) setStatus('', '');
    else if (!res.server) setStatus('ok', 'Saved in this browser only. To share it, change Save to in Settings.');
    else setStatus('ok', `Sent to ${d.label ?? 'the server'}.${res.server.counts ? ` It now has ${countsText(res.server.counts)}.` : ''}`);
    onChange();
  }

  async function runCheck(server: string, verifyUrl: string) {
    check?.abort();
    const ctl = (check = new AbortController());
    const box = $('rfCheck');
    $('rfError').textContent = '';
    busy(true, 'Waiting for the check…');
    // A fresh challenge comes with the next refusal; a send that goes through needs none.
    let sent: SubmitResponse | null = null;
    const renew = async () => {
      const res = await sendMessage<'FPR_SYNC'>({ type: 'FPR_SYNC', key }).catch(failed);
      if (isError(res) && res.error === 'verification_required' && res.verifyUrl) return res.verifyUrl;
      if (isError(res)) throw new Error(errorText(res));
      sent = res;
      return null;
    };
    const passed = await mountCheck(box, { server, verifyUrl, key, renew, signal: ctl.signal });
    if (ctl.signal.aborted) return;
    check = null;
    busy(false);
    renderReasons(checked());
    if (!passed) return;
    box.classList.add('hidden');
    // Sent already when a renewal found no check needed; otherwise send once more.
    await outcome(sent ?? (await sendMessage<'FPR_SYNC'>({ type: 'FPR_SYNC', key }).catch(failed)), true);
  }

  async function send(e: Event) {
    e.preventDefault();
    const reasons = checked();
    const s = stance();
    if (!canSend(reasons)) {
      $('rfError').textContent = 'Pick at least one reason.';
      return;
    }
    const note = $<HTMLTextAreaElement>('rfNote').value.trim();
    const confidence = form.querySelector<HTMLInputElement>('input[name="rfConfidence"]:checked')?.value as 'suspected' | 'confirmed' | undefined;
    const report: ReportRequest = { stance: s, reasons, ...(s === 'report' && confidence && { confidence }), ...(note && { note }) };
    $('rfError').textContent = '';
    busy(true, 'Sending…');
    const res = await sendMessage<'FPR_SUBMIT'>({ type: 'FPR_SUBMIT', key, report }).catch(failed);
    busy(false);
    renderReasons(reasons);
    await outcome(res);
  }

  async function sendNow() {
    setStatus('', 'Sending…');
    await outcome(await sendMessage<'FPR_SYNC'>({ type: 'FPR_SYNC', key }).catch(failed));
  }

  async function withdraw() {
    const res: WithdrawResult = await sendMessage<'FPR_WITHDRAW'>({ type: 'FPR_WITHDRAW', key }).catch(failed);
    if (isError(res)) return setStatus('err', `Couldn't withdraw it: ${errorText(res)}`);
    item = (await localSaves().get(key).catch(() => undefined)) ?? item;
    why = undefined;
    render();
    const base = dest().base;
    const here = base !== null && res.unsent.includes(base);
    const elsewhere = res.unsent.filter((s) => s !== base);
    const later = elsewhere.length ? ` ${hosts(elsewhere)} ${elsewhere.length === 1 ? 'gets' : 'get'} the withdrawal the next time you send there.` : '';
    if (here) showUnsent(`the withdrawal didn't reach ${dest().label ?? host(base)}.${later}`, sendNow);
    else setStatus('ok', `Withdrawn. It no longer counts.${later}`);
    reportBtn.focus();
    onChange();
  }

  form.querySelectorAll<HTMLInputElement>('input[name="rfStance"]').forEach((r) => r.addEventListener('change', () => renderReasons()));
  $<HTMLTextAreaElement>('rfNote').addEventListener('input', (e) => ($('rfCount').textContent = `${(e.target as HTMLTextAreaElement).value.length}/${NOTE_MAX}`));
  $('rfCancel').addEventListener('click', close);
  form.addEventListener('submit', send);
  reportBtn.addEventListener('click', () => openForm(existing(), 'report'));
  $('vouchBtn').addEventListener('click', () => openForm(existing(), 'vouch'));
  render();
}
