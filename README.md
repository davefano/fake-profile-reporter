# Fake LinkedIn Reporter

A crowd-sourced "is this LinkedIn profile fake?" tool. Open source (MIT).

- **Browser extension** (Chrome, Firefox, Safari via [WXT](https://wxt.dev)) —
  grades the LinkedIn profile you're viewing with rule-based signals and lets
  you save or report it, in your browser or to a server.
- **API** ([Hono](https://hono.dev) on Cloudflare Workers + D1/SQLite) —
  stores reports for the extension. It has no public web page.

## Project layout

```
packages/core/         shared by everything (TypeScript, no runtime deps); see docs/architecture.md
  src/linkedin/        data layer: fetch + parse profiles, companies, jobs (no scoring)
    session.ts         every request: signed in (voyager/RSC/page) or logged out
    endpoints.ts       every URL and query ID
    profile/           capture.ts (raw payloads) → facts.ts (ProfileFacts)
    company/           facts.ts (public page), extras.ts (signed in), get.ts (both)
    job/               facts.ts (public posting), extras.ts (signed in), get.ts (with its company)
    diff.ts            what changed between two observations
  src/scam/            scoring: profile.ts, company.ts, job.ts on top of signals.ts
  src/wire.ts          API request/response types shared by the extension and the worker
tools/capture/         research CLI: profiles (via agent-browser), companies and jobs (public pages)
apps/worker/           the API (Hono on Cloudflare Workers)
  src/accounts.ts      profile snapshots, reports, accounts, leaderboard
  src/entities.ts      company pages and job postings
  src/limits.ts        per-reporter rate limits (salted IP hash)
  schema.sql           database schema
  test/                API tests (real schema on bun:sqlite)
apps/extension/        the browser extension (WXT)
  entrypoints/content.ts      serves the LinkedIn bridge in the user's LinkedIn tab
  entrypoints/background.ts   toolbar toggle + routing for the scam check
  entrypoints/sidepanel/      Chrome side panel / Firefox sidebar
  entrypoints/popup/          Safari popup (Safari has no sidebar API)
  lib/linkedin/               reusable LinkedIn bridge and client (no feature logic)
  lib/scan/                   the scam check: scan, history, submit, its messages
  lib/saves/                  where saves go: settings, the in-browser store, uploads
  lib/panel/                  the UI, shared by side panel and popup
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
bun run build:ext         # then load apps/extension/.output/chrome-mv3 unpacked; Chrome 158+ won't
                          # load extensions under automation, so dev:ext can't drive Chrome
bun run dev:ext:firefox   # Firefox with the extension loaded, hot reload
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

**Where saves go** is a setting in the panel (gear icon › Save to):

- **Just me** (default): saves stay in the browser's extension storage. Nothing is sent.
- **Community**: saves also go to the shared database. Its address is
  `COMMUNITY_URL` in `apps/extension/lib/config.ts`; the option shows as not set
  up while that is null.
- **My own server**: any copy of the worker, e.g. `bun run dev:api` on a
  machine you can reach. The extension asks for permission to reach it.

Track and Report always keep a copy in the browser. Settings › Your saves
exports them as one JSON file and imports such a file back, and offers once per
server to upload saves made before it was connected.

## API

| Method | Path                | Purpose                                    |
|--------|---------------------|--------------------------------------------|
| POST   | `/api/snapshots[?report=1]` | Store a raw profile snapshot (JSON or gzip) → R2 + D1; returns the score and changes. With `report=1`, also reports the account |
| GET    | `/api/accounts/:memberId` | Latest facts, slug history, snapshot history, report count |
| GET    | `/api/accounts?slug=` | Same, by any slug the account has used   |
| GET    | `/api/leaderboard`  | Reported accounts, by reports then score, `?limit=100` |
| POST   | `/api/entities`     | Save a company or job `{ kind, id, facts, company?, report }`; the score is recomputed server-side |
| GET    | `/api/entities/:kind/:id` | Latest facts, score, observation and report counts |
| GET    | `/api/health`       | Health check                               |

Request and response types are in `packages/core/src/wire.ts`.

Accounts are keyed by LinkedIn's **member ID**, which never changes, rather
than by slug, which users can change. Every snapshot's raw payload is kept in
R2, so parsers and scoring can be re-run over history. The server re-parses and
re-scores every snapshot itself, and drops viewer-relative data (mutual
connections) before storing it. An older snapshot uploaded late is stored but
never overwrites newer facts.

Each reporter may save an account once per 10 minutes, report it once per day,
and make 200 saves or reports per day. IPs are never stored raw, only
`sha256(salt + ip)`.

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

## How scoring works

`packages/core/src/scam/` is a deterministic rules engine (no LLM, no API keys).
Each scorer turns facts into explained signals of three kinds: **doesn't add
up** (claims that contradict each other, such as a 17-year career on a
four-month-old account), **weak** (thin or new footprint), and **in their
favor** (verification, age, an established network). Missing evidence is listed
as "not checked" and never adds suspicion.

Score 0–100 → **low** (<30) / **medium** (30–59) / **high** (≥60). A strong
contradiction keeps the level at least medium. It is a suspicion score, not a
verdict: a genuine profile can still be used by an impersonator.

The data comes from LinkedIn's own internal endpoints (see
`docs/linkedin-data-sources.md`), read through the user's session in their
LinkedIn tab, and from LinkedIn's public company and job pages. These endpoints
are unofficial and change; all of them are in `packages/core/src/linkedin/endpoints.ts`.

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
