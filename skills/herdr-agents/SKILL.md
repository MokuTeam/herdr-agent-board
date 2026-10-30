---
name: herdr-agents
description: "How a Claude session that runs inside herdr (HERDR_PANE_ID is set) works with the rest of the setup: start another session, message or wake one, put the sessions it coordinates to sleep in one call (itself too, once its run is over), schedule work for later instead of CronCreate or ScheduleWakeup, restart itself (an MCP server dropped, settings, hooks, skills or MCP config changed, the session acts up), run a server or an interactive login in a pane of its own, find its own pane, keep its board card current. For the raw herdr CLI reference run `herdr --skill`."
---

<!-- agent-board: installed by the agent-board plugin's install action; it replaces this file on updates. -->

# Working inside herdr

## Am I in herdr?

herdr gives every pane its context in the environment, and Claude Code and its shell inherit it:

```bash
echo "$HERDR_ENV $HERDR_PANE_ID $HERDR_TAB_ID $HERDR_WORKSPACE_ID"   # 1 wP:p8 wP:t4 wP
```

No `HERDR_ENV=1`: you are not in herdr (a plain terminal, the cloud, `claude -p`). Then none of this applies; do not drive herdr from outside it.

`HERDR_PANE_ID` is your own pane. herdr's name for you: `herdr agent get "$HERDR_PANE_ID"`.

## Your board card

The agent-board hook told you at the start how to keep your card current (`board cat`, `doing`, `ask`, `wait`, `done`). `board` with no arguments shows the card, `board list` every session on the board, `board doctor` what is set up on this computer.

## Start another session

```bash
spawn-agent --name <Name> --cwd <folder> [--label "<tab label>"] [--brief-file <utf-8 file> | --brief "<text>"] [--workspace <herdr workspace id>]
```

