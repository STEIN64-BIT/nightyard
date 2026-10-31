# Changelog

All notable changes to sleepy are documented here. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-10-30

### Added

- `--provider opus|codex` picks one provider for planning and every worker (Opus is the default), so a Codex-only run never calls Opus and vice versa. `--team` runs Sleepy Duo.
- `sleepy review [--json] [--run <id>] [--integrate <#>]`: read what one run produced and integrate a reviewed branch; a run's report only contains changes from that run.
- Integrating no longer demands a clean working tree: unrelated unfinished work stays where it is, overlapping files (tracked, untracked or ignored) are named, staged work is never swept into the merge, and conflicts are found in a throwaway worktree before your checkout is touched. A merge you did yourself is recognised and the item marked approved.
- `sleepy review` prints a readable list by default; `--json` keeps the structured output for UIs.
- `sleepy report`: every run now ends with one readable HTML report in `.sleepy/reports/`, summary first, phone-friendly, with copyable commands to try, integrate or continue each item.
- `report.publishCommand` in `~/.config/sleepy/settings.json` or `.sleepy/settings.json` hands the report to your own script.
- Research, plan and content workers must open with a `## TL;DR` of at most five bullets; the CLI warns when one is missing.
- The report has a print stylesheet; a kind filter and a total-size budget for whole-queue reports are deferred to the cross-project bundle (`sleepy report --all`).

### Changed

- Review items expose the diff stat separately.
- Stop requests are picked up within half a second, also while the supervisor is pacing between iterations.

### Security

- `apply` and `discard` only touch branches Sleepy created itself (`sleepy/*`).
- `SLEEPY_RULES.md` deny-paths are now actually enforced for code workers in real runs (before, `start` never passed them on), with a wiring test.
- Artifact (research/plan/content/design) workers are snapshot before and after: any write outside their artifact path, or to a deny-path, rejects the iteration and is reported, never silently kept.

## [0.3.1] — 2026-04-16

Crash-resilience hotfix. v0.3.0's first real 8-hour overnight run on a real project completed 21 iterations (19 queue items across code/research/content/design) before the supervisor crashed during a design worker dispatch — the Claude child process died and the exception killed the entire loop. These three fixes prevent that from happening again.

### Fixed

- **Catch-and-continue on worker failure.** The entire worker dispatch inside `onNextAction` is now wrapped in try/catch. If a Claude child process crashes (timeout, SIGKILL, OOM, network drop), it's logged as a failed iteration and the loop continues to the next iteration instead of dying. The consecutive-failure breaker still fires after 3 in a row.
- **Clear stale `next-action.json` on startup.** `sleepy start` now deletes any leftover `next-action.json` before entering the loop. Previously, restarting after a crash would find the stale action and potentially re-process it or confuse the loop.

### Added

- **`sleepy-supervisor.sh` auto-restart wrapper.** A bash script that wraps `sleepy start` and restarts it on crash (non-zero exit). Exits cleanly on exit 0 (normal termination) or 130 (SIGINT/Ctrl-C). Exponential backoff on consecutive crashes (5s → 10s → 20s → ... → 120s cap). Max 10 consecutive restarts before giving up. Usage: `./sleepy-supervisor.sh --intensity medium --duration 8h`

## [0.3.0] — 2026-04-15

**The "actually creative" release.** Until now sleepy could only fix what exists — now it can research, design, and write too. And it has a built-in compass so it never runs out of meaningful work.

### Multi-type workers

The `dispatch-worker` next-action gains a `worker_kind` field: `code` | `research` | `design` | `content`. Each kind dispatches a different Claude session with a different skill and produces a different artifact.

- **`code`** — unchanged from v0.2.0. Isolated git worktree, branch, `SLEEPY_ARTIFACT.md`, diff-check against deny-list.
- **`research`** — new. Worker runs in the project root, uses WebSearch + WebFetch + file reads, writes one markdown report to `.sleepy/artifacts/research/<slug>.md`. Skill: `plugin/skills/sleepy-researcher/SKILL.md`.
- **`design`** — new. Worker brainstorms and specs a feature. If the `superpowers:brainstorming` skill is installed, the designer invokes it via the Skill tool for the exploratory phase. Writes a design doc to `.sleepy/artifacts/plans/<slug>.md`. Skill: `plugin/skills/sleepy-designer/SKILL.md`.
- **`content`** — new. Worker writes landing copy, launch posts, docs, social variants — whatever written content the project needs. Writes to `.sleepy/artifacts/content/<slug>.md`. Skill: `plugin/skills/sleepy-writer/SKILL.md`.

