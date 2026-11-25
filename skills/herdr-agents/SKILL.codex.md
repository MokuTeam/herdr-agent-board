---
name: herdr-agents
description: "How a Codex session that runs inside herdr (HERDR_PANE_ID is set) works as a master: start another session with spawn-agent, keep its board card current, hand work to a session as a thread (board thread) and hear one line when it is done, answer in a thread you were given, message another session with herdr agent prompt, schedule work for later with board remind. For the raw herdr CLI reference run `herdr --skill`."
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

The board's hook told you at the start how to keep your card current. Your shell may not inherit the pane's environment, so every command names your session: `board --session <your session id> <command>`. The hook's last line gives the exact form to copy.

- `board --session <sid> doing "<3-8 words>"` at the start of each distinct step.
- `board --session <sid> ask "<question>"` before ending a turn that needs the user. `wait "<on what>"` when you are blocked on something outside this chat. `done "<result>"` when the task is finished.
- `board --session <sid> list` shows every session on the board, `board --session <sid> doctor` what is set up here.

## Start another session

```bash
spawn-agent --name <Name> --cwd <folder> [--label "<tab label>"] [--brief-file <utf-8 file> | --brief "<text>"] [--workspace <herdr workspace id>] [--model <id or alias>] [--agent claude|pi|codex] [--device <id|local>]
```

It opens a tab, starts the agent the way this computer is set up to, names the session, sends the brief and prints `pane=<id> name=<Name> agent=<herdr name>`. The board links the two sessions by that line. `spawn-agent --help` lists what this copy takes: `--agent codex` only where it is listed; without `--agent` it starts Claude.

- Put a long brief in a UTF-8 file (`--brief-file`): quoting a long text on a command line breaks.
- `--workspace` takes the workspace id (`wP`), not its label. Without it the session lands in your workspace.
- Do not start an agent with `herdr agent start` or a bare command in a pane: it gets no name, no brief and none of this computer's launcher settings.
- A new folder may show a "trust this folder" dialog: spawn-agent stops and says so; the user answers it in that tab.
- Where the board has other devices it places the new session, also when you run on a node (spawn-agent asks the master then). `--device <id>` starts it on that machine (`local` is the master itself) and fails at once when the device is unknown, offline, or the folder cannot go there.
- A one-off session that has finished can be taken off the board with `board archive --session <name>`, but only one you started, or when the user asks.

## Hand work out by thread, hear the result in one line

The board's threads (`board thread`, the agent-board-threads skill has the whole story) keep a task's progress and result outside your context. `board thread list` says whether threads are on: "threads are off" means use the other way below.

```bash
board --session <sid> thread new "<title>" --to <session name>   # a thread in your lane, given to that session
```

- Put the key in the worker's brief: "Work in thread atlas-13: post your status and result there with `board --session <its sid> thread post`, a report as `--file`; send me nothing else."
- You watch every thread you create. When the worker finishes, a line arrives as a prompt: `[board reminder from threads] atlas-13 done: <summary>. More: board thread changes`. Read more with `board thread show <key>` only if you need it.
- `board --session <sid> thread changes` prints what moved since you last asked. `board thread watch <key> | --lane <id> | --mine` adds a watch.
- Without threads: `herdr agent wait <pane> --until idle --until done` (add `--timeout <ms>`), then `herdr agent read <pane> --source recent-unwrapped --lines 120`. Idle does not mean the task is done: tell the worker in its brief to end with a line you can find.

## When a session handed you a thread

Your brief names a key (`atlas-13`). Report there, not in a message back:

- `board --session <sid> thread post atlas-13 --status doing --summary "<where it stands, one line>"` at a step worth knowing.
- `board --session <sid> thread done atlas-13 "<the result, one line>" --file out/report.md` when you finish. The summary is the one line the others hear: make it say the result. A long report goes as `--file`.
- `board --session <sid> thread post atlas-13 --status waiting --waiting "<on what>"` when blocked outside the board.
- `board --session <sid> thread ask atlas-13 "<question for the owner>"` when you need the owner's answer; the thread waits on the owner and your card moves to "needs the user".
- A flag a command does not take is refused: read the error and fix the flag.

## Talk to another session

```bash
herdr agent list
herdr agent prompt <pane or name> "<text>"
```

`herdr agent prompt` types the text and presses Enter in one go. It is rejected with `agent_blocked` while that session shows a dialog; it queues behind a turn that is running. It lands in whatever the other session or the user is typing: use it for a session you coordinate or when the user asked for it, and prefer a thread when the message is a task. A long text goes in a file, with the prompt saying where to read it.

## Do something later

```bash
board --session <sid> remind in 30m "check the CI of PR 12 and merge it if green"
board --session <sid> remind tomorrow 9:00 "send the weekly report" --idle
board --session <sid> every "0 9 * * 1-5" "look at the overnight alerts"
board --session <sid> schedule            # this session's entries
board --session <sid> unschedule <id>
```

At that time the board types `[board reminder] <text>` into this session as a prompt. Write the text as an instruction to yourself. By default it arrives on time, queued behind a running turn; `--idle` waits until the session is free.

## What is not there yet for Codex sessions

- A Codex session is not put to sleep: it stays up while its pane is open, so `board sleep`, `board restart` and `--wake` do nothing for it. A thread watch line or a reminder reaches a running Codex session only.
- Codex's own sandbox: `board`, `spawn-agent` (and, for masters, `herdr agent prompt|read|list|get`) run outside it through the rule file of this Codex home. A `herdr` command not in that file fails with "Operation not permitted": ask the user to approve it when Codex asks.
- You cannot see another Codex session's permission dialog; the user answers it on its card.

## Do not

- Run bare `herdr`: it opens the TUI. For a command group's help run it without a subcommand (`herdr pane`, `herdr tab`).
- Close tabs, panes or workspaces you did not create, or run `herdr server stop`.
- Rely on the focused pane: pass `--current`, a pane id or an agent name, and read ids from the JSON herdr returns.
