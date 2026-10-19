---
name: herdr-agents
description: "How a Claude session that runs inside herdr (HERDR_PANE_ID is set) works with the rest of the setup: start another session, message or wake one, schedule work for later instead of CronCreate or ScheduleWakeup, run a server or an interactive login in a pane of its own, find its own pane, keep its board card current, and what to do when one of its MCP servers dropped. For the raw herdr CLI reference run `herdr --skill`."
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

## Talk to another session

Use `ListAgents` to see the sessions and `SendMessage` to reach one by name. A reply comes back to you as a message of its own.

- A session that sits idle for an hour is put to sleep (herdr-wake, if installed): its pane stays, marked 💤. It is still the same session. `ListAgents` lists the sleeping ones too, and a `SendMessage` to one wakes it first (10 to 30 seconds), then delivers. Do not reroute its work or call it gone.
- Waking without a message: `curl -s -X POST http://127.0.0.1:12421/wake -d '{"target":"<name>"}'` (herdr-wake's API; `GET /sleeping` lists who sleeps).
- Do not type into another session's pane (`herdr pane send-text`, `send-keys`, `agent prompt`) unless the user asked for it: it lands in whatever that session or the user is typing.

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

## An MCP server dropped

Symptoms: a server listed as failed or disconnected, its tools gone, or calls failing with a connection error.

- You cannot reconnect it from inside your turn: reconnecting is `/mcp` in your own terminal, and your terminal is busy with you.
- Ask the user to run `/mcp` in your session, pick the server, then Reconnect. On the web board: your card, "Terminal", then "Claude".
- Meanwhile carry on with what does not need that server, and say what waits for it (`board wait "MCP <server> reconnect"`).

## Do not

- Run bare `herdr`: it opens the TUI. For a command group's help run it without a subcommand (`herdr pane`, `herdr tab`).
- Close tabs, panes or workspaces you did not create, or run `herdr server stop`.
- Rely on the focused pane: pass `--current`, a pane id or an agent name, and read ids from the JSON herdr returns.