PowerShell-style names work too (`-Name -Cwd -Label -BriefFile -Brief -Workspace`). It opens a tab, starts Claude the way this computer is set up to (`launch.claude` in the board's config), names the session in Claude and in herdr, sends the brief and prints `pane=<id> name=<Name> agent=<herdr name>`. The board links the two sessions by that line.

- `--workspace` takes the workspace id (`wP`), not its label. Without it the session lands in your workspace.
- Put a long brief in a UTF-8 file: quoting a long text on a command line breaks.
- Do not start Claude with `herdr agent start --kind claude` or a bare `claude` in a pane: it gets no name, no brief, and the permission mode and launcher this computer uses are skipped.
- A new folder may show Claude's "trust this folder" dialog: spawn-agent stops and says so; the user answers it in that tab.
- A one-off session that has finished can be taken off the board with `board archive --session <name>` (its tab closes; the user can bring it back from the board's archive), but only one you started, or when the user asks. Its board reminders wait with it, parked: `board schedule --session <name>` lists them, `board schedule --move <id>` moves one to you, `board unschedule <id>` removes one.

## Talk to another session

Use `ListAgents` to see the sessions and `SendMessage` to reach one by name. A reply comes back to you as a message of its own.

- A session that sits idle for an hour is put to sleep (herdr-wake, if installed): its pane stays, marked 💤. It is still the same session. `ListAgents` lists the sleeping ones too, and a `SendMessage` to one wakes it first (10 to 30 seconds), then delivers. Do not reroute its work or call it gone.
- Waking without a message: `curl -s -X POST http://127.0.0.1:12421/wake -d '{"target":"<name>"}'` (herdr-wake's API; `GET /sleeping` lists who sleeps).
- Putting sessions to sleep that you coordinate: see the next section, one call for all of them.
- Do not type into another session's pane (`herdr pane send-text`, `send-keys`, `agent prompt`) unless the user asked for it: it lands in whatever that session or the user is typing.

## Put the sessions you are done with to sleep

A session that coordinates others (it starts them, polls them, collects their results) puts the ones it is done with to sleep in one call, not with a herdr-wake `/sleep` for each:

```bash
board sleep Report-north Report-south "Name with spaces"
board sleep --when-free Report-north Report-south
```

- It takes session names, panes or session ids. Every one that is free now goes to sleep at once, and you get a line for each: `asleep`, `asleep already`, or `kept up, <why>` (working, a dialog waits for an answer, unsent text in its input box, background tasks run, herdr-wake refused, not a Claude session, no such session on the board, or a name several sessions go by: then give its session id or pane).
- `--when-free`: the ones that are busy now go to sleep once they are free, instead of staying up. Use it for a session you just sent its last message, which is still working on it. Its line gives the board entry's id; `board unschedule <id>` cancels it.
- Only sessions you started, or that the user asked you to put to sleep. A session kept up by unsent text or a dialog is waiting on the user: leave it, or tell the user.
- Yourself: `board sleep --self` (alone, or after the others' names), then end your turn. This session goes to sleep once the turn is over and it is free; a dialog, unsent text in its input box or a background task (a background command, a Monitor) keep it up meanwhile, for up to four hours, after which the entry is dropped without a word to you. A new turn (the user writes to you meanwhile) does not cancel it: you go to sleep once that turn is over. Its line gives the entry's id; `board unschedule <id>` cancels it. Not by default: only when the user asks, or when you coordinate others and your run is over, with nothing left that waits on you.
- A sleeping session is not gone: `SendMessage` or a board reminder wakes it again.
- pi sessions go to sleep the same way, by name, pane or session file, where the board's own wake runs: pi and everything it started stop, and its card stays on the board, sleeping. A message or a reminder from the board wakes it on the same conversation and account (in a new tab of its workspace if its pane is gone). With the separate herdr-wake plugin they stay up (`not a Claude session`).
- Without herdr-wake, `board sleep` says so and puts nothing to sleep.

## Do something later

```bash
board remind in 30m "check the CI of PR 12 and merge it if green"
board remind tomorrow 9:00 "send the weekly report" --idle
board every "0 9 * * 1-5" "look at the overnight alerts"
board schedule            # this session's entries
board unschedule <id>
```

At that time the board types `[board reminder] <text>` into this session as a prompt, waking it if it sleeps. Write the text as an instruction to yourself. By default it arrives on time, queued into a running turn; `--idle` waits until the session is free.

Prefer it to `CronCreate` and `ScheduleWakeup` for anything due later than a few minutes: those live in this Claude process and die when the session is put to sleep or restarted; the board's entries survive both.

## Run something the user should see or answer

Your own shell tool is the right place for ordinary commands. A pane of its own is for what must outlive your call or needs the user: a dev server, a watcher, an interactive login (`gh auth login`, `bw unlock`).

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus   # .result.pane.pane_id
herdr pane run <pane> "npm run dev"
herdr pane wait-output <pane> --match "ready" --timeout 120000
herdr pane read <pane> --source recent-unwrapped --lines 120
```

Split right when your pane is wide, down when it is narrow. For a login, tell the user which pane waits for them; on the web board they can also open "Terminal" on your card. Close only the panes you created.

## Restart yourself

```bash
board restart "MCP slack dropped; I was drafting the reply to the release thread, next: post it"
```

Then end your turn. Once it is over and the session is free (no dialog, nothing the user started typing, no background command), the board has herdr-wake put this session to sleep (`/exit`) and wake it in the same pane (`claude --resume`: the same session, the same conversation). Claude Code then starts every MCP server again and reads settings.json, hooks, skills and CLAUDE.md anew. The board types `[board reminder; restarted as you asked] <your note>` into it, so you carry on by yourself. Write the note as an instruction to yourself: what you were doing, why you restarted, what comes next. Without one you get "Carry on."

When it helps:

- An MCP server dropped (below).
- You changed settings.json, a hook, a skill, CLAUDE.md or an MCP server's config, and this session needs it: Claude Code reads them only when it starts.
- The session acts up: tools hang or time out, a hook misfires, the terminal looks broken.

What it ends: everything that lives in this Claude process. Background agents and workflows, teammates, `CronCreate` and `ScheduleWakeup` jobs die with it; a background Bash command or a `Monitor` holds it instead (the board waits for them, 10 minutes at most). Finish or stop them (`TaskStop`) before you ask, and put anything due later into `board remind`. The conversation, your card and the board's schedule stay.

- When it does not happen (herdr-wake refused three times, background tasks ran for 10 minutes), the board types `[board reminder] restart did not happen: <why>. Your note for after it: <note>` once you are free.
- `board restart` says at once when herdr-wake is not there or does not answer, and schedules nothing. Then ask the user to restart you by hand: `/exit`, then `claude --resume <session id>` in the same pane.
- `board schedule` shows it while it is on its way, `board unschedule <id>` cancels it. Asked again before it happens, it is still one restart, with the newer note.
- `--session <name>` restarts another session, once that one is free; its prompt says who asked.

## An MCP server dropped

Symptoms: a server listed as failed or disconnected, its tools gone, or calls failing with a connection error.

- Restart yourself: `board restart "MCP <server> dropped; I was <doing what>, next: <what>"`, then end your turn. On start Claude Code connects every MCP server again; that is the reliable way back.
- After the restart, check that its tools are there (`ToolSearch` with the server's name). One that is still connecting can take a few seconds more; one that fails again is broken on its side, not in this session: say so to the user.
- Do not try to drive the `/mcp` menu yourself: your terminal is busy with you, and keys typed into a menu land in the wrong place easily.
- Without herdr-wake (`board restart` says so): ask the user to run `/mcp` in your session and Reconnect the server (on the web board: your card, "Terminal", then "Claude"). Meanwhile carry on with what does not need it, and `board wait "MCP <server> reconnect"`.

## Do not

- Run bare `herdr`: it opens the TUI. For a command group's help run it without a subcommand (`herdr pane`, `herdr tab`).
- Close tabs, panes or workspaces you did not create, or run `herdr server stop`.
- Rely on the focused pane: pass `--current`, a pane id or an agent name, and read ids from the JSON herdr returns.