Non-code artifact workers don't create a worktree. They run in the project root with broad read access and write exactly one file. Their safety model relies on the skill's prose boundary ("you may only write to this one path") which is the same pattern we already use for the planner and navigator.

### Generative orchestrator

The `sleepy-orchestrator` skill has been rewritten to be **generative, not reactive**. Key changes:

- **Universal goals compass.** Every project sleepy works on has the same implicit goal: make it better, get more users, keep them happy, be one of a kind. These universal goals apply even when `USER_GOALS.md` is absent. `USER_GOALS.md` just narrows which axes the user cares about most right now.
- **Productive fallback ladder.** When picking this iteration's work, the orchestrator now checks in order: (1) continue a sequence (did a recent design doc land unimplemented?), (2) high-priority backlog item matching goals, (3) iterate on recently shipped work, (4) deepen a direction, (5) research that informs future work, (6) brainstorm a new feature, (7) content/marketing, (8) cross-pollinate with the last iteration's type. Only idle if *nothing* fits, which should be very rare.
- **Actively generates new backlog items.** Every iteration should leave the backlog at least as long as it found it — ideally longer. The orchestrator is explicitly told to write new items to `SLEEPY_BACKLOG.md` during work mode, not just consume them.
- **Varies work types across iterations.** If the last iteration was code, this one should be research or content or design. The goal is a diverse review queue after 8 hours, not a pile of PRs.
- **Sequences research → design → code.** The orchestrator recognizes that a design doc landing in `artifacts/plans/` is a signal: the next iteration can dispatch a code worker that reads the spec and implements it. Full idea → research → spec → implementation flow, automatically.

### What an overnight run looks like now

Given a 10-hour run on any project with just `sleepy go run overnight on my X, make it better`:

| Iter | Kind | Output |
|---|---|---|
| 1 | research | market/competitor landscape report |
| 2 | design | design spec for a new feature based on the research |
| 3 | code | implementation branch for that feature |
| 4 | code | unit tests for the new feature |
| 5 | code | docs for the new feature |
| 6 | content | landing page copy for the new feature |
| 7 | research | user feedback patterns for this category |
| 8 | design | brainstorm a second feature |
| 9 | code | polish + iterate on items 3–5 based on self-review |
| 10 | content | changelog entry + launch announcement |

You wake up to **10 items** in the review queue spanning code, research, design, and content. You review, approve what you like, discard the rest. Sleepy never ran out of ideas because the universal compass always pointed somewhere.

### Stats

- **222 tests** passing (up from 213)
- **3 new plugin skills**: `sleepy-researcher`, `sleepy-designer`, `sleepy-writer`
- **1 new module**: `cli/src/supervisor/artifact-worker.ts`
- **Orchestrator SKILL.md fully rewritten** — universal goals, ladder, generative mandate
- Zero new runtime dependencies

## [0.2.0] — 2026-04-15

**The "actually runs overnight" release.** Two features combined:

### Real loop enforcement

sleepy's core promise is "run for hours while you sleep." v0.1.x technically supported `--duration` and `--cap` flags but silently ignored them — the supervisor just ran 10 iterations and quit. v0.2.0 actually enforces them.

- **`cli/src/supervisor/budget-limits.ts`** — new pure function `enforceBudgetLimits(cfg, budget, now)` returns `'continue'` or terminates with reason `'deadline'` or `'token-cap'`.
- **`runSupervisor`** now re-reads the config on every iteration, checks budget limits before running the orchestrator, and terminates cleanly when either limit is hit. Two new termination reasons: `deadline`, `token-cap`.
- **Per-iteration sleep** now pulled from `INTENSITY_BUNDLES[currentIntensity].sleepBetweenMs` instead of hardcoded `0`. 120s for low, 60s medium, 30s high, 10s max.
- **`decidePacing()` is wired in.** After each iteration the loop computes burn rate vs cap, calls `decidePacing()`, and if it returns a new intensity level, writes the updated config to disk. The next iteration's sleep, per-iteration cap, and so on pick up the change automatically.
- **`onPacingShift(from, to, reason)`** and **`onLimitHit(reason)`** hooks on `runSupervisor` so the CLI can print a status line when intensity shifts or a limit is hit.
- **`maxIterations` defaults to `Number.MAX_SAFE_INTEGER`** when `--duration` or `--cap` is set (so the duration/cap are the real stop conditions, not iteration count).
- **14 new tests** covering budget enforcement + pacing integration.

