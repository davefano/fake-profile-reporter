// What you say about the page: report it, flag that someone used this
// person's identity, or vouch for it. An inline form under the actions, and a
// one-line summary with Edit and Withdraw once you've said something.

import { NOTE_MAX, reasonLabel, reasonsFor, stancesFor, type ReportCounts, type ReportKind, type ReportStance } from '@fpr/core/scam';
import type { ReportRequest } from '@fpr/core/wire';
import { isError, type ErrorResponse } from '@/lib/runtime';
import { localSaves, type LocalReport } from '@/lib/saves/store';
import { sendMessage, type SubmitResponse, type WithdrawResult } from '@/lib/scan/messages';
import { esc } from './format';

const NOUN: Record<ReportKind, string> = { profile: 'person', company: 'company', job: 'job' };

function stanceLabel(kind: ReportKind, stance: ReportStance) {
  if (stance === 'report') return 'Looks suspicious';
  if (stance === 'impersonated') return "Someone used this person's identity";
  return `I know this ${NOUN[kind]} is real`;
}

const SAID: Record<ReportStance, string> = { report: 'You reported this', impersonated: 'You flagged that someone used this identity', vouch: 'You vouched for this' };
const SEND: Record<ReportStance, string> = { report: 'Send report', impersonated: 'Send', vouch: 'Send vouch' };

