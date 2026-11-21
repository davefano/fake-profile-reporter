// Settings: where saves go, and moving saves in and out of this browser.

import { COMMUNITY_URL } from '@/lib/config';
import { isError, type ErrorResponse } from '@/lib/runtime';
import { getSettings, normalizeServer, serverBase, updateSettings, type SaveMode, type Settings } from '@/lib/saves/settings';
import { exportFile, localSaves, parseExport, pendingFor } from '@/lib/saves/store';
import { sendMessage } from '@/lib/scan/messages';
import { esc } from './format';

export const SETTINGS_MARKUP = `
<h2 class="set-h">Save to</h2>
<p class="set-p">Where Track and Report send what you save. A copy always stays in this browser.</p>
<div class="choices" role="radiogroup" aria-label="Save to">
  <label class="choice"><input type="radio" name="mode" value="local" /><span><b>Just me</b><small>Saves stay in this browser. Nothing is sent anywhere.</small></span></label>
  <label class="choice" id="communityChoice"><input type="radio" name="mode" value="community" /><span><b>Community</b><small id="communityText">Also send saves to the shared database, and see what others have reported.</small></span></label>
  <label class="choice"><input type="radio" name="mode" value="custom" /><span><b>My own server</b><small>For a team, or for testing.</small></span></label>
</div>
<form id="customBox" class="custom hidden" novalidate>
  <label class="field-label" for="customUrl">Server address</label>
  <div class="field-row">
    <input id="customUrl" class="field" type="text" inputmode="url" placeholder="https://reports.example.org" spellcheck="false" autocomplete="off" />
    <button id="customConnect" class="btn primary" type="submit">Connect</button>
  </div>
  <p id="customStatus" class="status" role="status"></p>
</form>
<div id="uploadOffer" class="offer hidden" role="status">
  <p id="offerText"></p>
  <div class="btn-row even">
    <button id="offerNo" class="btn secondary">Not now</button>
    <button id="offerYes" class="btn primary">Upload</button>
  </div>
</div>

<h2 class="set-h">Your saves</h2>
<p class="set-p" id="saveCount">&nbsp;</p>
<div class="btn-row even">
  <button id="exportBtn" class="btn secondary">Export</button>
  <button id="importBtn" class="btn secondary">Import</button>
</div>
<input id="importFile" type="file" accept="application/json,.json" hidden />
<button id="uploadBtn" class="btn secondary wide hidden"></button>
<p id="dataStatus" class="status" role="status"></p>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const host = (base: string) => new URL(base).host;

function setStatus(id: string, kind: 'ok' | 'err' | '', text: string) {
  const el = $(id);
  el.className = `status ${kind}`.trim();
  el.textContent = text;
}

/** Fill the Settings view from storage. Call when it opens. */
export async function refreshSettings() {
  const s = await getSettings();
  const pick = $('customBox').dataset.picked === 'custom' ? 'custom' : s.mode;
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => (r.checked = r.value === pick));
  $('customBox').classList.toggle('hidden', pick !== 'custom');
  if (!$<HTMLInputElement>('customUrl').value) $<HTMLInputElement>('customUrl').value = s.customUrl;

  const items = await localSaves().list();
  const reported = items.filter((i) => i.reportedAt !== null).length;
  $('saveCount').textContent = items.length
    ? `${plural(items.length, 'save')} in this browser, ${reported} reported.`
    : 'Nothing saved in this browser yet.';
  $<HTMLButtonElement>('exportBtn').disabled = !items.length;

  const base = serverBase(s);
  const pending = base ? pendingFor(items, base).length : 0;
  $('uploadBtn').classList.toggle('hidden', !pending);
  if (base && pending) $('uploadBtn').textContent = `Upload ${plural(pending, 'save')} to ${host(base)}`;
  showOffer(s, base, pending);
}

/** Offer to upload earlier saves once per server, never automatically. */
function showOffer(s: Settings, base: string | null, pending: number) {
  const show = !!base && pending > 0 && !s.offeredUpload.includes(base);
  $('uploadOffer').classList.toggle('hidden', !show);
  if (show) $('offerText').textContent = `${plural(pending, 'save')} in this browser ${pending === 1 ? "isn't" : "aren't"} on ${host(base!)} yet. Upload ${pending === 1 ? 'it' : 'them'}?`;
}

async function markOffered() {
  const s = await getSettings();
  const base = serverBase(s);
  if (base && !s.offeredUpload.includes(base)) await updateSettings({ offeredUpload: [...s.offeredUpload, base] });
}

async function uploadNow() {
  $<HTMLButtonElement>('uploadBtn').disabled = $<HTMLButtonElement>('offerYes').disabled = true;
  setStatus('dataStatus', '', 'Uploading…');
  const res = await sendMessage<'FLR_UPLOAD'>({ type: 'FLR_UPLOAD' }).catch((e): ErrorResponse => ({ error: 'panel_error', message: String(e) }));
  $<HTMLButtonElement>('uploadBtn').disabled = $<HTMLButtonElement>('offerYes').disabled = false;
  if (isError(res)) setStatus('dataStatus', 'err', res.message ?? res.error);
  else if (res.failed) setStatus('dataStatus', 'err', `Uploaded ${res.uploaded}, ${res.failed} failed: ${res.error}`);
  else setStatus('dataStatus', 'ok', `Uploaded ${plural(res.uploaded, 'save')}.`);
  await refreshSettings();
}

async function chooseMode(mode: SaveMode) {
  setStatus('customStatus', '', '');
  setStatus('dataStatus', '', '');
  $('customBox').dataset.picked = mode;
  if (mode === 'custom') {
    const s = await getSettings();
    const base = normalizeServer(s.customUrl);
    // Connected before and still allowed: switch straight back.
    if (base && (await browser.permissions.contains({ origins: [`${base}/*`] }))) await updateSettings({ mode });
    else {
      $('customBox').classList.remove('hidden');
      setStatus('customStatus', '', 'Enter the address and press Connect. Until then, saves stay in this browser.');
      $('customUrl').focus();
    }
  } else {
    await updateSettings({ mode });
  }
  await refreshSettings();
}

async function connect(e: Event) {
  e.preventDefault();
  const base = normalizeServer($<HTMLInputElement>('customUrl').value);
  if (!base) return setStatus('customStatus', 'err', "That isn't a web address.");
  // Ask before anything else is awaited: browsers only show the prompt during the click.
  const granted = await browser.permissions.request({ origins: [`${base}/*`] }).catch(() => false);
  if (!granted) return setStatus('customStatus', 'err', `The extension needs permission to reach ${host(base)}.`);
  setStatus('customStatus', '', `Connecting to ${host(base)}…`);
  const ok = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.ok && r.json())
    .then((b) => b?.ok === true)
    .catch(() => false);
  if (!ok) return setStatus('customStatus', 'err', `Couldn't reach a Fake LinkedIn Reporter server at ${host(base)}. Saves stay in this browser.`);
  $<HTMLInputElement>('customUrl').value = base;
  await updateSettings({ mode: 'custom', customUrl: base });
  setStatus('customStatus', 'ok', `Connected. Saves now also go to ${host(base)}.`);
  await refreshSettings();
}

async function exportSaves() {
  const items = await localSaves().list();
  const url = URL.createObjectURL(new Blob([exportFile(items)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `fake-linkedin-reporter-saves-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus('dataStatus', 'ok', `Exported ${plural(items.length, 'save')}.`);
}

async function importSaves() {
  const file = $<HTMLInputElement>('importFile').files?.[0];
  $<HTMLInputElement>('importFile').value = '';
  if (!file) return;
  try {
    const { items, skipped } = parseExport(await file.text());
    const { added, updated } = await localSaves().merge(items);
    const parts = [`${added} added`, `${updated} updated`, ...(skipped ? [`${skipped} skipped (unreadable)`] : [])];
    setStatus('dataStatus', 'ok', `Imported: ${parts.join(', ')}.`);
  } catch (e) {
    setStatus('dataStatus', 'err', e instanceof Error ? e.message : String(e));
  }
  await refreshSettings();
}

export function bindSettings() {
  if (!COMMUNITY_URL) {
    $('communityChoice').classList.add('disabled');
    $('communityChoice').querySelector('input')!.disabled = true;
    $('communityText').innerHTML = `${esc('Also send saves to the shared database, and see what others have reported.')} <em>Not set up yet.</em>`;
  }
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => r.addEventListener('change', () => chooseMode(r.value as SaveMode)));
  $('customBox').addEventListener('submit', connect);
  $('offerYes').addEventListener('click', async () => {
    await markOffered();
    await uploadNow();
  });
  $('offerNo').addEventListener('click', async () => {
    await markOffered();
    await refreshSettings();
  });
  $('uploadBtn').addEventListener('click', uploadNow);
  $('exportBtn').addEventListener('click', exportSaves);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importSaves);
}
