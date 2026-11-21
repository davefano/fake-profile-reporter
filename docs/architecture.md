# Architecture

Two layers, kept apart so the LinkedIn code can serve other features (for
example, helping people improve their own profile) without the scam logic.

```
packages/core/src/
  linkedin/     data layer: fetch, parse, describe. Never judges anything.
  scam/         scoring: facts in, explained signals out. Never fetches.
  wire.ts       API request/response types shared by the extension and the worker

apps/extension/lib/
  runtime.ts    typed messaging between extension contexts
  linkedin/     the extension's LinkedIn bridge (feature-free)
  scan/         the scam-check feature: scan, score, history, submit, its messages
  panel/        the scam-check UI
```

`packages/core/test/layers.test.ts` fails if `src/linkedin` imports anything
outside itself, or if `src/scam` imports anything but its own files and the
LinkedIn facts types.
`apps/extension/test/layers.test.ts` fails if `lib/linkedin` imports anything
but the LinkedIn layer and the runtime.

## The LinkedIn data layer (`@flr/core/linkedin`)

| Module | What it gives you |
|---|---|
| `session.ts` | `createSession({ fetch, base, csrf })`: `voyager()`, `rsc()`, `html()` signed in; `publicHtml()` logged out. Every request goes through it. |
| `endpoints.ts` | Every URL and query ID, in one place, because LinkedIn changes them. |
| `target.ts` | `linkedInTarget(url)`: profile, company, or job. |
| `profile/` | `captureProfile()` → raw snapshot; `extractProfileFacts()` → `ProfileFacts`. |
| `company/` | `fetchCompany()` (public page), `fetchCompanyExtras()` (signed in), `getCompany()` (both, with errors). |
| `job/` | `fetchJob()`, `fetchJobExtras()`, `getJob()` (posting + its company, with errors). |
| `diff.ts` | What changed between two observations. |
| `ids.ts`, `join-estimate.ts` | Member IDs from profile IDs; account age from member IDs; post times from post IDs. |

Signed-in calls must run in a `www.linkedin.com` page context (the content
script, or the page itself). Public calls run anywhere; pass
`{ base: 'https://www.linkedin.com' }` outside a LinkedIn page.

`getCompany()` and `getJob()` are the one place that combines public pages,
signed-in extras, and the job's company. Their `signedIn` option is `true` to
use the reader's own session, or your own functions when the signed-in session
is somewhere else: the extension passes calls to the LinkedIn tab, the CLI
passes calls into the research browser. Optional parts that fail are recorded
in `errors`; the facts that did load are kept.

## The scam layer (`@flr/core/scam`)

`scoreProfile(facts)`, `scoreCompany(facts)`, `scoreJob(job, company, companyScore)`
return a `Score`: signals with a kind (`discrepancy`, `weak`, `trust`), a 0–100
total, a level, and what couldn't be checked.

## In the extension

The content script only serves the LinkedIn bridge (`lib/linkedin/serve.ts`).
Any other context reads LinkedIn through `lib/linkedin/client.ts`:

```ts
const tab = await activeLinkedInTab();
const profile = await linkedin.profile('some-slug', { tab });       // facts; add includeSnapshot for the raw payloads
const { facts } = await linkedin.company('example-co', { tab });     // with extras when signed in
const { job, company } = await linkedin.job('4400000000', { tab });
```

A new feature adds its own folder next to `lib/scan/`, with its own message
map served through `lib/runtime.ts`, and uses the same client.
