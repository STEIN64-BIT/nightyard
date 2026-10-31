# Getting started with Nightyard

New to AI coding agents? This guide takes you from nothing to your first agents in about 20 minutes, on a Mac.

**What you're setting up**

- An **agent** is an AI that works in your project like a developer would: it reads your files, writes code,
  runs commands and tests, and tells you what it did. You talk to it in plain language.
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is the agent this guide uses.
- **Nightyard** is where you run your agents: every agent gets its own tab, per project, and you can see at a
  glance which ones are working, which are waiting for you, and what they cost.
- **Sleepy** (built in) runs on its own for hours — overnight, for example — and leaves you one report.
- **Wakey** keeps an open agent going while you're away from the keyboard.
- **Your notes** (an Obsidian vault, or any folder of Markdown files) show up as a live graph next to your agents.

## What you need

- A Mac (Apple Silicon or Intel).
- A **Claude subscription** (Pro or Max) — Claude Code runs on it. Optional: a ChatGPT plan for the Codex CLI.
- About 20 minutes.

## 1. Install the basics

Open **Terminal** (Spotlight: `⌘ Space`, type "Terminal") and run:

```bash
xcode-select --install
```

That installs git, which agents use to keep track of their changes. If it says it's already installed, you're good.

## 2. Install Claude Code and log in

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Then start it once with `claude`, and log in with your Claude account when it asks (or type `/login`). Type
`/exit` when you're done. Other install options are in the
[Claude Code docs](https://docs.anthropic.com/en/docs/claude-code).

## 3. Install Nightyard

1. Download the `.dmg` from [Releases](https://github.com/STEIN64-BIT/nightyard/releases). Pick **arm64** if
    *Apple menu → About This Mac* says "Chip: Apple M…", otherwise **x64**.
2. Open it and drag **Nightyard** to **Applications**.
3. Nightyard isn't signed with an Apple developer certificate, so macOS blocks it until you run this once in Terminal:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Nightyard.app
   ```
4. Open Nightyard from Applications.

On first start Nightyard adds a few hooks to Claude Code's settings (`~/.claude/settings.json`). That is how it
knows whether an agent is working or waiting. If another tool already shows a status line in Claude Code,
Nightyard asks before replacing it.

## 4. Add a project

Click **+** at the top of the sidebar (or `⌘⇧P`), give the project a name, and pick its folder.

- **Starting from scratch?** Make an empty folder and turn it into a git repository first:
  ```bash
  mkdir -p ~/Projects/my-first-app && cd ~/Projects/my-first-app && git init
  ```
- **Existing code?** Pick the folder that holds it. If it isn't in git yet, run `git init` there and commit
  what you have (`git add -A && git commit -m "start"`), so you can always get back to this point.

## 5. Read this before your first agent

**Nightyard runs Claude Code without permission prompts** (`--dangerously-skip-permissions`). Your agent edits
files and runs commands on its own, without asking first. That's what makes it fast, and it's why:

- Only add projects you're fine with an agent changing.
- **Commit before you start a task.** If you don't like the result, `git checkout .` (or ask the agent to undo
  its changes) gets you back.
- Keep passwords, keys and personal files out of your project folders.
- Watch what the agent does for your first few tasks. You can stop it any time with `Esc`.

## 6. Your first agent

Select your project in the sidebar and press `⌘T` (**New Session**). A tab opens with Claude Code running in your
project. (The **+** next to the tabs also lets you pick another agent, like Codex.) Type what you want in plain
language and press Enter. For example:

- *"Make a simple to-do list web page I can open in my browser."*
- *"Explain how this project is put together. Which files matter most?"*
- *"Find out why the tests fail and fix it."*

The dot on each tab shows the agent's state: working, waiting for you, or done. You can switch to another tab
while one works.

### Getting good results

- **Say what you want to end up with**, not just the first step: *"a page where I can add and tick off tasks,
  saved between visits"*.
- **Ask for a plan first** on bigger tasks: press `Shift+Tab` until Claude shows *plan mode*, describe the task,
  and read the plan before you let it build.
- **Work in small steps.** Check the result, then ask for the next thing.
- **Ask it to check its own work:** *"run the tests"*, *"open it and check the page loads"*.
- **Run `/init` once per project.** Claude writes a `CLAUDE.md` file with notes about your project, and reads it
  at the start of every session. Add your own rules to it ("always write tests", "use TypeScript").
- **New topic, fresh start:** `/clear` empties the conversation; `Esc` interrupts the agent mid-task.

## 7. Several agents at once

Open more tabs with `⌘T`. Each agent works on its own task in the same project. Jump between them with
`⌘1`…`⌘9`, or press `⌘\` to see them side by side. Give two agents unrelated tasks (say, one on the page layout
and one on the tests), so they don't edit the same files.

## 8. Let it run while you're away

- **Wakey (☀ in the sidebar header)** keeps the agent in the current tab going. Type a direction ("get all tests
  green") and press Enter. Whenever the agent stops, Wakey decides what to type next. It stops by itself after
  50 rounds or repeated errors, and the panel bottom right shows what it's doing. Wakey is in beta, so keep an
  eye on your first runs.
- **Sleepy (`(-.-)` in the sidebar header)** is for long runs. Type a goal, pick a duration (30 min, 2 h, 8 h)
  and press start. Sleepy plans the work and does it on the side: code changes go into separate git branches,
  written work into the `.sleepy/` folder, so your own work isn't touched. When it's done you get one readable
  report in `.sleepy/reports/` in your project, with the commands to try each change and keep the ones you like.

Both use your Claude subscription while you're away. **Usage Stats** (`⌘⇧U`) shows what you've used.

## 9. Bring in your notes

Got an Obsidian vault (or a folder of Markdown notes)? Set it under **Preferences** (⚙ in the sidebar header) →
*Knowledge vault path*. Then click **⊞** in the sidebar header and click the graph: your notes and your agents
appear together. Click a note to start an agent on it (*Launch agent here*), let Wakey steer it (*Launch with
Wakey*), or hand it to Sleepy (*Plan with Sleepy*). Finished Sleepy runs leave a summary note in
`<vault>/Sessions/`.

## Handy shortcuts

| Keys | What it does |
| --- | --- |
| `⌘T` | New session (agent) |
| `⌘⇧P` | New project |
| `⌘1` … `⌘9` | Go to session 1–9 |
| `⌘\` | Show sessions side by side |
| `⌘W` | Close the session |
| `⌘⇧F` | Search all sessions |
| `⌘⇧U` | Usage stats |
| `F1` | Help |

## When something's off

- **"Nightyard is damaged and can't be opened"** — run the `xattr` command from step 3 again.
- **"claude: command not found" in a tab** — install Claude Code (step 2), then quit and reopen Nightyard.
- **"Not logged in" / "Please run /login"** — type `/login` in the tab, or run `claude` in Terminal and log in.
- **Sleepy says it couldn't link its plugin** — Sleepy keeps its Claude Code skills in
  `~/.claude/plugins/sleepy`. Remove whatever is there (`rm -rf ~/.claude/plugins/sleepy`) and start Sleepy again.
- **Something else** — [open an issue](https://github.com/STEIN64-BIT/nightyard/issues) and say what you did and
  what you saw.
