# Choosing models for subagents and workflows

Scope: dev-time agent work — subagents, workflows, and Codex delegation. The  
product's runtime models (`OPENROUTER_MODEL`, report/enrichment synthesis) are  
pinned in code and env instead (see `docs/deployment/railway.md`).

Ratings are ours, higher = better. Cost is what we actually pay (OpenAI's  
limits are generous), not list price. Intelligence is how hard a problem you  
can hand the model unsupervised. Taste covers UI/UX, code quality, API design,  
and copy. Ratings last reviewed 2026-11-09; re-rate when a new version ships.


| model                 | cost | intelligence | taste |
| --------------------- | ---- | ------------ | ----- |
| opus (Opus 5.5)       | 5    | 9            | 8     |
| sonnet (Sonnet 5.5)   | 6    | 7            | 7     |
| fable (Fable 5.2)     | 2    | 10           | 9     |
| gpt-6-astra (Codex)   | 1    | 10           | 7     |
| gpt-6.1-sol (Codex)   | 9    | 9            | 6     |
| gpt-6.1-terra (Codex) | 10   | 7            | 6     |


- These are defaults, not limits. If a cheaper model's output misses the bar,  
escalate without asking, in this order: give it a check it can run (a test,  
build, or script), raise effort one level, then move to a stronger model.  
Escalating costs less than shipping mediocre work.
- For anything that ships, intelligence &gt; taste &gt; cost. Cost only breaks ties.
- Default: opus at medium effort, for anything the rules below don't cover.
- Bug fixing and investigation (reproducing, tracing, root-causing, and the  
fix): sonnet. Escalate to opus, then fable, when it stalls or the cause  
spans several subsystems.
- Hard or high-stakes work (architecture, security, anything opus stalled  
on): fable.
- Bulk, clear-spec work (implementation from a spec, data analysis,  
migrations): Sol through Codex — `gpt-6.1-sol`, or `gpt-6-sol` where your  
Codex doesn't offer 6.1 yet (`codex debug models` lists what it offers).
- User-facing work (UI, copy, API design): a model with taste ≥ 7.
- Plan reviews: fable first, or opus, with a Codex model as an optional  
second, independent perspective.
- Code reviews: `gpt-6.1-terra` at high for a fast first pass, `gpt-6.1-sol`  
at high when findings need reproducing, or `/council` (§ Council) for all  
three seats.
- Read-only search and exploration subagents (Explore included): pass  
`model: "sonnet"`. Without it they inherit the session model, Fable  
included.
- gpt-6-astra is a last resort, not a default: use it when fable has stalled,  
or when a high-stakes review (auth, migrations, data loss) earns a second  
opinion from another model family. Call it with  
`/codex:rescue --model gpt-6-astra`.
- Don't use Haiku.

Claude models run through the Agent/Workflow `model` parameter, which takes  
the tier alias (`sonnet`, `opus`, `fable`) and resolves it to the newest  
version Claude Code ships. Don't pass versioned names. Opus 5.5 already runs  
at medium effort by default; don't raise it without a reason.

Codex models run through the `openai/codex-plugin-cc` plugin, which inherits  
`~/.codex/config.toml`; `/codex:rescue` takes `--model`, the review commands  
use your Codex default. Delegate through the plugin, not hand-rolled shell  
wrappers — this applies to subagents and workflows too:

- `/codex:review` — read-only code review; `--base <ref>` for a branch.
- `/codex:adversarial-review` — skeptical design review of tradeoffs, auth,  
and reliability; append focus text to steer it.
- `/codex:rescue` — hand Codex debugging, a multi-file refactor, or an  
implementation loop that needs a second pass.
- `/codex:status` / `/codex:result` / `/codex:cancel` — manage `--background`  
jobs.
- The review gate (`/codex:setup --enable-review-gate`) stays on: a stop hook  
that has Codex challenge Claude's output before it reaches the main session.
- `ce-work` delegates implementation to Codex when  
`.compound-engineering/config.local.yaml` sets `work_delegate: codex` and  
`work_delegate_consent: true`. That file is gitignored, so re-set both keys  
on a fresh checkout.

## Council

We use `/council` for code review. Seat these three members, all read-only;  
naming them overrides the skill's one-model-per-provider default.