### Natural-language planner

`sleepy go` now parses full natural-language requests, not just project names. Say what you want in English and sleepy extracts project path, duration, intensity, focus, and user goals.

```bash
sleepy go loop until tomorrow morning on my recommender, focus on the ATC modal polish
sleepy go run for 2 hours on project-a, low intensity, test coverage only
sleepy go burn 5M tokens on the project-b landing page
sleepy go my project-b project           # simple case — just find the project, default flags
```

- **New `plugin/skills/sleepy-planner/SKILL.md`** — supersedes `sleepy-navigator`. Read-only, finds the project AND parses time/intensity/focus/goals from the request. Uses the current time + user timezone passed in the prompt to resolve phrases like "tomorrow morning" and "for 8 hours".
- **`PlannerResultSchema`** — extends the navigator schema with `duration_iso`, `duration_spec`, `intensity`, `focus_hint`, `scope_hint`, `user_goals_md`, `token_cap`, `ambiguities`.
- **`buildPlannerPrompt`** injects the current ISO time and user's timezone so the planner can resolve relative times.
- **Pretty confirmation display** — sleepy shows the full resolved plan (project, duration until when, intensity, focus, scope, token cap, reasoning, any caveats) before proceeding.
- **`durationFromIso()` helper** — recomputes a clean duration spec (`14h`, `2d`) from the resolved ISO deadline, so sleepy start gets a fresh value not stale since planning.
- **`.sleepy/USER_GOALS.md`** — when the planner returns `user_goals_md`, sleepy writes it into the target project before dispatching `sleepy start`. The orchestrator's SKILL.md has a new **Step 0** that reads this file and treats it as the highest-priority signal when picking backlog items.
- **Automatic flag forwarding** — `sleepy go` now passes `--duration`, `--intensity`, and `--cap` through to `sleepy start` based on what the planner extracted. The user never writes flags directly.

### Replaced

- **`sleepy-navigator` skill** → **`sleepy-planner`**. The navigator was a strict subset of the planner; the planner handles pure project-selection requests too (returns null for all the optional fields).
- **`NavigatorResult*` APIs in `go.ts`** → `PlannerResult*`. Old exports removed.

### Stats

- **213 tests** passing (up from 196)
- **Two new modules**: `supervisor/budget-limits.ts`, `plugin/skills/sleepy-planner/SKILL.md`
- **One replaced module**: `plugin/skills/sleepy-navigator/` removed (planner supersedes it)
- Zero new runtime dependencies

## [0.1.4] — 2026-04-15

Real live activity output + interactive kill switch. Fixes the "nothing happening" experience from v0.1.3.

### Added

- **`--output-format stream-json --verbose` parsing.** v0.1.3's streaming was technically correct, but `claude -p` in text mode only writes to stdout *at the very end*. All the actual activity happened silently. v0.1.4 passes `--output-format stream-json --verbose` to Claude, which emits one JSON event per line for tool calls, thinking, text chunks, session start/end. A new `ui/stream-parser.ts` module parses those and renders each as a colored human-readable line.
- **Tool call visibility.** You now see every file Claude reads, every Bash command it runs, every edit it makes, in real time — as `→ Read(src/foo.ts)`, `→ Bash(ls -la)`, `→ Edit(package.json)`. Tool names are cyan, arguments are dim, the arrow is yellow.
- **`thinking…` placeholders** when Claude enters an extended-thinking block.
- **ESC / Ctrl+C interactive stop.** Press ESC (or Ctrl+C) once during a sleepy run to request a graceful stop — the supervisor writes `.sleepy/STOP` and sends SIGTERM to any active Claude child. Press again to force-quit with SIGKILL. TTY goes into raw mode during the run and restores cleanly on exit.
- **`killAllActiveChildren(signal)` helper** in `claude-launcher.ts` — tracks a `Set<ChildProcess>` of every in-flight Claude call so the top-level CLI can kill them on demand.
- **15 new unit tests** for the stream parser + renderer + partial-chunk buffering.

## [0.1.3] — 2026-04-15

Visibility hotfix. `sleepy start` was effectively opaque — you'd see "starting..." and then nothing for minutes while Claude was running headless. This release makes the loop **show its work**.

### Added

