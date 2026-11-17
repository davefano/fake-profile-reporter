# Fake LinkedIn Reporter

A crowd-sourced "is this LinkedIn profile fake?" tool. It has three parts:

1. **Chrome extension** — a side panel that grades the LinkedIn profile you're
   viewing (rule-based fake signals) and lets you report it.
2. **Cloudflare Worker** — the API + a server-rendered leaderboard page. One
   Worker serves everything (API + web page).
3. **Local dev server** — runs the exact same Worker code in plain Node, so you
   can build and test without installing Wrangler or deploying anything.

There are **zero runtime dependencies**. The Worker is a standard ES module and
the extension is plain HTML/CSS/JS (Manifest V3).

---

## Project layout

```
shared/                grader + URL normalizer (shared by worker & extension)
  grader.js            rule-based fake-score (0-100) + reasons
  url.js               canonicalizes LinkedIn profile URLs
src/
  worker.js            Worker entry: routes, report/leaderboard/profile APIs
  store-d1.js          D1 storage adapter
  ip.js                anonymous salted IP hashing
public/
  leaderboard-template.js   server-rendered leaderboard HTML
extension/
  manifest.json        MV3 manifest (side panel, content script, service worker)
  content.js           scrapes profile DOM (+ best-effort voyager fetch)
  background.js        orchestrates extraction, proxies API calls
  sidepanel.html/.css/.js   the UI
  grader.js, url.js    copies of shared modules (no bundler)
  config.js            API base URL
scripts/
  dev-server.mjs       local runner (Node http + JSON-file D1 shim)
schema.sql             D1 schema
wrangler.toml          Cloudflare deploy config
```

---

## Run locally

**1. Start the backend (no install needed):**

```bash
node scripts/dev-server.mjs
# or: npm run dev
```

- Leaderboard: http://localhost:8787/
- API health:  http://localhost:8787/api/health

It stores data in `.data/dev-db.json`. Delete that file to reset.

**2. Load the extension:**

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Visit any `https://www.linkedin.com/in/...` profile
5. Click the toolbar icon to open the side panel

The side panel shows the live grade. Click **Report to leaderboard**, then open
http://localhost:8787/ to see it appear.

> The extension is pre-configured to talk to `http://localhost:8787`
> (`extension/config.js`). Change `API_BASE` there when you deploy.

---

## API

| Method | Path                | Purpose                                    |
|--------|---------------------|--------------------------------------------|
| POST   | `/api/report`       | Submit a report `{ url, profile }`         |
| GET    | `/api/leaderboard`  | Ranked list `?limit=100`                   |
| GET    | `/api/profile?url=` | One profile + its recent reports           |
| GET    | `/api/health`       | Health check                               |

Reports are deduped per-IP per-profile with a 6h cooldown and capped at 50/day
per IP. IPs are never stored raw — only `sha256(salt + ip)`.

---

## How the grading works

`shared/grader.js` is a deterministic rules engine (no LLM, no API keys). It adds
weight for signals like:

- crypto/web3 buzzwords, "guru"/self-promo language, generic buzzphrases
- very low connection counts, no photo, zero endorsements, no/short About
- too few experience entries, brand-new accounts

Score 0–100 → **low** (<30) / **medium** (30–59) / **high** (≥60), with the
weighted reasons shown in the panel. The same function runs client-side for the
live preview and server-side to produce the authoritative stored score.

The extension extracts data from the rendered DOM and, when available, augments
it with LinkedIn's internal `voyager` API (connections/followers) using the
user's existing session cookies. If the API call fails it silently falls back to
DOM values — nothing breaks.

---

## Deploy to Cloudflare (later)

```bash
npm i -D wrangler
npx wrangler d1 create flr            # copy database_id into wrangler.toml
npx wrangler kv namespace create RATE_KV   # copy id into wrangler.toml
npm run db:init                       # apply schema.sql
npx wrangler deploy
```

Then set `API_BASE` in `extension/config.js` to your Worker URL and reload the
extension. To use Wrangler's own local emulation instead of the Node shim:
`npm run dev:wrangler` (after `npm run db:init:local`).

---

## Notes / next steps

- LinkedIn markup changes; selectors in `extension/content.js` may need updates.
- The `voyager` endpoint is unofficial and may change.
- The leaderboard ranks by **number of reports** (tie-break: avg score, recency).
- Possible follow-ups: Cloudflare Turnstile on the report form, per-report
  "still active?" confirmations, and a public share card per profile.
