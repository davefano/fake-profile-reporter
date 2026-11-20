# Fake LinkedIn Reporter agent index

An open-source (MIT), crowd-sourced tool for spotting suspicious LinkedIn
profiles, company pages and job postings: a WXT browser extension, a Hono API
on Cloudflare Workers (D1, KV, R2), and a shared TypeScript core. Scores
suggest suspicion; they never declare that someone is fake.

`bun run check` (typecheck + tests) is the gate: run it before reporting work done.

## Guards that always apply

- **Git.** Commit freely. Branch, merge or push only on the user's instruction
  this session; a plan or todo is never instruction. Merge commits, never squash.
- **Deploys.** Every deploy (`wrangler deploy`, an extension store upload) needs
  its own explicit request.
- **Production data is off limits.** No reads or writes to remote D1, R2 or KV
  without an explicit grant this session. `--local` is fine.
- **Bun only.** Never node, npm, npx, pnpm, yarn or tsx (`bunx` is fine). On
  this machine bun isn't on PATH: use `mise exec bun@1.4.4 -- bun …`.
- **Processes.** Start dev servers (`wrangler dev`, `wxt`, preview servers) only
  when asked, and stop the ones you start.
- **Tailnet links.** Share only `https://<machine>.<tailnet>.ts.net[:port]`
  links through `tailscale serve`, never `http://` on ts.net. On this machine,
  `tailscale serve` needs `sudo tailscale set --operator=$USER` once, run by
  the user.
- **No feature flags** unless the user asks for one for this work.
- **Clean up your mess.** Delete what your change replaces.

## Guards for this project

- **LinkedIn is read-only research.** No clicks that change anything: no
  messages, posts, connection requests or follows. One profile at a time, at a
  human pace; every read is done as the signed-in user, and opening a profile
  records a view.
- **Never move a LinkedIn session between browsers.** Copying cookies into
  another browser got the session revoked everywhere. Never print or store
  cookie or CSRF values outside the browser profile.
- **No real people's data in the repo.** Fixtures are synthetic
  (`packages/core/test/fixtures.ts`). Real captures stay in the gitignored
  `.data/` and `.wrangler/`. A public figure's public ID in docs is fine.
- **The user's personal details** (email, account names) stay out of commits,
  docs and requests to outside services.
- **Suspicion, not verdicts.** Copy never says someone is fake. A report that
  someone *impersonated* a profile must not count against the real owner.
  Missing evidence is listed as "not checked", never scored as suspicion.
- **Layers.** `packages/core/src/linkedin` (fetch and parse) never imports
  `packages/core/src/scam` (scoring); `packages/core/test/layers.test.ts`
  enforces it. In the extension, `lib/linkedin/` stays feature-free.

## Open the page that owns the task

- How the code is organized, and the reusable LinkedIn layer: [docs/architecture.md](docs/architecture.md)
- LinkedIn endpoints, payloads and quirks: [docs/linkedin-data-sources.md](docs/linkedin-data-sources.md)
- Setup, dev commands, API routes, deploy steps: [README.md](README.md)
- Extension: `apps/extension` (WXT). Build with `bun run build:ext` and load
  `apps/extension/.output/chrome-mv3` unpacked; Chrome 158+ won't load
  extensions under automation, so `bun run dev:ext` can't drive Chrome.
- API, schema, local database: `apps/worker` (`schema.sql`, `bun run db:init:local`)
- Research CLI: `tools/capture` (`bun run capture <profile|company|job>`, add
  `--signed-in` for the signed-in extras)
- Logged-in research browser: agent-browser session `linkedin`; see
  [docs/research-browser.md](docs/research-browser.md)
- Subagents and `/council`: [docs/agent-models.md](docs/agent-models.md) (§ Council)
- An agent mistake: one line in [docs/agent-garden.md](docs/agent-garden.md); a repeat becomes a check
