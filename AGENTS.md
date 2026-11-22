# Fake Profile Reporter agent index

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
- After a solved, verified problem, offer once to invoke the `ce-compound` skill at the completion checkpoint only when the work produced durable project reasoning that is not readily recoverable from the final code, tests, types, comments, or existing documentation, and losing it would plausibly cause recurrence, material risk, or substantial rediscovery. Apply this counterfactual: if the learning document disappeared, would a future engineer reading the final implementation still be likely to repeat the mistake or redo substantial investigation? If not, do not offer. Completion, effort, and diff size alone are not enough. Offer at the checkpoint so a qualifying learning can ship in the PR that produced it, and only where the repository treats captured learnings as tracked, committed knowledge.
- Write every report, summary, or handoff to the user through the `ce-noslop` skill. This applies when you are the top-level agent writing to the user, not when you are a subagent reporting to its caller. Do not apply it to code, config, verbatim quotes, or text the user asked to post as written.

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
- Subagents, Codex, `/council`: [docs/dev/agent-models.md](docs/dev/agent-models.md) (§ Council); its § pstack roles table overrides the machine pstack config
- Solved problems: `docs/solutions/` (documented fixes and patterns, by category, with YAML frontmatter: module, tags, problem_type); relevant when working in a documented area
- An agent mistake: one line in [docs/agent-garden.md](docs/agent-garden.md); a repeat becomes a check
