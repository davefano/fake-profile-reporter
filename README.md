# Fake Profile Reporter

A crowd-sourced "is this LinkedIn profile fake?" tool. Open source (MIT).

- **Browser extension** (Chrome, Firefox, Safari via [WXT](https://wxt.dev)) —
  grades the LinkedIn profile you're viewing with rule-based signals and lets
  you save it, report it, or vouch for it, in your browser or to a server.
- **API** ([Hono](https://hono.dev) on Cloudflare Workers + D1/SQLite) —
  stores reports for the extension. Its only web page is `/verify`, the bot
  check the extension shows before a first report.

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
  src/accounts.ts      profile snapshots, accounts, leaderboard
  src/reports.ts       reports and vouches: create, edit, withdraw
  src/verify.ts        bot check: the /verify page and POST /api/verify
  src/removals.ts      removal requests and the maintainer's admin routes
  src/entities.ts      company pages and job postings
  src/limits.ts        rate limits: KV cooldowns, atomic daily caps in D1
  schema.sql           full database schema (fresh database)
  migrations/          changes for the live database; migrations/later/ waits for old builds to age out
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
bun run dev:api           # API at http://localhost:8787
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

Save and Report always keep a copy in the browser. Settings › Your saves
exports them as one JSON file and imports such a file back, and offers once per
server to upload saves made before it was connected.

**Reports.** "Report…" says one of three things about a page ("Vouch that
they're real" opens the same form at the third):
- **Looks suspicious**, with reasons and "I suspect it" or "I confirmed it".
- **Someone used this person's identity** (profiles only). It's shown as a
  warning and never counts against the profile's owner.
- **I know this is real**: a vouch.

Each also takes an optional note, which the server stores for building
heuristics and never shows to anyone. You can edit or withdraw what you said.
The extension makes a random master key on first use and sends each server a
different key derived from it, so one server can't act as you on another; the
server stores only a hash, so only that browser can change its reports.
Withdrawals and edits reach every server that holds the report, including ones
no longer selected. The export file carries the master key, so treat it like a
password.

**Bot check.** Before a browser's first report (or removal request) on a
server, the panel shows Cloudflare Turnstile in a small frame from that
server's `/verify` page; Safari opens it in a tab. It lasts 90 days for that
browser on that server. Withdrawals never need it, and a server without
`VERIFY_HOST` set doesn't ask.

**Removal requests.** On a profile, "This is my profile" lets its owner ask
for it to be removed: the panel gives a code to put in the headline or About,
checks it's there, and sends the request. Nothing changes until the maintainer
reviews it. Approval deletes the profile's data on the server and refuses
future saves and reports of it; reversing an approval lifts the block, but
deleted data stays deleted.

## API

| Method | Path                | Purpose                                    |
|--------|---------------------|--------------------------------------------|
| POST   | `/api/snapshots` | Store a raw profile snapshot (JSON or gzip) → R2 + D1; returns the score and changes |
| GET    | `/api/accounts/:memberId` | Latest facts, slug history, snapshot history, report counts |
| GET    | `/api/accounts?slug=` | Same, by any slug the account has used   |
| GET    | `/api/leaderboard`  | Profiles reported as suspicious, by reports then score, `?limit=100` |
| POST   | `/api/entities`     | Save a company or job `{ kind, id, facts, company? }`; the score is recomputed server-side |
| GET    | `/api/entities/:kind/:id` | Latest facts, score, observation and report counts |
| PUT    | `/api/reports/:kind/:id` | Report, flag impersonation, or vouch: `{ stance, reasons, confidence?, note? }` with header `x-reporter-key`. One per reporter per saved target (`kind` is `profile`, `company` or `job`; a profile's `id` is its member ID); sending again edits it |
| DELETE | `/api/reports/:kind/:id` | Withdraw this reporter's report |
| GET    | `/verify` | The bot-check page (only when `VERIFY_HOST` is set); framed by the extension, or `mode=tab` for Safari |
| POST   | `/api/verify` | `{ token, challenge }` from the bot check; marks the reporter verified for 90 days |
| GET    | `/api/verify/status` | Whether this reporter key is verified (header `x-reporter-key`) |
| POST   | `/api/removals` | Ask for a profile's removal: `{ memberId, code, contact? }` with header `x-reporter-key` |
| GET    | `/api/admin/removals` | Pending removal requests, grouped by profile (header `Authorization: Bearer <ADMIN_TOKEN>`) |
| POST   | `/api/admin/removals/:id/approve` | Approve: `{ memberId }`, typed back to confirm |
| POST   | `/api/admin/removals/:id/deny` | Deny: `{ reason: "code" \| "merits" }` |
| POST   | `/api/admin/removed/:memberId/restore` | Reverse an approval: lifts the block |
| GET    | `/api/health`       | Health check                               |

Old builds that send `?report=1` or `report: true` get `410 upgrade_required`;
saves and reports of a removed profile get `410 removed`.

Request and response types are in `packages/core/src/wire.ts`.

Accounts are keyed by LinkedIn's **member ID**, which never changes, rather
than by slug, which users can change. Every snapshot's raw payload is kept in
R2, so parsers and scoring can be re-run over history. The server re-parses and
re-scores every snapshot itself, and drops viewer-relative data (mutual
connections) before storing it. An older snapshot uploaded late is stored but
never overwrites newer facts.

Each IP may save an account, company or job once per 10 minutes and make 200
saves a day. Reports are capped at 50 a day per reporter and 200 per IP; bot
checks at 20 a day per IP; removal requests at 3 a day per reporter and 5 per
IP, with at most 100 pending overall. The report, bot-check and removal caps
are counted atomically in D1, so parallel requests can't overrun them;
withdrawals don't count. IPs and reporter keys are never stored raw, only
salted SHA-256 hashes.

**Privacy.** Report notes are stored and never returned by any route. The bot
check sends the Turnstile token and the visitor's IP to Cloudflare. A removal
request's optional contact is cleared when the request is decided, or after 90
days if it isn't; decided requests are deleted after 90 days. A daily cron runs
that clean-up. Deleted rows stay restorable through D1 Time Travel for about 30
days.

Schema changes for a database that's already live are in
`apps/worker/migrations/`, applied once each with
`wrangler d1 execute fpr --remote --file=./migrations/<file>`. Files there only
add tables and are safe to re-run. `migrations/later/` holds drops that must
wait until old extension builds are no longer in use; never run
`wrangler d1 migrations apply` or `db:init` against the live database.
`schema.sql` is always the full current schema for a fresh database.

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

Score 0–100 → **low** (<30) / **medium** (30–59) / **high** (≥60). Some
signals also set a floor on the level: a strong contradiction keeps it at least
medium, and four or more signs that an old account changed hands (a recently
changed photo, banner or contact info, an industry left over from another
career, a never-customized URL on an unused account, a surname cut to an
initial) keep it at least high, or at least medium when LinkedIn has verified
the person's identity. So a profile can read High with a number in the 30s; the
panel's "Show the score" says when a floor raised the level. Each signal is
marked major or minor. It is a suspicion score, not a verdict: a genuine
profile can still be used by an impersonator.

The data comes from LinkedIn's own internal endpoints (see
`docs/linkedin-data-sources.md`), read through the user's session in their
LinkedIn tab, and from LinkedIn's public company and job pages. These endpoints
are unofficial and change; all of them are in `packages/core/src/linkedin/endpoints.ts`.

## Deploy the API to Cloudflare

```bash
cd apps/worker
bunx wrangler d1 create fpr                 # copy database_id into wrangler.toml
bunx wrangler kv namespace create RATE_KV   # copy id into wrangler.toml
bunx wrangler r2 bucket create fpr-snapshots
bunx wrangler secret put IP_SALT            # any long random string
bunx wrangler secret put ADMIN_TOKEN        # 32+ random bytes, base64url; enables the admin routes
bunx wrangler secret put TURNSTILE_SITEKEY  # from a Turnstile widget for the worker's hostname
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler secret put VERIFY_HOST        # the worker's hostname; turns the bot check on
bun run db:init
bun run deploy
```

`wrangler.toml` holds the IDs for the project's own deployment; a fork replaces
them with its own. Wrangler reads `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` from the environment (keep them in the gitignored
`.env`). For `bun run dev:api`, copy `apps/worker/.dev.vars.example` to
`.dev.vars`.

## License

[MIT](LICENSE). The bundled Geist font is under the SIL Open Font License
(`apps/extension/lib/panel/fonts/OFL.txt`, shipped in the extension as
`OFL-Geist.txt`).
