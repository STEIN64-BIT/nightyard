<div align="center">

```
                    ███████╗██╗     ███████╗███████╗██████╗ ██╗   ██╗
                    ██╔════╝██║     ██╔════╝██╔════╝██╔══██╗╚██╗ ██╔╝
                    ███████╗██║     █████╗  █████╗  ██████╔╝ ╚████╔╝
                    ╚════██║██║     ██╔══╝  ██╔══╝  ██╔═══╝   ╚██╔╝
                    ███████║███████╗███████╗███████╗██║        ██║
                    ╚══════╝╚══════╝╚══════╝╚══════╝╚═╝        ╚═╝

                                   (-.-) zZz
                         claude works while you sleep
```

**An autonomous Claude Code loop that runs for hours or days, producing reviewable git branches you approve when you get back.**

![version](https://img.shields.io/badge/version-0.3.0-fbbf24)
![node](https://img.shields.io/badge/node-20%2B-22c55e)
![license](https://img.shields.io/badge/license-MIT-94a3b8)
![tests](https://img.shields.io/badge/tests-222%20passing-22c55e)
![status](https://img.shields.io/badge/status-v0.3.0%20released-fbbf24)

[Install](#install) · [Quickstart](#quickstart) · [Just talk to it](#just-talk-to-it) · [Commands](#commands) · [How it works](#how-it-works) · [Safety](#safety) · [Docs](#documentation)

</div>

---

## The idea

You point sleepy at your project, say good night, and it gets to work. Claude surveys the codebase, picks one thing at a time, does it in an **isolated git worktree**, and leaves each finished piece as a branch for you to review. When you wake up, you open a queue, run `sleepy why 3` to see what the worker was thinking, and `sleepy apply 3` to merge it (or `sleepy discard 3` to drop it).

Your main working tree is **never** touched until you say so. sleepy never pushes to remotes, never opens PRs, never calls `git reset --hard`. The whole promise is: **you stay in charge of the merge button**.

```
   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
   │   (-.-) zZz  │───▶│   (>'.'<)    │───▶│    (^_^)     │
   │   sleeping   │    │   working    │    │     done     │
   └──────────────┘    └──────────────┘    └──────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │   (O_O)!     │
                       │   alarmed    │
                       └──────────────┘
```

These are the real character states in `sleepy watch`. The character reacts to what the supervisor is doing: sleeping between iterations, working while the orchestrator or a worker is running, alarmed if something triggered wind-down.

---

## Just talk to it

You don't configure sleepy with flags. You tell it what you want in English and a **planner** Claude call figures out the rest — which project on your machine to run in, how long, at what intensity, what to focus on.

```bash
sleepy go loop until tomorrow morning on my recommender, focus on the ATC modal polish
```

```
sleepy: asking Claude to plan "loop until tomorrow morning on my recommender..."

sleepy: ✓ plan resolved
         project:    /Users/alice/Projects/my-recommender
         confidence: 0.92
         duration:   14h  (until 4/16/2026, 8:00:00 AM)
         intensity:  medium
         focus:      ATC modal carousel polish
         scope:      src/components/ATCModal/
         reasoning:  'my recommender' matched exactly. 'tomorrow morning'
                     resolved to 8am local. 'ATC modal polish' narrowed scope
                     to src/components/ATCModal/ which exists in the repo.

sleepy: proceed with this plan? [Y/n] y
sleepy: wrote .sleepy/USER_GOALS.md in target project
sleepy: dispatching sleepy start --intensity medium --duration 14h in /Users/alice/Projects/my-recommender
```

The planner is read-only — it walks `~/Projects`, `~/code`, `~/Documents`, etc., matches your description against directory names and READMEs, resolves relative time phrases using your local timezone, and returns a concrete plan. If it's not confident it returns candidates for you to pick from instead of guessing.

When the planner returns user goals, sleepy writes them to `.sleepy/USER_GOALS.md` in the target project. The orchestrator reads this file on every iteration and prefers backlog items that match your stated focus. So "focus on the landing page polish" isn't just a scope filter — it actually shapes which work gets picked.

More ways to say it:

```bash
sleepy go run for 2 hours on project-a, low intensity, test coverage only
sleepy go burn 5M tokens on my project-c project
sleepy go overnight on the project-b project, focus on landing page
sleepy go my recommender             # simple case — just find it, use defaults
sleepy go run overnight on my X, make it better and get more users
```

You can still use flags directly if you want (`sleepy start --duration 48h --intensity max`) — `sleepy go` is a convenience layer, not a replacement.

### Sleepy is creative too

As of **v0.3.0**, sleepy doesn't only edit code. In a long run it'll mix four kinds of work across iterations:

- **🛠️ code** — git branches with real changes (tests, features, fixes)
- **🔍 research** — market/competitor/user research reports, web + project reads → `artifacts/research/`
- **✏️ design** — feature specs and brainstorms, composes with [`superpowers:brainstorming`](https://github.com/anthropics/claude-code) when available → `artifacts/plans/`
- **📣 content** — landing copy, launch posts, docs, social variants → `artifacts/content/`

The orchestrator actively varies work types across iterations so your review queue is a **diverse portfolio** (code + research + design + content) rather than a pile of PRs. It also **sequences intelligently**: if it ships a design doc in iteration 4, iteration 5 or 6 can dispatch a code worker that reads the spec and implements it. Full idea → research → spec → code flow, automatically.

The orchestrator has a **universal compass** baked in — "make it better, get more users, keep them happy, be one of a kind, be more useful, learn about the market" — so it never runs out of meaningful work even when `USER_GOALS.md` is absent. Every iteration should leave the backlog at least as long as it found it.

### While it's running

- **Live activity output.** Every file Claude reads, every command it runs, every edit — you see it streaming in real time, prefixed with `│` (cyan) for the orchestrator and `▸` (magenta) for workers.
- **ESC or Ctrl+C** to stop. First press triggers a graceful stop (writes `.sleepy/STOP`, SIGTERM to any active Claude child). Second press is a hard force-quit with SIGKILL.
- **Pacing shifts in real time.** If your burn rate is projecting over the token cap before the deadline, the supervisor downshifts intensity one level (high → medium → low). You'll see a `sleepy: pacing — shifted high → medium (downshift: projected X tokens exceeds cap)` line when it happens.
- **Multiple terminals.** Run `sleepy watch` in another terminal for a live TUI dashboard with the sleepy character, or `sleepy dashboard` for a localhost web UI. Both read the same state files and can run concurrently on different machines.

---

## Why this exists

If you're on Claude Max 20x (or similar) you have a ton of quota you will never spend sitting at your keyboard. sleepy turns that leftover capacity into **reviewable work**. It's goal-less by default — just run it in a repo and it'll find things to do. Give it a rules file and it'll stay in scope. Give it a token budget and it'll pace itself to last.

The loop is deliberately **one worker per iteration**. No parallelism fireworks, no multi-agent swarms. One Claude call picks the next task. One Claude call does it in a worktree. The supervisor glues the two together and enforces the boundaries. Boring is good here — boring is what lets you trust it overnight.

---

## Install

**Prerequisites:** Node 20+, git, pnpm, and [Claude Code](https://docs.claude.com/claude-code) already installed and signed in.

```bash
git clone https://github.com/STEIN64-BIT/sleepy
cd sleepy
./install.sh
```

The install script:

1. Checks you have Node 20+, git, pnpm, and claude on `PATH`
2. Runs `pnpm install` at the monorepo root
3. Builds `@sleepy/cli`
4. Links `sleepy` globally via pnpm
5. Symlinks the plugin into `~/.claude/plugins/sleepy/`
6. Runs `sleepy doctor` to verify everything

### If `sleepy: command not found` after install

pnpm linked the binary but your shell can't see pnpm's global bin directory. Easiest fix — add this alias to your shell profile:

```bash
echo 'alias sleepy="node ~/Projects/sleepy/cli/bin/sleepy.mjs"' >> ~/.zshrc
source ~/.zshrc
```

(Replace `~/Projects/sleepy` with wherever you cloned the repo.)

Or do it the pnpm way by adding `PNPM_HOME` to your `PATH` — see [docs/troubleshooting.md](docs/troubleshooting.md).

### Uninstall

```bash
./uninstall.sh
```

Removes the global link and the plugin symlink. Source tree left intact.

---

## Quickstart

The fastest path — no flags, no `cd`, just say what you want:

```bash
# 1. Ask sleepy to preview a run on one of your projects
sleepy go dry-run my project-b project

# 2. Happy with the preview? Ask it to actually run
sleepy go loop until tomorrow morning on my project-b project, focus on landing page polish

# 3. In a second terminal, watch it work
sleepy watch                # live terminal dashboard with the sleepy character
# or
sleepy dashboard            # localhost web UI at http://localhost:8910/

# 4. When you come back, review what's waiting
cd ~/Projects/project-b
cat .sleepy/SLEEPY_QUEUE.md
sleepy why 1                # read the reasoning for queue item #1
sleepy apply 1              # merge the branch into your current branch
sleepy discard 2            # drop queue item #2
```

The more manual path, if you prefer flags to English:

```bash
# Scaffold sleepy in your project (refuses $HOME and system dirs)
cd your-project
sleepy init

# Edit .sleepy/SLEEPY_RULES.md with your deny-list and scope hints
# Strongly recommended — see docs/rules-file.md

# Dry-run first: preview the backlog, no workers dispatched
sleepy start --dry-run --intensity low --max-iterations 1
cat .sleepy/SLEEPY_BACKLOG.md

# Go live with real limits
sleepy start --intensity medium --duration 14h --cap 5000000
```

Both paths end up running the same supervisor loop; `sleepy go` just builds the flags for you by asking Claude what you meant.

---

## Commands

| Command | What it does |
|---|---|
| `sleepy go <english…>` | **Natural-language entry point.** Asks Claude to plan a run — project + duration + intensity + focus + goals — and dispatches `sleepy start` with the resolved flags. See [Just talk to it](#just-talk-to-it). |
| `sleepy init` | Scaffold `.sleepy/` in the current directory. Refuses to run in `$HOME` or system directories. |
| `sleepy start [options]` | Launch a sleepy run directly with explicit flags. See options below. |
| `sleepy stop` | Write `.sleepy/STOP` — the supervisor triggers wind-down on its next iteration (or press `ESC` during a live run) |
| `sleepy status` | One-shot snapshot of the current run (for scripts) |
| `sleepy watch` | Open a live terminal dashboard with the sleepy character |
| `sleepy dashboard` | Start a localhost web dashboard at `http://localhost:8910/` |
| `sleepy apply <#>` | Merge queue item `<#>`'s branch into the current branch |
| `sleepy discard <#>` | Delete queue item `<#>`'s branch (or file artifact) and drop the row |
| `sleepy why <#>` | Print `SLEEPY_ARTIFACT.md` — the worker's reasoning for item `<#>` |
| `sleepy review [--run <id>] [--json]` | List what a run produced, each with its status and the exact command to integrate it. `--integrate <#> --head <sha> --target <branch>` merges one reviewed branch: it re-checks the branch is unchanged, tries the merge in a throwaway worktree first, and only refuses when your uncommitted work touches the same files (it names them; nothing is stashed or committed for you) |
| `sleepy report [options]` | Rebuild the report of what a run built and wrote; see ["Read what a run produced"](#read-what-a-run-produced) below. |
| `sleepy doctor` | Environment diagnostics (Node version, git, claude, plugin install) |
| `sleepy link-plugin` | Symlink the plugin into `~/.claude/plugins/sleepy/` |
| `sleepy --version` | Print the current version |

### `sleepy start` options

| Flag | Meaning | Default |
|---|---|---|
| `--dry-run` | No worker dispatch — orchestrator only produces a backlog | off |
| `--intensity <level>` | `low` \| `medium` \| `high` \| `max` | `medium` |
| `--duration <spec>` | Deadline spec: `48h`, `2d`, `30m` — **enforced, loop terminates with reason `deadline`** | none |
| `--cap <tokens>` | Hard token ceiling — **enforced, loop terminates with reason `token-cap`** | none |
| `--max-iterations <n>` | Supervisor loop ceiling | 1 dry-run; unlimited if duration/cap set; 10 otherwise |
| `--force` | Skip the `$HOME`/system-dir safety refusal (expert) | off |
| `--provider <name>` | Single-provider run: `opus` or `codex`, used for planning **and** every worker | `opus` |
| `--team` | Sleepy Duo: Codex builds while a read-only Opus reviews; see [Sleepy Duo](#sleepy-duo-codex--opus) | off |
| `--goal <text>` | Focus for this run | none |

The supervisor terminates early on any of: **deadline hit**, **token-cap hit**, 3 consecutive failed iterations (`consecutive-failures`), 3 consecutive unproductive iterations (`stuck`), `.sleepy/STOP` flag (written by `sleepy stop` or a keypress), `.sleepy/PANIC` flag, or `--max-iterations`.

### Intensity presets

| Parameter | low | medium | high | max |
|---|---|---|---|---|
| Target iteration length | 5 min | 15 min | 30 min | 60 min |
| Per-iteration token cap | 30k | 80k | 150k | 300k |
| Sleep between iterations | 120s | 60s | 30s | 10s |
| Max parallel workers¹ | 1 | 1 | 2 | 3 |
| Risk tolerance | cautious | normal | normal | aggressive |
| Stop on uncertainty | yes | sometimes | rarely | never |
| Worker ambition | small | medium | large | large |

¹ Parallelism is planned but not yet shipped — sleepy currently dispatches one worker per iteration, sequentially.

**Adaptive pacing:** when both `--duration` and `--cap` are set, the supervisor calls `decidePacing()` after each iteration, computes the projected burn rate vs the remaining budget, and **automatically downshifts intensity** if the run is burning too fast. You'll see a line like `sleepy: pacing — shifted high → medium (downshift: projected 22,800,000 tokens exceeds cap)` when it happens. Intensity drifts back up toward your ceiling as the run recovers headroom.

### Read what a run produced

Every `sleepy start` ends by writing `.sleepy/reports/<run>.html` (and `latest.html`): one self-contained page, phone-friendly, that lists what was built (branches, with the commands to try and integrate them) and what was written (research, plans, content), summary first. Rebuild it any time:

    sleepy report            # whole queue
    sleepy report --run <id> # one run
    sleepy report --open     # and open it

To have the report land where you read, put a shell command in `~/.config/sleepy/settings.json` (or `.sleepy/settings.json` per project). Sleepy runs it with `SLEEPY_REPORT_PATH` and `SLEEPY_PROJECT` set; see `examples/settings.example.json`.

---

## How it works

sleepy has **three layers** that communicate through files on disk.

```
┌────────────────────────────────────────────────────────────────┐
│                        THE SUPERVISOR                          │
│                          (Node CLI)                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ - launches claude -p with the orchestrator prompt        │  │
│  │ - parses ~/.claude/projects/<slug>/*.jsonl for tokens    │  │
│  │ - enforces duration, cap, stop/panic flags, stuck det.   │  │
│  │ - creates git worktrees for workers                      │  │
│  │ - checks worker diffs against SLEEPY_RULES.md deny-list  │  │
│  │ - appends completed work to SLEEPY_QUEUE.md              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                 │
│                              ▼ launches                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    THE ORCHESTRATOR                      │  │
│  │               (one Claude session per iter)              │  │
│  │                                                          │  │
│  │  reads  .sleepy/SLEEPY_RULES.md                          │  │
│  │  reads  .sleepy/SLEEPY_BACKLOG.md                        │  │
│  │  reads  .sleepy/SLEEPY_MEMORY.md                         │  │
│  │  decides "what next?"                                    │  │
│  │  writes .sleepy/next-action.json                         │  │
│  │  exits                                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              │                                 │
│                              ▼ on dispatch-worker              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                       THE WORKER                         │  │
│  │                 (Claude in a git worktree)               │  │
│  │                                                          │  │
│  │  runs in a fresh branch sleepy/<slug>                    │  │
│  │  does ONE scoped task                                    │  │
│  │  commits + writes SLEEPY_ARTIFACT.md                     │  │
│  │  exits                                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

**Why two Claude calls per iteration?** Plugins don't auto-load in headless mode, so every skill is inlined into the launch prompt. Keeping orchestrator and worker as separate calls means (1) each has exactly one job, (2) tokens are accounted per role, and (3) tests can fake the two launchers independently. It costs one extra process launch per iteration — cheap compared to the work each session does.

**Why all state on disk?** Sleepy runs for hours or days. In-memory state would be lost to session restarts, OS sleep, or context-window pressure. Keeping every decision on disk means the supervisor can relaunch Claude as many times as it likes and each new session picks up from the files. The orchestrator compresses its own `SLEEPY_MEMORY.md` when it grows past ~500 lines so the loop never chokes on its own notes.

See [docs/architecture.md](docs/architecture.md) for the deeper dive.

---

## State files

Everything lives in `.sleepy/` at your project root (gitignored by default):

| File | Writer | Purpose |
|---|---|---|
| `SLEEPY.md` | orchestrator | Live state, resume note, iteration summary |
| `SLEEPY_BACKLOG.md` | orchestrator | Prioritized work items |
| `SLEEPY_QUEUE.md` | supervisor | Review queue — the product of the loop |
| `SLEEPY_MEMORY.md` | orchestrator | Cross-session notes (self-compressing) |
| `SLEEPY_RULES.md` | **you** | Scope and deny-list (sleepy never writes) |
| `config.json` | supervisor | Run parameters |
| `budget.json` | supervisor | Token/iteration counters |
| `next-action.json` | orchestrator | Decision handoff to the supervisor |
| `STOP` | you | Graceful stop flag |
| `PANIC` | you | Hard kill flag |
| `artifacts/` | workers | Non-code outputs (research, content, plans) |
| `logs/` | both | Per-session log files |

---

## Safety

sleepy runs autonomously against your code. This is an honest accounting of what it enforces:

### Hard guarantees (cannot be disabled)

- 🛡️ **Your main working tree is never touched by workers.** All code changes happen in isolated git worktrees on `sleepy/*` branches.
- 🛡️ **Never pushes to remotes.** sleepy never runs `git push`, `gh pr create`, or any remote write.
- 🛡️ **Never destructive on your state.** No `git reset --hard`, no `git rebase -i`, no `git branch -D` outside sleepy's own branches.
- 🛡️ **`SLEEPY_RULES.md` deny-list is hard-enforced.** After a worker commits, the supervisor `git diff --name-only`s the branch and checks every file against the `## Do not touch` section. If anything matches, the branch is **deleted** before it reaches the queue.
- 🛡️ **Stuck detection.** 3 consecutive unproductive iterations terminate the loop with reason `stuck`.
- 🛡️ **Consecutive-failure breaker.** 3 failed iterations in a row also terminate.

### Soft guidance (asked, not forced)

- 💡 Scope hints in `SLEEPY_RULES.md` — the orchestrator is instructed to respect them, but the enforcement comes from the diff check, not the instruction.
- 💡 `--dry-run` mode — the orchestrator is told not to touch anything outside `.sleepy/`.

### Not yet enforced

- ⚠️ **Network mutations.** The worker can call any HTTP API Claude has access to. **Strip paid-API env vars before unattended runs** (`unset OPENAI_API_KEY STRIPE_SECRET_KEY ...`).
- ⚠️ **Secret exfiltration scanning.** sleepy doesn't scan commits for API keys. Keep secrets in `.env` files and put `.env` in `## Do not touch`.
- ⚠️ **Runtime resource limits.** No memory/CPU/disk caps.

**Before running overnight, read [docs/safety.md](docs/safety.md).** It has specific hardening recommendations.

---

## What `sleepy watch` looks like

```
┌─ sleepy ─────────────────────────────────────────────────────────┐
│   (>'.'<)
│
│   intensity: medium   (user ceiling: high)
│   dry-run: no   wind-down: no
│   tokens: 1,840,320 / 10,000,000
│   iterations: 12
│
│   Backlog (top 5)
│     1. Fix race in auth middleware
│     2. Add unit tests for SessionStore
│     3. Document public API in src/api/
│     4. Add skeleton loaders to product grid
│     5. Clean up deprecated console.warn calls
│
│   Queue: 4 item(s) awaiting review
│     [ ] #1 Fix off-by-one in pagination
│     [x] #2 Add unit tests for add/sub utilities
│     [ ] #3 Add --help flag to CLI
│     [ ] #4 Update README with installation steps
│
└──────────────────────────────────────────────────────────────────┘
    press Ctrl+C to exit the dashboard (the sleepy run keeps going)
```

The web dashboard (`sleepy dashboard`) shows the same information as plain HTML on a dark slate background, served from `http://localhost:8910/` with auto-refresh via `<meta http-equiv="refresh">`. No SPA, no JavaScript, no dependencies. Same read-only view as the terminal dashboard — multiple watchers can run simultaneously on different machines.

---

## Documentation

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Three-layer architecture, state files, iteration loop, design trade-offs |
| [docs/safety.md](docs/safety.md) | Hard guarantees, soft guidance, unenforced items, hardening checklist |
| [docs/rules-file.md](docs/rules-file.md) | How to write `SLEEPY_RULES.md` — patterns, sections, examples |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Common issues and fixes |

---

## Try the demo project

The [`examples/demo-project/`](examples/demo-project/) directory is a tiny deliberately-broken JavaScript project. It has no tests, no input validation, and a `// TODO:` comment in the code. Perfect sleepy fodder.

```bash
cp -r examples/demo-project /tmp/sleepy-demo
cd /tmp/sleepy-demo
git init -b main
git config user.email "you@example.com"
git config user.name "You"
git add . && git commit -m "initial"

sleepy start --intensity low --max-iterations 1
sleepy why 1          # see what sleepy produced
git diff main sleepy/<slug>
sleepy apply 1        # merge it
```

Expected outcome: sleepy notices the missing tests (or the missing input validation, or the TODO) and produces a branch that addresses one of them. You review it and apply it. Boom — sleepy did work on a project it had never seen before.

---

## Project status

**v0.3.0 — the "actually creative" release.** 222 tests, typecheck clean, real end-to-end runs verified on live projects.

### Shipped

- ✅ Full loop: orchestrator → worker in worktree → review queue → `apply`/`discard`/`why`
- ✅ **Multi-type workers.** Orchestrator can dispatch `code` (git branches), `research` (web+project research reports), `design` (feature specs, composes with `superpowers:brainstorming`), and `content` (landing copy, launch posts, docs) — all in the same run.
- ✅ **Generative orchestrator with a universal compass.** Universal goals — make it better, get more users, keep them happy, stand out, be more useful, learn the market — apply even without `USER_GOALS.md`. Orchestrator actively generates new backlog items every iteration and varies work types.
- ✅ **Research → design → code sequencing.** If iteration 4 ships a design spec, iteration 5 or 6 can dispatch a code worker that reads the spec and implements it. Full idea → research → spec → code flow.
- ✅ **Real duration + token-cap enforcement.** `--duration 14h --cap 10M` are actually respected; supervisor terminates with reason `deadline` or `token-cap`.
- ✅ **Adaptive pacing.** `decidePacing()` fires after every iteration — intensity downshifts if burn rate projects over cap, drifts back up when headroom returns.
- ✅ **`sleepy go` natural-language entry point.** Say "loop until tomorrow on my project-b project, focus on landing page polish" and Claude resolves project/duration/intensity/focus/goals into a concrete run.
- ✅ **`.sleepy/USER_GOALS.md`** — the planner writes your goals into the target project; the orchestrator reads them on every iteration and prefers backlog items that match.
- ✅ **Live activity output.** `--output-format stream-json --verbose` gives you every tool call, thinking block, and text chunk as it happens — prefixed and colored per role.
- ✅ **ESC / Ctrl+C to stop.** Graceful stop on first press (writes STOP + SIGTERM to active Claude), force-quit on second (SIGKILL).
- ✅ **Home-directory refusal.** `sleepy init` and `sleepy start` refuse to run in `$HOME` or any system directory unless `--force`.
- ✅ `SLEEPY_RULES.md` deny-list hard enforcement (post-worker diff check rejects offending branches)
- ✅ Stuck detection + consecutive-failure breakers
- ✅ Self-compressing `SLEEPY_MEMORY.md`
- ✅ Terminal TUI (`sleepy watch`) with the sleepy character
- ✅ Web dashboard (`sleepy dashboard`) — plain HTML, localhost only
- ✅ Colored branded terminal output with ASCII banner
- ✅ `install.sh` / `uninstall.sh` one-command bootstrap
- ✅ Full docs suite (architecture, safety, rules, troubleshooting)
- ✅ Bundled demo project for smoke-testing

### Not yet shipped

- 🔜 Parallel workers within one iteration (up to 3 at max intensity)
- 🔜 GitHub PR mode (`--allow-github-prs`) — branches only for now
- 🔜 Paid-API spend caps (currently user's responsibility — strip API keys from env before unattended runs)
- 🔜 Multi-project supervisor watching several repos at once
- 🔜 Published `@sleepy/cli` on npm (install from git clone for now)
- 🔜 Remote/cloud mode so laptop sleep doesn't matter
- 🔜 Shareable `SLEEPY_RULES.md` templates for common project types

### Release history

- **v0.3.0** — multi-type workers (research/design/content alongside code) + generative orchestrator with universal compass
- **v0.2.0** — real loop enforcement (duration/cap/pacing actually respected) + natural-language planner
- **v0.1.4** — stream-json live activity output + ESC kill switch
- **v0.1.3** — colored terminal UI + ASCII banner
- **v0.1.2** — `sleepy go` multi-word args + navigator filesystem permissions
- **v0.1.1** — `sleepy go` natural-language project finder + home-directory refusal
- **v0.1.0** — first shippable release, five phases, 151 tests

---

## The backstory

sleepy was designed and built **in a single pair-programming session with Claude Code**. Everything in this repo — the design spec, the implementation plans, the code, the tests, the docs, and this README — was produced during one conversation using Anthropic's [Superpowers](https://github.com/anthropics/claude-code) skill library. The full record is checked in:

- `docs/superpowers/specs/` — the design spec (including the brainstorming back-and-forth)
- `docs/superpowers/plans/` — five phase plans for v0.1.0, then iterative hotfixes up to v0.3.0

The loop went: brainstorm the whole thing → write a spec → write Phase 1 plan → execute Phase 1 → smoke-test → write Phase 2 plan → execute Phase 2 → smoke-test → … → write Phase 5 plan → ship v0.1.0 → **use it on a real project, hit the sharp edges, fix them as hotfixes (v0.1.1 through v0.3.0)**. Each phase and each hotfix ended with a real end-to-end test against a real Claude invocation producing real branches. (Phase 3's live smoke test even caught a bug in the test script Claude wrote — which is exactly what the review queue is for.)

The post-v0.1.0 hotfixes are almost more interesting than the original phases: every one of them was driven by an actual failure mode the user hit in real use — accidentally running in the home directory, the opaque "nothing happening" screen, having to quote multi-word descriptions. The loop was good enough that fixing each one was a quick iteration inside the same pair-programming session.

sleepy is **self-dogfooding proof of concept**: Claude Code is good enough to build, ship, and iterate on its own autonomous work harness in a single conversation. That's the real story here.

---

## Contributing

Bug reports, feedback, and PRs welcome. Some things that would be especially helpful:

- **Safety gaps.** If you find a way to bypass the worktree isolation or the deny-list check, open an issue with `safety:` in the title. These are top-priority.
- **Intensity tuning data.** The intensity presets in [`cli/src/pacing/intensity.ts`](cli/src/pacing/intensity.ts) are first-guess numbers. If you've run sleepy for a real day and have better values, share them.
- **Rules file templates.** Community-contributed `SLEEPY_RULES.md` templates for common project types (Next.js, Python CLI, SwiftUI app, etc.) would save new users a lot of trial and error.
- **Real screenshots and a demo gif for this README.** Currently none — anyone running sleepy on a real project can capture some.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Credits

Built on [Claude Code](https://docs.claude.com/claude-code) and the [Superpowers](https://github.com/anthropics/claude-code) skill library. The sleepy character is a small homage to every ASCII-art cat that has ever lived inside a terminal.

<div align="center">

**Go to sleep. Wake up to reviewable work.** 🌙

```
(-.-) zZz
```

</div>

## Sleepy Duo: Codex + Opus

```bash
sleepy start --team --duration 2h --goal "Make the mobile checkout easier to use"
```

Duo uses the existing Sleepy orchestrator and review queue. For each code task,
Codex implements in the isolated worker worktree while Opus independently reads
the code and investigates edge cases and test gaps. Once both finish, Codex gets
Opus's findings for a reconciliation pass and records its response in
`SLEEPY_ARTIFACT.md`. Only Codex has write tools; Opus's tool set is restricted to
Read, Glob, and Grep, with MCP servers disabled. Research, design, and content
iterations continue using the existing Claude worker.

Install and sign in to both `codex` and `claude` first. Codex uses your configured
model; the reviewer explicitly uses `opus`. Set `SLEEPY_CODEX_BIN` if Codex isn't
on PATH. The integration uses [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
with the workspace-write sandbox and the worktree's shared Git metadata directory
as an additional write root so it can commit its branch.

Each Duo agent invocation has a 20-minute timeout. The run duration is checked
between iterations; an in-flight task may finish after that duration. Escape,
Ctrl+C, and SIGTERM stop active agents. A failed builder or reviewer never adds a
successful queue item. Duo currently accepts duration limits but rejects token
caps because combined Codex/Claude token accounting is not implemented. No runs
are pushed or merged automatically.

The supervisor checks stop requests after planning and worker completion, and during pacing waits. Failed workers count toward the three-failure circuit breaker; workers with no output count toward stuck detection. Failure circuit breakers return a nonzero exit status. Claude token accounting uses the exact launched session, avoiding interference from other agents working at the same time.