/** Markup for the actions block; mountReport fills it. */
export function reportMarkup(kind: ReportKind) {
  const stances = stancesFor(kind)
    .map((s, i) => `<label class="rf-choice"><input type="radio" name="rfStance" value="${s}"${i === 0 ? ' checked' : ''} /> ${esc(stanceLabel(kind, s))}</label>`)
    .join('');
  return `
    <p class="report-summary hidden" id="reportSummary"></p>
    <form class="report-form hidden" id="reportForm" novalidate>
      <fieldset><legend>What do you want to say?</legend>${stances}</fieldset>
      <fieldset><legend>Why?</legend><div id="rfReasons"></div></fieldset>
      <fieldset id="rfSure"><legend>How sure are you?</legend>
        <label class="rf-choice"><input type="radio" name="rfConfidence" value="suspected" checked /> I suspect it</label>
        <label class="rf-choice"><input type="radio" name="rfConfidence" value="confirmed" /> I confirmed it</label>
      </fieldset>
      <label class="field-label" for="rfNote">Note (optional)</label>
      <textarea class="field rf-note" id="rfNote" maxlength="${NOTE_MAX}" rows="3"></textarea>
      <p class="rf-help"><span id="rfCount">0</span>/${NOTE_MAX} · Only stored, never shown to anyone.</p>
      <p class="status" id="rfError" role="alert"></p>
      <div class="btn-row even">
        <button type="button" class="btn secondary" id="rfCancel">Cancel</button>
        <button type="submit" class="btn danger" id="rfSend">Send report</button>
      </div>
    </form>`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function setStatus(kind: 'ok' | 'err' | '', text: string) {
  const el = $('submitStatus');
  el.className = `status ${kind}`.trim();
  el.textContent = text;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
export function countsText(c: ReportCounts) {
  const parts = [c.reports ? plural(c.reports, 'report') : '', c.vouches ? plural(c.vouches, 'vouch').replace('vouchs', 'vouches') : '', c.impersonated ? `${c.impersonated} impersonation ${c.impersonated === 1 ? 'warning' : 'warnings'}` : ''];
  return parts.filter(Boolean).join(', ') || 'no reports';
}

const ERRORS: Record<string, string> = {
  daily_limit_reached: 'Daily limit reached. Try again tomorrow.',
  not_saved: 'The server doesn’t have this page yet. Try again.',
  reporter_key_required: 'This browser has no reporter key. Reload the extension and try again.',
};

/**
 * Wire the report controls for the page in `key`. `where` names the
 * destination for status lines ("this browser" or a server); `onChange` runs
 * after anything is sent or withdrawn.
 */
export async function mountReport(key: string, kind: ReportKind, where: () => string | null, onChange: () => void) {
  let existing: LocalReport | null = (await localSaves().get(key).catch(() => undefined))?.report ?? null;
  const form = $<HTMLFormElement>('reportForm');
  const reportBtn = $<HTMLButtonElement>('reportBtn');
  const trackBtn = $<HTMLButtonElement>('trackBtn');

  const stance = () => (form.querySelector<HTMLInputElement>('input[name="rfStance"]:checked')?.value ?? 'report') as ReportStance;

  function renderReasons(checked: string[] = []) {
    const s = stance();
    $('rfReasons').innerHTML = reasonsFor(s)
      .map((r) => `<label class="rf-choice"><input type="checkbox" name="rfReason" value="${r.id}"${checked.includes(r.id) ? ' checked' : ''} /> ${esc(r.label)}</label>`)
      .join('');
    $('rfSure').classList.toggle('hidden', s !== 'report');
    const send = $<HTMLButtonElement>('rfSend');
    send.textContent = SEND[s];
    send.className = `btn ${s === 'vouch' ? 'primary' : 'danger'}`;
  }

  function renderSummary() {
    const el = $('reportSummary');
    el.classList.toggle('hidden', !existing);
    reportBtn.textContent = existing ? 'Change what you said' : 'Report or vouch';
    if (!existing) return;
    const reasons = existing.reasons.map((r) => reasonLabel(existing!.stance, r)).join(', ');
    const sure = existing.confidence === 'confirmed' ? ' (confirmed)' : '';
    el.innerHTML = `<span>${esc(SAID[existing.stance])}${esc(sure)}: ${esc(reasons)}.</span>
      <button type="button" class="link-btn" id="rsEdit">Edit</button>
      <button type="button" class="link-btn" id="rsWithdraw">Withdraw</button>`;
    $('rsEdit').addEventListener('click', () => open(existing));
    $('rsWithdraw').addEventListener('click', withdraw);
  }

  function open(from: LocalReport | null) {
    const s = from?.stance ?? 'report';
    form.querySelectorAll<HTMLInputElement>('input[name="rfStance"]').forEach((r) => (r.checked = r.value === s));
    renderReasons(from?.reasons ?? []);
    form.querySelectorAll<HTMLInputElement>('input[name="rfConfidence"]').forEach((r) => (r.checked = r.value === (from?.confidence ?? 'suspected')));
    $<HTMLTextAreaElement>('rfNote').value = from?.note ?? '';
    $('rfCount').textContent = String(from?.note?.length ?? 0);
    $('rfError').textContent = '';
    form.classList.remove('hidden');
    form.querySelector<HTMLInputElement>('input[name="rfStance"]:checked')?.focus();
  }

  const close = () => form.classList.add('hidden');

  async function send(e: Event) {
    e.preventDefault();
    const reasons = [...form.querySelectorAll<HTMLInputElement>('input[name="rfReason"]:checked')].map((x) => x.value);
    if (!reasons.length) {
      $('rfError').className = 'status err';
      $('rfError').textContent = 'Pick at least one reason.';
      return;
    }
    const s = stance();
    const note = $<HTMLTextAreaElement>('rfNote').value.trim();
    const confidence = form.querySelector<HTMLInputElement>('input[name="rfConfidence"]:checked')?.value as 'suspected' | 'confirmed' | undefined;
    const report: ReportRequest = { stance: s, reasons, ...(s === 'report' && confidence && { confidence }), ...(note && { note }) };
    const btn = $<HTMLButtonElement>('rfSend');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const res: SubmitResponse = await sendMessage<'FPR_SUBMIT'>({ type: 'FPR_SUBMIT', key, report }).catch((e): ErrorResponse => ({ error: 'panel_error', message: String(e) }));
    btn.disabled = false;
    renderReasons(reasons);
    if (isError(res) && !res.savedLocally) {
      $('rfError').className = 'status err';
      $('rfError').textContent = ERRORS[res.error] ?? res.message ?? res.error;
      return;
    }
    existing = (await localSaves().get(key))?.report ?? null;
    close();
    renderSummary();
    trackBtn.textContent = 'Saved ✓';
    trackBtn.disabled = true;
    const target = where();
    if (isError(res)) setStatus('err', `Saved in this browser, but not sent: ${ERRORS[res.error] ?? res.message ?? res.error}`);
    else if (!res.server) setStatus('ok', 'Saved in this browser only. To share it, change Save to in Settings.');
    else setStatus('ok', `Sent to ${target}. ${res.server.counts ? `It now has ${countsText(res.server.counts)}.` : ''}`.trim());
    onChange();
  }

  async function withdraw() {
    const res: WithdrawResult = await sendMessage<'FPR_WITHDRAW'>({ type: 'FPR_WITHDRAW', key }).catch((e): ErrorResponse => ({ error: 'panel_error', message: String(e) }));
    if (isError(res)) return setStatus('err', `Couldn't withdraw it: ${ERRORS[res.error] ?? res.message ?? res.error}`);
    existing = null;
    close();
    renderSummary();
    const left = res.elsewhere.length ? ` ${res.elsewhere.map((s) => new URL(s).host).join(', ')} still ${res.elsewhere.length === 1 ? 'has' : 'have'} it; switch Save to there to withdraw it too.` : '';
    setStatus('ok', `Withdrawn.${left}`);
    onChange();
  }

  form.querySelectorAll<HTMLInputElement>('input[name="rfStance"]').forEach((r) => r.addEventListener('change', () => renderReasons()));
  $<HTMLTextAreaElement>('rfNote').addEventListener('input', (e) => ($('rfCount').textContent = String((e.target as HTMLTextAreaElement).value.length)));
  $('rfCancel').addEventListener('click', close);
  form.addEventListener('submit', send);
  reportBtn.addEventListener('click', () => (form.classList.contains('hidden') ? open(existing) : close()));
  renderSummary();
}