- **Live-streaming Claude output.** `sleepy start` now streams the orchestrator's and worker's stdout/stderr to your terminal as Claude writes them. Orchestrator output is prefixed with `│` (cyan); worker output is prefixed with `▸` (magenta).
- **Colored, branded terminal output.** Raw-ANSI color helpers (no new deps, TTY-aware). Sleepy's "yellow-and-character" brand extended to the terminal: banner, status lines, success/error glyphs, meta text.
- **ASCII banner at launch.** `sleepy start` prints the sleepy banner + character before kicking off, with a subtitle showing mode/iterations/intensity.
- **Richer progress output.** Between Claude calls the supervisor prints what phase it's in: "orchestrator picked backlog #N", "creating worktree on branch sleepy/<slug>", "worker produced branch <branch>", etc. Each has meta/header/success/error colors.
- **`streamOutput` launcher option** on `RealClaudeLauncher` (line-buffered, TTY-aware, prefixable).

### Fixed

- The phase-5 release-readiness test was pinned to `0.1.0`. Now it checks semver shape and verifies the cli/plugin versions match.

## [0.1.2] — 2026-04-15

Two fixes for `sleepy go` surfaced by the first real use:

### Fixed

- **Multi-word descriptions without quotes.** `sleepy go work on my recommender` now works. Previously commander parsed only the first word as the description. Changed the argument to variadic (`<description...>`) so all remaining positional words are joined.
- **Navigator filesystem permissions.** The navigator was launched with a scratch cwd, which Claude Code's default permission model treated as its only readable root — so it couldn't see `~/Projects`. The navigator call now uses `--dangerously-skip-permissions` (scoped to this one ephemeral read-only call; the `sleepy-navigator` skill is prose-locked to read-only operations plus one result file).

## [0.1.1] — 2026-04-15

Hotfix addressing the home-directory footgun and adding natural-language project selection.

### Added

- **`sleepy go "<description>"`** — natural-language project finder. sleepy launches a read-only "navigator" Claude call that walks your filesystem (`~/Projects`, `~/code`, `~/Documents`, etc.), matches the description against directory names and README content, and returns an absolute path + confidence + optional scope hint. Confirms with you before dispatching the real loop in the target directory.
- **`plugin/skills/sleepy-navigator/SKILL.md`** — the navigator skill (read-only, locked to producing a single `.sleepy-navigator-result.json` file).
- **`cli/src/state/cwd-safety.ts`** — hard refusal module. `sleepy init` and `sleepy start` now refuse to run in `$HOME`, `/`, `/tmp`, `/var`, `/usr`, `/opt`, `/etc`, `/System`, `/Library`, and other system directories. A `--force` flag exists for expert override.

### Fixed

- **Home-directory footgun.** Previously, running `sleepy init` or `sleepy start` from your home directory would scaffold `.sleepy/` there and start surveying your entire `$HOME`. Now both commands hard-refuse and print a helpful error pointing at `sleepy go` or `cd <project>`.

## [0.1.0] — 2026-04-15

First shippable release. Five phases of implementation, all end-to-end tested.

### Added

- **Phase 1 — Foundation**: monorepo, typed state layer (`.sleepy/config.json`, `budget.json`, markdown files), Claude Code session JSONL parser, intensity bundles and pacing math, `sleepy init/status/doctor` commands.
- **Phase 2 — Orchestrator & dry-run**: plugin skeleton, `sleepy-orchestrator` skill, `ClaudeLauncher` interface with real and fake implementations, session finder, budget recorder, supervisor iteration loop, `sleepy start --dry-run` and `sleepy stop` commands, `sleepy link-plugin`.
- **Phase 3 — Workers & review queue**: `sleepy-worker` skill, `next-action.json` decision handoff, git worktree helpers, worker dispatch module, `SLEEPY_QUEUE.md` parser/writer, `sleepy apply`, `sleepy discard`, `sleepy why` commands, orchestrator WORK mode.
- **Phase 4 — Safety, TUI & install**: `SLEEPY_RULES.md` deny-list parser, post-worker diff-check rejection, stuck detection (3 consecutive unproductive iterations), self-compressing `SLEEPY_MEMORY.md`, `sleepy watch` terminal dashboard with the sleepy character, `install.sh` / `uninstall.sh`.
- **Phase 5 — Polish & release**: `sleepy dashboard` localhost web UI, full docs suite (architecture, safety, rules-file, troubleshooting), `examples/demo-project/`, `examples/SLEEPY_RULES.example.md`, comprehensive README.

### Known limitations

- One worker per iteration (sequential). Parallelism deferred.
- No GitHub PR mode. Branches only.
- Paid-API spend is the user's responsibility. Strip API keys from your env for unattended runs if you're concerned.
- Plugin discovery in headless Claude Code mode is worked around by inlining skill content into the launch prompt.
