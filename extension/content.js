// Runs on https://www.linkedin.com/in/* — extracts profile data from the DOM,
// optionally augments with LinkedIn's internal voyager API. Responds to
// {type:'FLR_EXTRACT'} messages from the side panel.

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function firstEl(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function scrapeDom() {
  const name = text(
    firstEl([
      'h1.text-heading-xlarge',
      'h1[class*="heading"]',
      'main h1',
    ]),
  );

  const headline = text(
    firstEl([
      '.text-body-medium.break-words',
      '[data-generated-suggestion-target] ~ .text-body-medium',
      'main .pv-text-details__left-panel .text-body-medium',
    ]),
  );

  const about = text(
    firstEl([
      'section[data-section="summary"] .display-flex.full-width .inline-show-more-text',
      '#about ~ * .display-flex .inline-show-more-text',
      'section.summary .pv-shared-text-with-see-more',
    ]),
  );

  const photoImg = firstEl([
    '.pv-top-card-profile-picture__image',
    'img.pv-top-card-profile-picture__image',
    'button.pv-top-card-profile-picture__container img',
    'main img.profile-photo',
  ]);
  const photoUrl = photoImg?.src || '';
  const hasPhoto = !!photoUrl && !/ghost/i.test(photoUrl);

  // Connection / follower text like "1,234 connections" or "5K followers"
  const bodyText = document.body.innerText || '';
  const connMatch = bodyText.match(/([\d,.]+\s*[KkMm]?\+?)\s*connections?/);
  const follMatch = bodyText.match(/([\d,.]+\s*[KkMm]?\+?)\s*followers?/);

  // Experience entries in the main column
  let experienceCount = null;
  const expSection = firstEl(['#experience', 'section[data-section="experience"]']);
  if (expSection) {
    const items = expSection.querySelectorAll('li.artdeco-list__item, li.pvs-list__item--line-separated');
    experienceCount = items.length || null;
  }

  const profileUrl = location.href.split('?')[0].replace(/\/$/, '') + '/';

  return {
    name,
    headline,
    about,
    photoUrl,
    hasPhoto,
    connectionsText: connMatch ? connMatch[1].trim() : null,
    followersText: follMatch ? follMatch[1].trim() : null,
    experienceCount,
    profileUrl,
  };
}

// Voyager API: gives structured connections count & follower count in most
// logged-in sessions. Best-effort; failures fall back to DOM values.
async function fetchVoyager() {
  try {
    const urnMatch = document.body.innerHTML.match(/urn:li:fsd_profile:[A-Za-z0-9_-]+/);
    if (!urnMatch) return null;
    const profileId = urnMatch[0].split(':').pop();
    const res = await fetch(
      `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${profileId}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`,
      {
        credentials: 'include',
        headers: {
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': getCsrf(),
          'x-restli-protocol-version': '2.0.0',
        },
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const elements = data?.included || [];
    const profile = elements.find((e) => e.$type?.includes('Profile')) || {};
    return {
      connections: profile.connectionCount ?? null,
      followers: profile.followerCount ?? null,
      endorsements: null,
    };
  } catch {
    return null;
  }
}

function getCsrf() {
  const m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
  return m ? m[1] : '';
}

async function extract() {
  const dom = scrapeDom();
  const voyager = await fetchVoyager();

  const parseCount = (s) => {
    if (!s) return null;
    const num = parseFloat(s.replace(/,/g, ''));
    if (isNaN(num)) return null;
    if (/k/i.test(s)) return Math.round(num * 1000);
    if (/m/i.test(s)) return Math.round(num * 1_000_000);
    return Math.round(num);
  };

  return {
    url: dom.profileUrl,
    profile: {
      name: dom.name,
      headline: dom.headline,
      about: dom.about,
      photoUrl: dom.photoUrl,
      hasPhoto: dom.hasPhoto,
      connections: voyager?.connections ?? parseCount(dom.connectionsText),
      followers: voyager?.followers ?? parseCount(dom.followersText),
      experienceCount: dom.experienceCount,
      endorsements: voyager?.endorsements ?? null,
    },
    source: { voyager: !!voyager },
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'FLR_EXTRACT') {
    extract().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
    return true; // async
  }
  return false;
});
