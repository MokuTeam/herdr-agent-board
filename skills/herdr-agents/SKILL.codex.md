---
name: herdr-agents
description: "How a Codex session that runs inside herdr (HERDR_PANE_ID is set) works as a master: use the agent-board MCP tools (card, schedule, agents, threads, thread, team, spawn, cal) first and fall back to board --session <sid> / spawn-agent / herdr agent prompt when MCP is unavailable or for CLI-only flags. For the raw herdr CLI reference run `herdr --skill`."
---

<!-- agent-board: installed by the agent-board plugin's install action (--codex-home); it replaces this file on updates. -->

# Working inside herdr (Codex)

## Am I in herdr?

herdr gives every pane its context in the environment:

```bash
echo "$HERDR_ENV $HERDR_PANE_ID $HERDR_TAB_ID $HERDR_WORKSPACE_ID"   # 1 wP:p8 wP:t4 wP
```

No `HERDR_ENV=1`: you are not in herdr (a plain terminal, `codex exec`). Then none of this applies; do not drive herdr from outside it.

`HERDR_PANE_ID` is your own pane. herdr's name for you: `herdr agent get "$HERDR_PANE_ID"`.

## Your board card

The board's hook told you at the start how to keep your card current. Prefer the `agent-board` MCP server's tools (`card`, `schedule`, `agents`, `threads`, `thread`, `team`, `spawn`, `cal`), which run as your session with no `--session` to pass:

- `card` (`op`: `"doing"`, `text`: `"<3-8 words>"`) at the start of each distinct step; `cat` (`lane`, optional `text`) for your lane.
- `card` (`op`: `"ask"`, `text`: `"<question>"`) before ending a turn that needs the user; `wait` (`text`: `"<on what>"`) when blocked outside this chat; `done` (`text`: `"<result>"`) when the task is finished.
- Fallback when MCP is unavailable: run each `board` command as a shell call of its own that starts with `board`, nothing before or after it (no `cd`, `Get-Location`, `;` or script around it): only that call is let out of Codex's sandbox to herdr (#916). Your shell may not inherit the pane's environment, so every command names your session (`board --session <your session id> <command>`, as printed on the brief's fallback line): `board --session <sid> doing|ask|wait|done|cat`, `list` (every session on the board), `doctor` (what is set up here).

## Start another session

Prefer the `agent-board` MCP server's `spawn` tool (`name`, `cwd`, optional `brief`, `profile`, `device`, `lane`, `agent`, `trust`). Fallback to `spawn-agent` when MCP is unavailable or when you need CLI-only flags (`--label`, `--workspace`, `--model`, `--brief-file`, `--thread`):

```bash
spawn-agent --name <Name> --cwd <folder> [--label "<tab label>"] [--brief-file <utf-8 file> | --brief "<text>"] [--workspace <herdr workspace id>] [--model <id or alias>] [--agent claude|pi|codex] [--device <id|local>]
```

It opens a tab, starts the agent the way this computer is set up to, names the session, sends the brief and prints `pane=<id> name=<Name> agent=<herdr name>`. The board links the two sessions by that line. `spawn-agent --help` lists what this copy takes: `--agent codex` only where it is listed; without `--agent` it starts Claude.

- Put a long brief in a UTF-8 file (`--brief-file`): quoting a long text on a command line breaks.
- `--workspace` takes the workspace id (`wP`), not its label. Without it the session lands in your workspace.
- Do not start an agent with `herdr agent start` or a bare command in a pane: it gets no name, no brief and none of this computer's launcher settings.
- A new folder may show a "trust this folder" dialog: spawn-agent stops and says so; the user answers it in that tab.
- Where the board has other devices it places the new session, also when you run on a node (both `spawn` and `spawn-agent` ask the master then). `--device <id>` starts it on that machine (`local` is the master itself) and fails at once when the device is unknown, offline, or the folder cannot go there.
- A one-off session that has finished can be taken off the board with `board archive --session <name>`, but only one you started, or when the user asks.

## Hand work out by thread, hear the result in one line

The board's threads (`threads` and `thread` MCP tools; fallback `board thread`, the agent-board-threads skill has the whole story) keep a task's progress and result outside your context. `threads` (`op: "list"`) says whether threads are on: "threads are off" means use the other way below.

- `thread` (`op: "new"`, `title: "<title>"`, `to: "<session name>"`) makes a thread in your lane, given to that session. Fallback: `board --session <sid> thread new "<title>" --to <session name>`.
- Put the key in the worker's brief: "Work in thread atlas-13: post your status and result there with the `thread` MCP tool (`op: "post"`, or `board --session <its sid> thread post` as fallback), a report as `files` (`--file`); send me nothing else."
- You watch every thread you create. When the worker finishes, a line arrives as a prompt: `[board reminder from threads] atlas-13 done: <summary>. More: board thread changes`. Read more with `threads` (`op: "show"`, `key`, or `board thread show <key>`) only if you need it.
- `threads` (`op: "changes"`) prints what moved since you last asked; `thread` (`op: "watch"`, `key` or omit `key` for `--mine`) adds a watch (CLI fallback for `--lane <id>` or `show --full`).
- Without threads: `herdr agent wait <pane> --until idle --until done` (add `--timeout <ms>`), then `herdr agent read <pane> --source recent-unwrapped --lines 120`. Idle does not mean the task is done: tell the worker in its brief to end with a line you can find.

## When a session handed you a thread

Your brief names a key (`atlas-13`). Report there, not in a message back:

- `thread` (`op: "post"`, `key: "atlas-13"`, `status: "doing"`, `summary: "<where it stands, one line>"`) at a step worth knowing.
- `thread` (`op: "post"`, `key: "atlas-13"`, `status: "done"`, `summary: "<the result, one line>"`, `files: ["out/report.md"]`) when you finish (fallback: `board --session <sid> thread done atlas-13 "<summary>" --file out/report.md`). The summary is the one line the others hear: make it say the result.
- `thread` (`op: "post"`, `key: "atlas-13"`, `status: "waiting"`, `summary` / `text`; CLI fallback for `--waiting "<on what>"`) when blocked outside the board.
- `thread` (`op: "ask"`, `key: "atlas-13"`, `text: "<question for the owner>"`) when you need the owner's answer; the thread waits on the owner and your card moves to "needs the user".
- A flag or argument a call does not take is refused: read the error and fix it.

## Talk to another session

Prefer the `agent-board` MCP server's `agents` tool (`op: "list"`, `op: "send"` with `to` and `message`; fallback: `board --session <sid> agents` / `board --session <sid> send`). When you need to type directly into a pane's terminal (only for a session you coordinate or when the user asked):

```bash
herdr agent list
herdr agent prompt <pane or name> "<text>"
```

`herdr agent prompt` types the text and presses Enter in one go. It is rejected with `agent_blocked` while that session shows a dialog; it queues behind a turn that is running. It lands in whatever the other session or the user is typing: prefer `agents` (`op: "send"`) for safe delivery and a thread when the message is a task. A long text goes in a file, with the prompt saying where to read it.

## Do something later

Prefer the `agent-board` MCP server's `schedule` tool (`op: "remind"`, `"every"`, `"list"`, `"unschedule"`). Fallback in a shell:

```bash
board --session <sid> remind in 30m "check the CI of PR 12 and merge it if green"
board --session <sid> remind tomorrow 9:00 "send the weekly report" --idle
board --session <sid> every "0 9 * * 1-5" "look at the overnight alerts"
board --session <sid> schedule            # this session's entries
board --session <sid> unschedule <id>
```

At that time the board types `[board reminder] <text>` into this session as a prompt. Write the text as an instruction to yourself. By default it arrives on time, queued behind a running turn; `idle: true` (`--idle`) waits until the session is free.

For a long-running external process, give the card a specific waiting reason with `card`
(`op: "wait"`, fallback `board wait`) and end your turn. Skip shell `sleep` and PowerShell
`Start-Sleep` polling loops. Resume on an existing event or one authorized Board reminder.
Mark the card as doing when work resumes.

## Sleep and restart

- With the board’s own wake enabled, `board sleep` can put an idle Codex session to sleep. A message or reminder wakes the same conversation. If its pane is gone, wake opens a tab in its workspace.
- `board restart [note]` restarts the session when it is free and delivers the note after it resumes.

## Codex controls
- Codex's own sandbox: `board`, `spawn-agent` (and, for masters, `herdr agent prompt|read|list|get`) run outside it through the rule file of this Codex home. A `herdr` command not in that file fails with "Operation not permitted": ask the user to approve it when Codex asks.
- You cannot see another Codex session's permission dialog; the user answers it on its card.

## Do not

- Run bare `herdr`: it opens the TUI. For a command group's help run it without a subcommand (`herdr pane`, `herdr tab`).
- Close tabs, panes or workspaces you did not create, or run `herdr server stop`.
- Rely on the focused pane: pass `--current`, a pane id or an agent name, and read ids from the JSON herdr returns.
