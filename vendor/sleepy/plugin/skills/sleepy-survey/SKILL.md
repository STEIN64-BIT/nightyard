---
name: sleepy-survey
description: Use this skill when the sleepy-orchestrator needs to produce an initial backlog for a project it has no prior knowledge of. Performs a bounded project survey (README, manifest, top-level tree, a few key files) and returns categorized work items. Phase 2 note — the orchestrator runs the survey inline in dry-run mode; this skill is a reference for Phase 3+ when surveys can be delegated to a worker.
---

# sleepy-survey

This skill is a standalone version of the survey procedure in `sleepy-orchestrator`. Use it when a fresh project needs an initial backlog and the orchestrator is delegating to a worker.

## Procedure

1. Read `README.md` if present.
2. Read the primary manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`).
3. List top-level directories (depth 1–2, skip `node_modules`, `.git`, `dist`, `.sleepy`).
4. Read 3–5 key files.
5. Check `.sleepy/SLEEPY_RULES.md` for explicit priorities.
6. Generate 15–30 backlog items across these categories: `bug`, `test`, `polish`, `gap`, `debt`, `research`, `content`.
7. Return the items as a markdown table with columns: `# | Category | Title | Effort | Reasoning`.

## Output format

See `sleepy-orchestrator` skill for the `SLEEPY_BACKLOG.md` table format. Return items in priority order (bugs first, then gaps, then polish, then research/content).