| seat                    | how to run it                                                            |
| ----------------------- | ------------------------------------------------------------------------ |
| Claude Opus 5.5, medium | `Agent` with `model: "opus"`, `effort: "medium"`                         |
| GPT-6.1 Sol, high       | `codex:codex-rescue` with `--model gpt-6.1-sol --effort high`, read-only |
| Gemini 4 Neon, high     | `agy -p "<brief>" --model gemini-4-neon-high`, read-only (see below)     |


The third seat is Gemini 4 Neon when the Antigravity CLI (`agy`) is  
authenticated on the machine, and GPT-6.1 Terra when it is not: check with  
`agy models`, which lists `gemini-4-neon-high` only when signed in. The  
fallback is `codex:codex-rescue` with `--model gpt-6.1-terra --effort high`,  
read-only. Decided 2026-11-12 (David).

Run `agy` headless from the repo root, with `--add-dir` for any directory  
outside it that the brief points at, and make it read-only with `--settings`:

```bash
--settings '{"permissions":{"allow":["command(grep *)","command(rg *)","command(jq *)","command(cat *)","command(head *)","command(tail *)","command(ls *)","command(wc *)"],"deny":["write_file(*)"]}}'
```

Print mode cannot prompt, so a command outside the allowlist is denied; with  
no allowlist the seat returns no review. Leave out `--mode plan`: it asks to  
confirm even allowlisted commands, so every one is denied. Without plan mode  
`agy` writes freely in a trusted workspace, which is what the `deny` rule  
stops. Keep `sed`, `find` and other commands that can write (`sed -i`,  
`find -delete`) off the allowlist, and tell the seat to run one command per  
call, without pipes. Never pass `--dangerously-skip-permissions` to a review  
seat. Checked 2026-11-12.

Pass `--effort` on the Codex seats: Codex defaults Sol and Terra to `low`.  
Ask the Codex seats for read-only work explicitly; the rescue agent writes by  
default. Where the `codex:codex-rescue` agent type is not installed, run  
`codex exec -m <model> -c model_reasoning_effort=high -s read-only`.

Why these three (bake-off on `redesign-plugin-page`, 2026-11-06, one run each):  
two Terra runs together cost half of one Sol high run, finished in 17s, and  
found issues no Sol run caught; Terra reads statically, and its medium run  
made one wrong claim. Sol high was the only run that reproduced  
the bugs and ran the checks, and every claim it made held. Opus is the Claude  
seat for judgment. Treat Terra's findings as a list to triage against Sol's  
evidence.

## pstack roles

pstack skills name a model per role and expect Cursor's `/setup-pstack` to  
set them. In this repo, use this table: it overrides the machine-level pstack  
config (`~/.claude/rules/pstack-models.md`, the pstack block in  
`~/.codex/AGENTS.md`), which stays as the default for other repos.  
This precedence is a repo instruction; setup never rewrites the machine config.  
Pass `effort: "medium"` on every pstack spawn. Running pstack  
fan-out at higher effort burned through usage limits fast (2026-10-19).


| role                                                                            | Claude Code                                               | Codex                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------- |
| feature, refactoring, bug-fix, perf-issue, hillclimb                            | opus                                                      | gpt-6.1-sol                |
| judgment and prose                                                              | opus                                                      | gpt-6.1-sol                |
| hardest tasks                                                                   | fable                                                     | gpt-6-astra                |
| how explorer, why investigators, reflect tooling, swarm workers                 | sonnet                                                    | gpt-6.1-terra              |
| how explainer, why synthesizer, reflect judgment and synthesizer                | opus                                                      | gpt-6.1-sol                |
| arena runners, arena cross-judge pool, architect runners, interrogate reviewers | opus, plus a Codex seat (`codex:codex-rescue`, read-only) | gpt-6.1-sol, gpt-6.1-terra |


A Codex seat is a reviewer, judge, or runner. It never implements code.

A PR's verifier seat depends on the door  
(`.agents/skills/teal-workflow/SKILL.md` § Review by reversibility). A  
one-way door gets one read-only verifier from the other model family, run on  
the local branch before the PR. For Claude-written code that seat is  
`codex:codex-rescue`. A two-way door gets no verifier seat. The author's proof  
and CI are its gate.