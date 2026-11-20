// The extension UI: mounting, state, and actions. Mounted by the Chrome side
// panel, the Firefox sidebar, and the Safari popup (Safari has no sidebar API).

import { API_BASE } from '@/lib/config';
import { isError, type ErrorResponse } from '@/lib/runtime';
import { linkedInTarget } from '@flr/core/linkedin';
import { scanKey, sendMessage, targetKey, type ScanResult } from '@/lib/scan/messages';
import { invalidateLeaderboard, loadLeaderboard } from './leaderboard';
import { renderResult } from './views';
import './panel.css';

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2.5 4.5 7v8.2c0 7.1 4.9 12.6 11.5 14.3 6.6-1.7 11.5-7.2 11.5-14.3V7z" fill="currentColor" opacity=".14"/><path d="M16 2.5 4.5 7v8.2c0 7.1 4.9 12.6 11.5 14.3 6.6-1.7 11.5-7.2 11.5-14.3V7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="15" cy="14.5" r="4.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m18.4 18 3.6 3.6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;


const MARKUP = `
<header class="top">
  <div class="brand">
    <span class="mark">${LOGO}</span>
    <div class="brand-text">
      <div class="title">Fake LinkedIn Reporter</div>
      <div class="subtitle" id="apiBase">Side Panel</div>
    </div>
    <button class="icon-btn" id="rescan" title="Scan again" aria-label="Scan again">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 10a6.5 6.5 0 1 1-2-4.7M16.5 3.5v3.8h-3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
  <nav class="tabs" role="tablist">
    <button class="tab active" data-tab="scan" role="tab">This page</button>
    <button class="tab" data-tab="board" role="tab">Leaderboard</button>
  </nav>
</header>

<main>
  <section id="view-scan" class="view active">
    <div id="state-loading" class="hidden">
      <div class="skel-hero"><div class="skel circle"></div><div class="skel-lines"><div class="skel w70"></div><div class="skel w90"></div><div class="skel w40"></div></div></div>
      <div class="skel-score"><div class="skel num"></div><div class="skel-lines"><div class="skel w40"></div><div class="skel w90"></div></div></div>
      <div class="skel bar"></div>
      <div class="skel-grid"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>
      <p class="loading-step" id="loadingStep" role="status">Reading the page…</p>
    </div>

    <div id="state-empty" class="hidden">
      <div class="empty">
        <svg class="empty-art" viewBox="0 0 120 96" aria-hidden="true">
          <rect x="14" y="14" width="76" height="62" rx="10" fill="var(--sunken)" stroke="var(--line)" stroke-width="2"/>
          <circle cx="38" cy="38" r="10" fill="var(--line)"/>
          <rect x="54" y="32" width="26" height="5" rx="2.5" fill="var(--line)"/>
          <rect x="54" y="42" width="18" height="5" rx="2.5" fill="var(--line)"/>
          <rect x="26" y="58" width="52" height="5" rx="2.5" fill="var(--line)"/>
          <circle cx="86" cy="62" r="14" fill="var(--bg)" stroke="var(--accent)" stroke-width="3.5"/>
          <path d="m96 72 10 10" stroke="var(--accent)" stroke-width="4.5" stroke-linecap="round"/>
        </svg>
        <h2>Open a profile, company, or job</h2>
        <p>Go to a LinkedIn profile, company page, or job posting. This panel follows your tab and checks each one you open.</p>
      </div>
    </div>

    <div id="state-error" class="hidden">
      <div class="empty">
        <h2 id="errorTitle">Couldn't read this profile</h2>
        <p id="errorText"></p>
        <button id="retry" class="btn secondary">Try again</button>
      </div>
    </div>

    <div id="result" class="hidden"></div>
  </section>

  <section id="view-board" class="view">
    <div id="boardList"></div>
  </section>
</main>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STATES = ['state-loading', 'state-empty', 'state-error', 'result'] as const;

let current: ScanResult | null = null;
let scanSeq = 0;
let lastKey: string | null = null;
let loadingTimer: ReturnType<typeof setInterval> | undefined;

// --- state ---------------------------------------------------------------------
function showState(id: (typeof STATES)[number]) {
  for (const s of STATES) $(s).classList.toggle('hidden', s !== id);
  clearInterval(loadingTimer);
  if (id === 'state-loading') {
    const steps = ['Reading the page…', 'Checking history…', 'Looking at activity…', 'Scoring…'];
    let i = 0;
    $('loadingStep').textContent = steps[0]!;
    loadingTimer = setInterval(() => ($('loadingStep').textContent = steps[Math.min(++i, steps.length - 1)]!), 900);
  }
}

async function scan(force = false) {
  const seq = ++scanSeq;
  showState('state-loading');
  $('rescan').classList.add('spinning');
  const res = await sendMessage<'FLR_SCAN'>({ type: 'FLR_SCAN', force }).catch((e): ErrorResponse => ({ error: 'panel_error', message: String(e) }));
  if (seq !== scanSeq) return; // a newer scan started
  $('rescan').classList.remove('spinning');

  if (isError(res)) {
    if (res.error === 'not_linkedin_target') return showState('state-empty');
    const gone = res.error === 'profile_unavailable' || res.error === 'not_found';
    $('errorTitle').textContent = gone ? 'Nothing to check here' : "Couldn't read this page";
    $('errorText').textContent = gone
      ? 'LinkedIn returned nothing for this page. It may have been removed or restricted, or its URL changed. That is not evidence either way.'
      : res.message || res.error;
    return showState('state-error');
  }
  current = res;
  lastKey = scanKey(res);
  $('result').innerHTML = renderResult(res);
  bindResult();
  showState('result');
}

// --- actions ---------------------------------------------------------------------
function bindResult() {
  $('trackBtn').addEventListener('click', () => submit(false));
  $('reportBtn').addEventListener('click', () => submit(true));
  $('result').querySelectorAll<HTMLImageElement>('.avatar img').forEach((img) =>
    img.addEventListener('error', () => img.remove(), { once: true }),
  );
}

async function submit(report: boolean) {
  if (!current) return;
  const btn = $<HTMLButtonElement>(report ? 'reportBtn' : 'trackBtn');
  const other = $<HTMLButtonElement>(report ? 'trackBtn' : 'reportBtn');
  const status = $('submitStatus');
  const label = btn.textContent;
  btn.disabled = other.disabled = true;
  btn.textContent = report ? 'Reporting…' : 'Saving…';
  status.className = 'status';
  status.textContent = '';

  const res = await sendMessage<'FLR_SUBMIT'>({ type: 'FLR_SUBMIT', key: scanKey(current), report }).catch((e): ErrorResponse => ({
    error: 'panel_error',
    message: String(e),
  }));
  if (!isError(res)) {
    btn.textContent = report ? 'Reported ✓' : 'Tracked ✓';
    other.disabled = report; // can still report after tracking
    status.className = 'status ok';
    // The directory scores without viewer-relative signals, so its number can differ.
    const theirs = res.score !== current.score.score ? ` The directory scores it ${res.score}/100.` : '';
    status.textContent = (report ? 'Reported and saved to the directory. Thank you.' : 'Saved to the shared directory.') + theirs;
    if (res.reported) invalidateLeaderboard();
    return;
  }
  btn.disabled = other.disabled = false;
  btn.textContent = label;
  status.className = 'status err';
  const MSG: Record<string, string> = {
    already_reported_recently: 'You reported this recently.',
    daily_limit_reached: 'Daily limit reached. Try again tomorrow.',
    captured_recently: 'This was saved a few minutes ago.',
    observed_recently: 'This was saved a few minutes ago.',
  };
  status.textContent = MSG[res.error] ?? res.message ?? res.error;
}

// --- mount -----------------------------------------------------------------------
function bindTabs() {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.tab));
      if (btn.dataset.tab === 'board') loadLeaderboard($('boardList'));
    });
  });
}

/** Follow the active tab: rescan when it lands on a different profile. */
function followTabs() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const key = targetKey(linkedInTarget(tab?.url));
      if (key !== lastKey) {
        lastKey = key;
        scan();
      }
    }, 400);
  };
  browser.tabs.onActivated.addListener(check);
  browser.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab.active && (info.url || info.status === 'complete')) check();
  });
}

/**
 * Tell the background this window's panel is open, so the toolbar button can
 * close it. Reconnects if the service worker restarts.
 */
async function announcePanel() {
  if (!(browser as any).sidePanel) return; // Chrome only; Firefox/Safari toggle natively.
  const win = await browser.windows.getCurrent().catch(() => null);
  if (!win?.id) return;
  const connect = () => {
    let port: Browser.runtime.Port;
    try {
      port = browser.runtime.connect({ name: `panel:${win.id}` });
    } catch {
      return; // extension was reloaded or removed; this page is orphaned
    }
    port.onMessage.addListener((msg) => {
      if (msg === 'close') window.close();
    });
    port.onDisconnect.addListener(() => setTimeout(connect, 250));
  };
  connect();
}

export async function mountPanel() {
  document.body.innerHTML = MARKUP;
  bindTabs();
  $('rescan').addEventListener('click', () => scan(true));
  $('retry').addEventListener('click', () => scan(true));
  followTabs();
  announcePanel();

  // Safari shows this UI as a popup, not a side panel.
  const surface = location.pathname.includes('popup') ? '' : 'Side Panel · ';
  $('apiBase').textContent = `${surface}${new URL(API_BASE).host}`;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  lastKey = targetKey(linkedInTarget(tab?.url));
  scan();
}
