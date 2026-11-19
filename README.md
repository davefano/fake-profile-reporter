# Fake LinkedIn Reporter

A crowd-sourced "is this LinkedIn profile fake?" tool. Open source (MIT).

- **Browser extension** (Chrome, Firefox, Safari via [WXT](https://wxt.dev)) —
  grades the LinkedIn profile you're viewing with rule-based signals and lets
  you report it.
- **API** ([Hono](https://hono.dev) on Cloudflare Workers + D1/SQLite) —
  stores reports and serves a public leaderboard.

## Project layout

```
packages/core/         shared by everything (TypeScript, no runtime deps); see docs/architecture.md
  src/linkedin/        data layer: fetch + parse profiles, companies, jobs (no scoring)
    session.ts         every request: signed in (voyager/RSC/page) or logged out
    endpoints.ts       every URL and query ID
    profile/           capture.ts (raw payloads) → facts.ts (ProfileFacts)
    company/           facts.ts (public page), extras.ts (signed in), get.ts
    job/               facts.ts (public posting), extras.ts (signed in), get.ts
  src/scam/            scoring: profile.ts, company.ts, job.ts, signals.ts; grader.ts (v0)
  src/types.ts         wire types shared by the extension and API
tools/capture/         research CLI: capture + score profiles (via agent-browser), companies and jobs (public pages)
apps/worker/           the API (Hono on Cloudflare Workers)
  src/index.ts         routes: report / leaderboard / profile / health
  src/store.ts         D1 (SQLite) storage
  src/leaderboard-page.ts   server-rendered leaderboard page
  schema.sql           database schema
  test/                API tests (real schema on bun:sqlite)
apps/extension/        the browser extension (WXT)
  entrypoints/content.ts      scrapes the profile DOM (+ best-effort voyager API)
  entrypoints/background.ts   orchestrates extraction, proxies API calls
  entrypoints/sidepanel/      Chrome side panel / Firefox sidebar
  entrypoints/popup/          Safari popup (Safari has no sidebar API)
  lib/panel/                  the UI, shared by side panel and popup
  lib/messages.ts             typed messaging between extension parts
```

## Setup

Requires [Bun](https://bun.sh) 1.4+.

```bash
bun install
bun run db:init:local     # create the local D1 database (once)
```

## Develop

```bash
bun run dev:api           # API + leaderboard at http://localhost:8787
bun run dev:ext           # opens Chrome with the extension loaded, hot reload
bun run dev:ext:firefox   # same, in Firefox
```

Visit any `https://www.linkedin.com/in/...` profile and click the toolbar icon.

```bash
bun test                  # core + API tests
bun run typecheck         # all workspaces
bun run build:ext         # production builds for chrome, firefox, safari
```

Builds land in `apps/extension/.output/`. To load one manually, use
`chrome://extensions` → Load unpacked → `.output/chrome-mv3`, or
`about:debugging` in Firefox → Load Temporary Add-on → `.output/firefox-mv2/manifest.json`.

**Safari** needs a Mac with Xcode: build with `bun run --cwd apps/extension build:safari`,
then wrap it with `xcrun safari-web-extension-converter apps/extension/.output/safari-mv2`.

**Pointing the extension at another server:** the API URL is set at build time.

```bash
WXT_API_BASE=https://your-worker.workers.dev bun run build:ext
```

## API

| Method | Path                | Purpose                                    |
|--------|---------------------|--------------------------------------------|
| POST   | `/api/report`       | Submit a report `{ url, profile }`         |
| GET    | `/api/leaderboard`  | Ranked list `?limit=100`                   |
| GET    | `/api/profile?url=` | One profile + its recent reports           |
| GET    | `/api/health`       | Health check                               |
| POST   | `/api/snapshots`    | Store a raw profile snapshot (JSON or gzip) → R2 + D1, returns score and changes |
| GET    | `/api/accounts/:memberId` | Latest facts, slug history, snapshot history |
| GET    | `/api/accounts?slug=` | Same, by any slug the account has used   |
| POST   | `/api/entities`     | Save a company or job `{ kind, id, url, facts, company?, report }`; the score is recomputed server-side |
| GET    | `/api/entities/:kind/:id` | Latest facts, score, observation and report counts |

Accounts are keyed by LinkedIn's **member ID**, which never changes, rather
than by slug, which users can change. Every snapshot's raw payload is kept in
R2, so parsers and scoring can be re-run over history.

Reports are deduped per-IP per-profile with a 6h cooldown and capped at 50/day
per IP. IPs are never stored raw — only `sha256(salt + ip)`.

## Capturing and scoring profiles, companies, and jobs (research)

`tools/capture` captures a profile the same way the extension does, through a
logged-in [agent-browser](https://github.com/vercel-labs/agent-browser) session.
Company pages and job postings come from LinkedIn's public pages and need no
browser or login:

```bash
bun run capture some-slug https://www.linkedin.com/in/another/ [--no-activity] [--post http://localhost:8787]
bun run capture https://www.linkedin.com/company/example/ https://www.linkedin.com/jobs/view/4400000000/ 4400000001
```

It saves raw snapshots to `.data/snapshots/<memberId>/` (gitignored). For each
profile it prints the facts, the score with every signal, and any changes since
the last capture. This uses your own LinkedIn account, so keep it to a handful
of profiles. See `docs/linkedin-data-sources.md` for what each request returns.

## How grading works

`packages/core/src/grader.ts` is a deterministic rules engine (no LLM, no API
keys). It adds weight for signals like crypto/web3 buzzwords, "guru" language,
generic buzzphrases, very low connection counts, no photo, zero endorsements,
no/short About, few experience entries, and new accounts.

Score 0–100 → **low** (<30) / **medium** (30–59) / **high** (≥60). The same
function runs in the extension for the live preview and in the API at report
time.

The extension reads the rendered DOM and, when available, LinkedIn's internal
`voyager` API (connections/followers) using the user's existing session. If that
fails it falls back to DOM values. LinkedIn markup and the voyager endpoint are
unofficial and change; selectors in `entrypoints/content.ts` may need updates.

## Deploy the API to Cloudflare

```bash
cd apps/worker
bunx wrangler d1 create flr                 # copy database_id into wrangler.toml
bunx wrangler kv namespace create RATE_KV   # copy id into wrangler.toml
bunx wrangler r2 bucket create flr-snapshots
bunx wrangler secret put IP_SALT            # any long random string
bun run db:init
bun run deploy
```

## License

[MIT](LICENSE)
