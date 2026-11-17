import { gradeProfile } from './grader.js';
import { normalizeProfileUrl } from './url.js';

const API_BASE = 'http://localhost:8787';

// Open the side panel when the toolbar icon is clicked.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null && chrome.sidePanel?.open) {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

function isLinkedInProfile(url) {
  return /^https:\/\/www\.linkedin\.com\/in\//.test(url || '');
}

// Ask the content script in the active tab to extract profile data.
async function extractFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isLinkedInProfile(tab.url)) {
    return { error: 'not_linkedin_profile', tabUrl: tab?.url || null };
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'FLR_EXTRACT' });
  } catch {
    // Content script may not be injected yet (e.g. SPA nav); inject on demand.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tab.id, { type: 'FLR_EXTRACT' });
    } catch (e) {
      return { error: 'extract_failed', message: String(e) };
    }
  }
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'FLR_GRADE_ACTIVE') {
      const extracted = await extractFromActiveTab();
      if (extracted?.error) return sendResponse(extracted);
      const grader = gradeProfile(extracted.profile);
      const norm = normalizeProfileUrl(extracted.url);
      return sendResponse({ ...extracted, grader, normalized: norm });
    }

    if (msg?.type === 'FLR_REPORT') {
      const norm = normalizeProfileUrl(msg.url);
      if (!norm) return sendResponse({ error: 'invalid_profile_url' });
      const { status, data } = await apiPost('/api/report', {
        url: norm.url,
        profile: msg.profile || {},
      });
      return sendResponse({ status, data });
    }

    if (msg?.type === 'FLR_LEADERBOARD') {
      const { status, data } = await apiGet('/api/leaderboard?limit=50');
      return sendResponse({ status, data });
    }

    if (msg?.type === 'FLR_CONFIG') {
      return sendResponse({ API_BASE });
    }
  })();
  return true;
});
