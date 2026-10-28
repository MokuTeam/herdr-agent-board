# agent-board

A [herdr](https://herdr.dev) plugin: a kanban of the Claude Code sessions running in herdr, and
of the [pi](#pi) and [Codex](#codex) ones.
Lanes are categories (one per client, say, plus Personal and Other), columns are Working /
Needs me / Waiting on others / Done / Idle. Sessions put to sleep
([Sleep and wake](#sleep-and-wake)) are on it too (one line, `z`). In English and Russian; see
[Language](#language).

No model runs for the board. It reads herdr's snapshot, Claude's session registry and the tail
of each transcript (ai-title, last prompt), wake's `/sleeping`, and the cards. A card is
what only the agent knows: its category, what it works on, what it waits for. Agents keep it
current with the `board` command; a SessionStart / UserPromptSubmit hook tells each session how.

## Setup

[Bun](https://bun.com/docs/installation) 1.4.3 or newer. `herdr plugin install` runs
`bun install --production` (react and react-dom, and for the quick look's viewers pdfjs-dist,
mammoth, DOMPurify and SheetJS's `xlsx`, which comes from SheetJS's own server, cdn.sheetjs.com:
its only dependencies); after `herdr plugin link`, run `bun install` in the folder yourself, again
after an update that adds one (without them, the quick look shows a PDF in the browser's own viewer
and has no preview for a Word document or a spreadsheet). Windows, Linux and macOS (desktop
notifications: Windows only). Steps 1 and 2 are what the board needs; the rest adds to it.

1. **The plugin and its install** (required).

   ```sh
   herdr plugin install MokuTeam/herdr-agent-board   # or clone it and: herdr plugin link <folder>
   herdr plugin action invoke agent-board.install
   ```

   The install puts two commands into `~/.local/bin` (a sh script for Git Bash, Linux and macOS,
   a `.cmd` for PowerShell): `board`, which agents keep their cards current with, and
   [`spawn-agent`](#spawn-agent), which starts a session in a new herdr tab. It registers the
   Claude Code hooks (SessionStart, UserPromptSubmit) that brief every session about the board,
   and the status line when you have none (usage windows and context fill on the board). It
   installs the Claude Code skill [`herdr-agents`](#agents) into `~/.claude/skills`, and has herdr
   install its own Claude hook (`herdr integration install claude`), from which herdr learns which
   conversation a pane runs; a herdr that cannot is said, and the rest goes on. It replaces only
   its own entries in `~/.claude/settings.json`, keeps a copy of the file before
   (`settings.json.bak-agent-board`), leaves a command of someone else's name alone, and ends with
   the check below. `~/.local/bin` must be on PATH. Run it again after the plugin moved or was
   updated, or Bun moved: the hooks and the commands point at the plugin's folder and run the Bun
   that ran the install action.

   With more than one Claude profile (`CLAUDE_CONFIG_DIR` folders such as `~/.claude-work`) it
   does the same in the `settings.json` of every profile the board shows, each with its own
   backup, puts the skill into each one's `skills` folder and has herdr put its hook there
   (`CLAUDE_CONFIG_DIR` set to that folder); a hidden profile is left alone,
   and a shown one whose folder is gone is skipped, saying so. One `settings.json` that does not
   parse stops it before anything is written. It never touches credentials, `.claude.json` or
   anything else in a profile folder beyond `settings.json`, its backup and
   `skills/herdr-agents` (herdr writes its own `hooks/herdr-agent-state.ps1` and its entry). A
   profile shown later in the Profiles panel gets its hooks, the skill and herdr's hook then and
   there; the install action run again, or Install in that panel, puts them in too.

   A session brought back from the archive runs in its own profile again, hidden or not, never in
   another: the one its card reports (or, on a card from before profiles, the only profile
   shown), its conversation looked for in that profile's folder only. It stays in the archive,
   saying why, when the board cannot be sure: that profile is no longer listed, the card does not
   say its profile while more than one is shown, the session ran in another profile than its
   start asked for, or its conversation is in another profile's folder. A MokuPilot call is still
   refused outside the board's own profile ([Web board](#web-board)). With `~/.claude` alone
   nothing changes.
2. **A key** (recommended), in herdr's `config.toml` (`%APPDATA%\herdr\config.toml` on Windows,
   `~/.config/herdr/config.toml` elsewhere), then `herdr server reload-config`. Without it the
   board opens with `herdr plugin action invoke agent-board.open`.

   ```toml
   [[keys.command]]
   key = "prefix+a"
   type = "plugin_action"
   command = "agent-board.open"
   description = "agent board"
   ```

3. **How Claude starts** (optional). New sessions from the board and from `spawn-agent` start as
   `claude` in a new tab. `launch.claude` in the board's config.json changes that: say
   `["claude", "--dangerously-skip-permissions"]` (your call: Claude then runs every tool without
   asking), a model, or a launcher of your own, such as tg-mcp's
   [`claude-tg`](https://github.com/Eithery-rc/tg-mcp#herdr-launcher), which gives each herdr tab
   its own Telegram topic. See [New sessions](#new-sessions). Working in [pi](#pi)? With `pi` on
   the board's PATH the "New session" window offers Claude Code or pi; `"default": "pi"` in
   `launch` makes pi the one it starts on. `"linkedWorkspaces": true` in `launch` turns on the
   ticket setup: a workspace is linked through `herdr worktree` for any git checkout, a new worktree
   goes under `<parent>/<repo>-wt/<ticket>` beside the main checkout (even when started from another
   worktree) and branches from the checkout that was picked, and a ticket's session is named
   `case-<n>` (Jira keys lower-case). Off by default, so every other setup starts as it did.
4. **Sleep and wake starts with the board** (nothing to install or run). It puts sessions to sleep
   and wakes them: "Put to sleep", "Wake" and "Restart" on the board, `board sleep` and
   `board restart` (agents restart themselves with it, see [Restart](#restart)), sleeping sessions
   on the board, and reminders that wake a session, in every Claude profile. It runs on Bun in a
   pane of its own, in a `Wake` workspace, and listens on 127.0.0.1 only. By itself it does
   nothing: no session is put to sleep, woken or typed into until someone acts. Putting sessions
   that sat idle for an hour to sleep, and bringing your Telegram messages to them with
   [tg-mcp](https://github.com/Eithery-rc/tg-mcp), are switches in Settings → "Sleep and wake…",
   off until you turn them on. The install puts its two Claude Code hooks (ListAgents and
   SendMessage) into each shown profile. `"wake": false` in the board's config.json turns all of
   it off. With the separate herdr-wake plugin installed, the board leaves the work to it until
   you click "Switch over…". See [Sleep and wake](#sleep-and-wake).
5. **Desktop notifications** (optional, Windows): `herdr plugin action invoke
   agent-board.notifications`. See [Notifications](#notifications).
6. **Lanes**: "Categories" on the web board (titles, colors, the folders that sort sessions into
   each lane), or let the agents add them.

`board doctor` (or `herdr plugin action invoke agent-board.doctor`) says what is set up and what
is not, what each missing piece costs and how to fix it: the commands (and whether PowerShell or
Git Bash finds someone else's of that name first), the hooks and the status line (and whether they
run this copy of the plugin; with more than one profile shown, in each, by its name), herdr's own
Claude hook (in each shown profile too: without it a session's card has no conversation and no
profile), the key, sleep and wake (running, off, crashed with its error, held by the separate
herdr-wake plugin, or not answering, and its hooks in each shown profile), how new sessions start,
MokuPilot, the notifications. The web board says it too, quietly: "Setup incomplete" in its
toolbar while something the board needs does not work (see [Web board](#web-board)).

Back to `main` (the Node version): its install action does not know this one's entries and
would leave them beside its own. First take them out of `~/.claude/settings.json`: the
`SessionStart` and `UserPromptSubmit` hooks that run `src/entrypoints/hook.ts`, the
`statusLine` that runs `src/entrypoints/statusline.ts`, and the notification hooks that run
`src/integrations/toast.ps1`. Then put `main` in the plugin's folder and run its install action
again, which writes its own `node "…/src/hook.mjs"` hooks, status line and commands.

## Codex

For panes herdr reports as `codex`, the board reads the rollout in
`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<session-id>.jsonl` (`CODEX_HOME` changes the
Codex folder). The card shows the last prompt, the agent's last words, its last tool and its
request's input tokens; the session panel shows the conversation and tool calls. Duplicate
events, instructions, reasoning and tool outputs are left out. A missing or unreadable rollout
leaves the card and live terminal available. The board reads bounded tails and caches card data
until the file changes.

To install the board's Codex hooks and the `board` command, run from this checkout:

```sh
bun src/entrypoints/install.ts --codex
```

This adds SessionStart and UserPromptSubmit to Codex's `hooks.json`, preserving herdr's and other
hooks, with the first `hooks.json.bak-agent-board` kept beside it. It also asks herdr to install its Codex identity
hook. Hook commands use `bun` from PATH (including on Windows); keep Bun on PATH. Empty hooks files
are treated as new configurations; malformed JSON stops the install before anything is written. The ordinary install
without `--codex` keeps managing Claude only.

New hook commands carry `--herdr-agent-board-hook`, so reinstalling after moving the checkout
replaces the board's previous hooks even when the folder has another name. Older unmarked hooks
at unknown paths are preserved because ownership cannot be proved; review those old commands
when moving an installation. Unrelated hooks and shell wrappers are never replaced just because
their text mentions the board's script.

Enable hooks if disabled (`codex features enable hooks`) and review and trust the new definitions
in Codex's `/hooks`. The board does not change Codex's configuration or hook trust. In a pane herdr
reports as this Codex session, SessionStart supplies the card brief; UserPromptSubmit clears a
question the user answered and a pinned column, and reminds the agent when its card says it waits.
A board reminder preserves the question. A start that races herdr's identity hook receives its
brief on its first prompt instead. A Codex child or a session outside herdr gets no brief or card
write from these hooks. The brief names `board --session <id>` so a tool's shell can update the
correct card even without the pane environment. Without an explicit target, `board doing`,
`ask`, `wait`, `done` and `cat` use the pane's reported Codex identity, even
when the environment still carries a parent Claude session id.

For mixed environments the root Codex hook records the Claude id it inherited. A Claude child
has a different id and keeps its own Claude card, even in the same Codex pane and while herdr is
offline. Before that hook record exists, mixed environments keep Claude priority: use the
explicit `board --session <id>` form for Codex. A Codex child under a Claude root still inherits
that root's card as before; it must use an explicit target when coordinating a different card.

To remove these hooks, delete only the command handlers running `src/entrypoints/codex-hook.ts`
from SessionStart and UserPromptSubmit in Codex's `hooks.json`; remove an enclosing matcher group
only if it is then empty. Keep herdr's and other handlers. Do not restore the whole backup over
hooks installed later. The shared `board` and `spawn-agent` commands can stay for Claude.

Codex session actions follow separately under [#126](https://github.com/MokuTeam/herdr-agent-board/issues/126).
Claude Code and pi keep their existing hooks, brief and readers.

## Web board

The terminal board also serves a web board at http://127.0.0.1:12422 (loopback only; POSTs
need an `X-Board` header, so no other site can type into a session). Open it with `o` on the
terminal board or `herdr plugin action invoke agent-board.web`: an Edge app window of its own,
raised when it is already open.

To land on one session, from a desktop notification's click handler (the board's own
[notifications](#notifications) do this) say: `bun src/entrypoints/web-open.ts --pane <herdr pane id>`.
The board's window comes up and opens that session's sheet (a page in a minimized or covered window
is told as it connects again, within 15 s); with no board window, a new one opens on it
(`#session=<key>` in its address). It does not start the board: exit code 3 means the board does not
run or has no session in that pane, so the handler can go to the pane in herdr instead. The same
goes to the board as `POST /api/reveal` with `{ "pane": "<id>" }` or `{ "key": "<session>" }`.

- Lanes by category, columns by state, live over Server-Sent Events. A column with no card on
  show narrows to its head (name and count) and the others share its room, gliding as it fills
  or empties.
- One compact toolbar row: the title with the board's summary under it while the row has room
  (else in the title's tooltip), the lanes, search, categories and the schedule as small buttons
  named by their tooltips, and Settings (the gear). A narrower window takes two rows, a phone
  three. Where the row has no room for all of the lanes, they fold into one pill naming the lane
  on show with its count; it opens every lane, with its count, in a menu. The profile switch
  folds the same way, on its own.
- Settings (the gear): appearance (as the system has it, light or dark; kept in this browser),
  style (Classic, the board's own, or Terminal: a terminal-style look with a One Dark palette,
  One Light in the light theme, monospace and 1px outlines, and the terminal board's keys, see
  [Board keys](#board-keys); kept in this browser too, and config.json's `look` makes it the
  one a browser starts in), card text ("Cut short", as it always was, or "Wrap" for a narrow
  column or a phone: a card's name shows whole on as many lines as it takes, its profile, clock
  and age going under it when there is no room beside it, and what it does, asks, waits for and
  said last gets up to three lines; in either style, kept in this browser), language, where the
  session panel sits, whether sleeping sessions show, and "Sleep and wake…" ([Sleep and wake](#sleep-and-wake); read only on a phone). On a
  computer with [Omarchy](https://omarchy.org), the Terminal style takes the colors of
  the Omarchy theme on now (mixed from its `colors.toml` as Omarchy's own apps take theirs) and the
  system's monospace font, and follows a theme switch while the page is open; in the theme's other
  mode (a light page for a dark theme) it keeps One Light / One Dark.
- A card says what the session works on (its own `board doing`, else Claude's title of the
  session, else "You: <your last request>"), its last words, the tool it runs now, the question
  it is stuck on, what it waits for.
- Drag a card to another lane to change its category, or to another column to put it there by
  hand (also the status pill in the sheet's head). See [Moving a card by hand](#moving-a-card-by-hand).
- Click a card: a sheet with a compact head (two pills, where the card shows and its lane, each
  opening a menu to change it; the name; its workspace, last activity and context; then what it
  does, what it waits for, its reminders and the sessions it works with, each only when there is
  one; the pencil offers empty fields as one quiet "Add" row, and the reminders show the next one
  with a count that opens the rest in place), the question and screen when it waits for
  you (a question form or a permission prompt is answered right there, see
  [Answering from the board](#answering-from-the-board)), the conversation (tool calls folded;
  a background command, agent, monitor or MCP task reporting back and a board reminder are a
  quiet line of their own, not your message: an agent's report opens from it, a command's
  "Output" opens its output file), a message box under a row of actions (as many as the panel's
  width holds, the most used first, the rest under "⋯"): "Go to herdr" (focuses the pane and
  brings the terminal window up), "Put to sleep" (through wake, idle sessions only; also
  the moon on a card), "Wake" for sleeping sessions, "Restart" (also in a card's menu) for one
  that lost an MCP server or acts up, see [Restart](#restart). To close: click the board beside
  it, flick it out the way it came, or Esc. Another card switches it to that session.
  Attachments stay with their session through a close.
- "MokuPilot", a call (the sheet, a card's menu), when [MokuPilot](https://github.com/MokuTeam/MokuPilot)
  is on this computer: a MokuPilot call starts at once, its agent a fork of the session
  (`claude --resume <id> --fork-session`, in the folder the session started in), so it knows what
  the session knows while the session itself stays as it was. The board runs MokuPilot's launcher
  with `call --claude-session <id> --cwd <folder>`; a running MokuPilot takes it over. Found by
  itself (`MokuPilot.exe` where its installer puts it, else `meet` on PATH, `meet.cmd` standing
  for its checkout) or set in [Settings](#settings) as `mokupilot`. Once its protocol is ready,
  MokuPilot sends the call's results back with `board call-report`: the session gets them once it
  is free (woken if it sleeps), for its information, as `[mokupilot call report]`, the report, and
  a note not to start work on it unless you ask; its conversation shows "MokuPilot call results"
  as a quiet line that opens to the report, its paths (the full protocol, the transcript) as file
  chips. With more than one Claude profile, a call goes only from a session in the board's own
  profile (the one its `CLAUDE_CONFIG_DIR` points to): a running MokuPilot takes the call over in
  its own env, so a fork of a session in another profile would run in the wrong account. The board
  refuses that call before anything starts, saying so.
  Where the call starts is Settings → MokuPilot… (shown while the board offers calls):
  - **Auto** (the default): looking at the board on its own computer, the call starts there;
    from any other computer (through `tailscale serve`, your own domain, the remote mode), on
    the one you look from, by the link below. The board decides by the request: behind a proxy
    on its own computer (the peer is 127.0.0.1) the caller is `X-Forwarded-For`'s last address,
    else the peer; the board's own computer is a loopback address or one of its own (its LAN and
    Tailscale ones). The panel says where a call from your browser would start right now, and
    the call's answer says it too (`resolved`, `why`), so a wrong guess shows.
  - **This machine**: the board starts MokuPilot on its own computer, whoever asks; MokuPilot
    must be installed there (the setup check marks it when it is not).
  - **The computer you're viewing from**: nothing starts on the board's computer, and MokuPilot
    need not be installed there. The button opens
    `mokupilot://call?claude-session=<id>&cwd=<folder>` in your browser; the MokuPilot there
    (with "agents on another machine" turned on and this board's ssh address) asks you, takes
    the call and runs the fork on the board's computer over ssh. A phone, or a computer without
    that MokuPilot, has nothing for the link: the board stays as it was.

  The button is offered under Auto and The computer you're viewing from whether MokuPilot is on
  the board's computer or not (under Auto, a call asked at the board's computer without it says
  so and points to the panel); under This machine only with MokuPilot found there. Settings →
  MokuPilot… is always offered, so the mode can be changed in every case; with
  `"mokupilot": false` the panel says calls are off.
- "Fork" (the sheet, a card's menu): a new session in a new tab that starts with a copy of this
  one's conversation, so it knows what this one knows while this one goes on as it was; see
  [Fork](#fork).
- A side question (the bubble in the message box, or a message that starts with `/btw`): typed
  into the session as Claude Code's own `/btw`, answered in a card over the box, while nothing
  goes into the session's conversation; see [Side questions](#side-questions).
- The sheet's place and size are the viewer's own (kept in this browser): docked right, left or
  at the bottom, flush with that edge like a sidebar, where the board makes room for it (a window
  too narrow for that keeps the board's columns and lays the sheet over them), or floating over
  the board as a window of its own. The button in its head or Settings picks the place; or pull
  the sheet by its head until it comes loose and carry it to an edge: within a tenth of the
  window of it a preview shows where it lands, holds steady there, and that is where it goes. Its inner edge resizes it (double-click: the default
  size; arrow keys once it has focus; flung narrower than half the smallest size, it folds
  away); a floating one moves by its head and resizes by any edge. Wide and low (at the
  bottom), it shows the card on the left and the conversation on the right. "Categories" opens
  in the same place. On a phone it stays the full-height sheet.
- `/` search, Esc closes. Light and dark, reduced motion and transparency respected.
- "Setup incomplete" in the toolbar, quietly, while something the board needs does not work on
  this computer (the checks of `board doctor`, run when the board starts and every 10 minutes).
  It opens the list: what is set up, what is not, what each missing piece costs and how to fix
  it, with the commands to copy. Optional parts that are off (sleep and wake turned off,
  notifications) are listed but never raise it. "Hide until something changes" puts it away until
  the problems are other ones. Sleep and wake on but not running for more than a minute has a
  quiet note of its own, "Wake stopped", which opens Settings → "Sleep and wake…".
- The sheet's thread renders Markdown (headings, lists, tables, code, quotes, links; escaped,
  links http(s) only). Files and screenshots go with a message: the clip, Ctrl+V, or a drop on
  the panel. They upload to `%LOCALAPPDATA%\herdr\plugins\agent-board\uploads\<day>\` (kept 14
  days, `keepUploadsDays`) and the message carries their paths; Claude reads them, images as
  images. Sent images show as previews in the thread.
- A message sent while the session works shows at once at the foot of the thread, quietly, as
  "Queued" until Claude takes it in, then as an ordinary message where it landed; one pulled
  back to the input box in the terminal goes. The queue is read from the transcript (Claude
  Code logs it there), so messages typed in the terminal show too, and a reload keeps them. A
  message that could not be sent stays with the reason, "Retry" and "Edit".
  Before sending to Claude, the board checks for its input box on the visible terminal screen,
  even when herdr reports idle or done. A dialog or an unrecognized screen refuses the send;
  the text stays in the failed message and its saved draft. Resolve the dialog in the terminal,
  then retry explicitly. The board does not dismiss it or resend automatically.
- Files, folders and links in the thread. A path an agent writes (absolute, `~/...`, a
  `herdr-reveal:` or `file:` link, or relative to the session's folder in `code`, with an
  optional `:line`) becomes a chip once the board finds it on disk; file tool calls in the
  folded runs open the same way. A chip opens a quick look over the board, grown out of the
  chip: images, PDF, Word documents and spreadsheets, video and audio, Markdown (rendered or
  source), code and text with line
  numbers (the `:line` lit and scrolled to), JSON pretty, CSV and TSV as a table (`,` `;` tab or
  `|` between fields, UTF-8 or Windows' old code page as Excel saves it, quoted fields with line
  breaks, up to 20 000 rows drawn as they scroll into view), folders as a list to
  walk through (the path bar goes up; Backspace goes back). From there: open it with the
  system, show it in its folder, copy the path. Esc closes it. Web links open in the default
  browser.
- A PDF in the quick look is drawn by the board itself, so a phone's browser and the installed
  board show it too: its pages fit the width and are drawn as they come into view, their text can
  be selected, a badge says which page while it scrolls and the footer how many. They zoom with
  Ctrl+wheel or a trackpad pinch, two fingers on a phone, `+` `-` `0` (fit) and the footer's
  button; the arrow and page keys scroll. A broken or password-protected PDF says so, beside the
  button that opens it with the system.
- A Word document (`.docx`) shows as a page of its text: headings, paragraphs, lists, tables,
  pictures, footnotes and web links (opened in the default browser); fonts, colors and page
  layout are left out. A spreadsheet (`.xlsx`, `.xlsm`, `.xls`, `.ods`) shows each visible sheet
  as a table, the sheet names as tabs below: values as Excel shows them, numbers and the short
  date in the board's language, merged cells, the rows Excel keeps frozen held at the top, up to
  20 000 rows drawn as they scroll into view. Both are read in a worker, so a large one does not
  stop the page; one over 20 MB (a document) or 10 MB (a spreadsheet), broken or with a password
  says so, beside the button that opens it with the system.
- Images and SVG in the quick look zoom as in Preview and Photos: Ctrl+wheel or a trackpad
  pinch, two fingers on a phone, a click (a double-tap) zooms in to 100% at that spot and a
  double-click goes back to fit, `+` `-` `0` (fit) and the arrows from the keyboard. A zoomed
  image drags 1:1, glides on after a flick and gives at its edges; a plain wheel moves it. Up to
  800% (an image pixel over three device pixels shows as a crisp square); the footer shows the
  scale and a button in to 100% or back to fit. Each opening starts fitted.
- "Categories" (or a click on a lane title): rename, recolor, add or remove the folders that
  sort sessions into the lane, create, delete (two clicks; its sessions fall back to the folder
  guess), drag rows by the handle to reorder lanes. Written to config.json at once.
- A clock on a card: the session has something scheduled, with the soonest time (orange while a
  due one waits for the session to be free). The sheet lists its next three; "Schedule" on the
  toolbar shows every entry by day, then what was sent or missed lately. The trash can cancels
  an entry (two clicks). See [Schedule](#schedule).
- "New session" (the toolbar, a lane's +, "New session here" in the sheet, the menus, Shift+N):
  a window for a new Claude session in herdr. See [New sessions](#new-sessions).
- "Terminal" in the sheet (a card's menu, Ctrl+` with the sheet open): a live shell in the
  session's folder, or the session's own terminal, to type into from the board. See
  [Terminal](#terminal).
- "Archive" (a card's menu, the sheet; "More actions" on a phone) takes a session off the board:
  its tab in herdr closes, Claude keeps the conversation, and Return brings it back. The menu of
  the "Idle" column (or a lane's) takes the sleeping ones at once. "Archive" on the toolbar lists
  them, with a search. See [Archive](#archive).
- Helpers and sessions working together: a card says when subagents, forks, workflow agents or
  teammates of its session are at work, and which session started it; the sheet lists the
  helpers, and each one's own conversation opens live. See
  [Helpers and linked sessions](#helpers-and-linked-sessions).
- Right click (or a long press on a touch screen, or the menu key / Shift+F10 on a focused card)
  opens the board's own menu: on a card (open, go to herdr, message, wake or sleep, rename, move
  to a category, status, "No reply needed", open its folder, Changes, History, a new session in
  its folder, copy its name, folder, session or pane id, archive it, clear the card), on a lane
  (a new session or workspace there, edit the category, show only it, archive its sleeping
  sessions), on the "Idle" column's head (archive the sleeping sessions), on the board, on the
  sheet's head, on a starting session and on file chips. It opens where you clicked, stays on screen,
  takes arrows, Enter, Esc and the first letters of an item. Gray items say why (no fresh data
  from herdr, the session works). Fields, selected text and links keep the browser's own menu;
  Shift+right click always gives it.
- Rename a session where its name is: "Rename" in its menu, F2 on the card, or a click on the
  name in the sheet's head. Enter keeps it, Esc puts it back, an empty name gives the automatic
  one back. The name is the board's (`name` on the card), shown on both boards and found by the
  search. "Rename in Claude and herdr too" also types `/rename <name>` into the session and
  gives its herdr agent the same name, so other sessions and wake see it: only when ticked,
  and only while the session is idle (not working, not asleep).

## Claude profiles

Claude Code keeps its account, settings and sessions in a config folder: `~/.claude`, or the one
`CLAUDE_CONFIG_DIR` names. With one folder per account (`~/.claude-work` for work, say), the board
shows the sessions of all of them, each with its profile, and starts a session in the profile you
choose. It never guesses: when it cannot be sure of the profile, it refuses and says why.

**What it finds.** `~/.claude`, the folder the board's own `CLAUDE_CONFIG_DIR` points to, and
every `~/.claude-<name>` folder with a `settings.json`, a `projects/` or a `sessions/` in it
(Claude ran in it; a `<name>` with a dot, such as `work.bak`, is none). It keeps them in config.json
as `profiles`, each with an `id` from its folder (`~/.claude` is `default`, `~/.claude-work` is
`work`), a `title` ("Default", "Work"), its folder (`dir`), a `color`, `hidden`, and, if you like,
`command` (its start command, below) and `args` (more Claude arguments for the sessions the board
starts in it). `~/.claude` and the board's own folder come in shown (`~/.claude` only while it has
a `settings.json` or a `projects/`, when the board's own is elsewhere: a teammate whose
`CLAUDE_CONFIG_DIR` names another folder keeps one profile), any other folder hidden, so a backup
or a test folder changes nothing on the board. Renaming a profile, or giving it another color,
never changes its id or its folder.

**One profile shown** (a teammate's board, and yours until you show a second): no profile switch,
no profile choice for a new session, no `--env` on a start, and no tag on a card but the three
below that warn: the board is as it was before profiles, unless you give its profile a start
command. Settings has "Profiles…" once the board finds more than one profile folder.

**The Profiles panel** (Settings → Profiles…), built like Categories: a row per profile with its
color, its name (Enter or leaving the field keeps it, Esc puts it back), its folder, its sessions
now, Shown or Hidden (one stays shown), and its "Start command" (Enter or leaving the field keeps
it, Esc puts it back, empty clears it; its placeholder is what is typed without one, `claude` or
`launch.claude`'s program). Under the rows, a hint on what a start command does; below it,
"Add <folder>" for a folder a session runs in that no profile has, "Add a folder somewhere else"
(`~` is the home folder; the folder must be there), and, for a shown profile whose `settings.json`
lacks the board's hooks or herdr's, a note with Install, which writes the hooks, the status line
and the agents' skill there and has herdr put in its own, as the [install](#setup) does, and
checks the setup again at once. Showing a hidden profile does the same Install right away, unless
both hooks are there already; what it could not do is said as Install says it, and the profile
stays shown, with the note while a hook is missing. Hiding a
profile takes it out of the switch, out of the profiles a session can be started in, and out of
Install. Its running sessions still show, with their tag, and their agents can still start helpers
in it.

**A start command per profile.** A profile's `command` is what the board types at the new tab's
shell prompt instead of `launch.claude`, for every start that types one: the board's, with the
default launcher (the new-session window, "New here"), and an agent's own `spawn-agent` (its
helpers); in the board's own profile too. It is a program, alias or function the tab's shell
knows, with arguments if you like: a string, split on spaces, or a list, typed by `launch.claude`'s
rules (see [spawn-agent](#spawn-agent)). It may not set environment variables
(`CLAUDE_CONFIG_DIR=~/.claude-work claude`, `env FOO=1 claude`): in bash that would override the
folder the board sets for the profile, so such settings go in the alias. The board adds the
profile's `args` after it (not `launch.args`), then `--session-id` (none when the command picks its
session itself, with `--resume` say). `launch.agent` and `launch.command` do not use it, and the env
rule does not change: a start that sets `CLAUDE_CONFIG_DIR` through `--env` without a command still
does with one. With these in Git Bash, say:

```bash
alias cld='CLAUDE_CONFIG_DIR=$HOME/.claude command claude --allow-dangerously-skip-permissions'
alias cld-work='CLAUDE_CONFIG_DIR=$HOME/.claude-work command claude --allow-dangerously-skip-permissions'
```

and `"command": "cld"` on Default, `"command": "cld-work"` on Work (or their "Start command" in the
panel), a Work session from the board types `cld-work --session-id <id>`, so a flag added to the
alias reaches it without touching the board. An alias that names another profile's folder runs its
session there. The card's red "Wrong profile" tag and herdr's notification say so when the board
knows which session the start made: by the session id the board passes, or `--session-id` to
`spawn-agent`. A helper an agent starts without `--session-id` gets no tag, nor does a helper whose
command picks its own session (`--resume`, `--continue`). A board start with such a command gets
one only if herdr reports the new tab's session within two minutes of the start. A command that
breaks the rules is refused with the reason: on save in the panel, and at a start that types it,
before anything runs.

**Which profile a session is in.** The hooks and the status line run in the session's env: they
read its `CLAUDE_CONFIG_DIR` (unset is `~/.claude`) and write the profile on its card. A folder is
the same however it is spelled (`C:\Users\me\.claude-work\`, `c:/users/me/.claude-work`,
`~/.claude-work`). The board reads a session's name, title, conversation and helpers from its
profile's folder, a hidden one's too. A session no hook has reported on yet shows as a bare herdr
pane does, without a tag.

**Tags.** With two or more profiles shown, under "All profiles", a card names its profile: the
profile's name in its color (its folder in the tooltip). Three tags show however many are shown:
a session in a hidden profile names it; one in a folder no profile has says "unknown profile" in
gray (the folder in the tooltip; the Profiles panel offers to add it, and it is never taken for
another profile); one whose hooks report another profile than its start asked for says "Wrong
profile: started for …" in red, and herdr notifies you. That session is not stopped. The terminal
board tags a session's line the same way, before its age ("wrong profile" in red there); it has no
switch, so it tags as "All profiles" does.

**On the web board**, with two or more profiles shown:

- The profile switch in the toolbar, by the lanes: "All profiles" or one profile, each with the
  sessions its pick shows. It filters the cards, those of sessions on their way included, as the
  lanes do; a session in the wrong profile or in a folder no profile has shows under every pick,
  so you always see it. This browser keeps the pick.
- Usage per profile: the pill shows each profile with a reading of the last half hour, the popover
  every shown profile's windows (5h, 7d) or "No session lately". With a reset time in the reading,
  each window gets a forecast line: at the pace averaged since the window started, it runs out at
  a given time before the reset (in orange) or lasts until the reset. The status line keeps each
  profile's windows apart in the state folder (`claude-limits-latest.json` for `default`, as
  before; `claude-limits-profile-<id>.json` for another), and without it the board reads the
  usagebar cache in the profile's own folder (`herdr-usagebar/`). With one profile shown the pill
  is as before: the board's own profile's windows.
- A lane's usual profile: "Usual profile" on its row in Categories. A new session in that lane
  (its **+**, say) starts with it picked.

**Starting a session in a profile.** The new-session window has a segment per shown profile.
Picked to start with, the first that fits: from a card, that session's profile, with no other to
choose; the lane's usual profile; the profile last used in that folder (this browser keeps it);
else none, and Start waits until you pick one. The pick shows in its color next to Start. A start
in the board's own profile (the one its `CLAUDE_CONFIG_DIR` points to) leaves the env as the board
got it; any other profile gets `CLAUDE_CONFIG_DIR=<its folder>` through herdr's `--env`
(`tab create`, or `workspace create` for a new workspace; with `launch.command`, in its process
env, and a new workspace for it is still made with `workspace create --env`, its first pane
recorded). herdr's `--env` needs herdr 0.9.5 or newer. The plugin itself still
runs on herdr 0.9.2; there only a start that needs herdr's `--env` fails, saying so, and no Claude
is started. What the board refuses and the "wrong profile" check: [New sessions](#new-sessions).

**Helpers and forks keep their parent's profile.** "New here" from a card starts in that card's
profile and no other (from a card in the wrong profile, you choose). `spawn-agent`, run by an
agent, starts the new session in the agent's own profile, hidden or not; `--profile <id>` names
another, shown one. See [spawn-agent](#spawn-agent). A MokuPilot call is the exception: it goes
only from a session in the board's own profile, since a running MokuPilot takes the call over in
its own env and a fork from another profile would run in its account. The board refuses the call
from any other profile before anything starts (see [Web board](#web-board)).

**Waking stays in the profile.** Every wake, whoever asks for it (the Wake button, Enter on the
terminal board, a message, a reminder, a restart, another session's SendMessage, a Telegram
message), types one line into the session's pane: `board resume <id> --profile <id>`. That sets the
session's profile folder itself, whatever the pane's shell has, and goes back to the session's
project folder (below). So a work session wakes in work however it was started: from the board, by
`spawn-agent`, with an alias like `cld-work`, or in a shell with `CLAUDE_CONFIG_DIR` exported. A
session is put to sleep (by you, an agent or the reaper) only when it can be woken again that way:
`board` is on PATH, its profile folder is known (its card, a listed profile, or the default
folder), and its conversation is in that folder; else it stays up, and "Put to sleep" says why. A
session's own ListAgents and SendMessage see and wake only the sleeping sessions of its profile, so
a name used in two profiles never wakes the other one; the board shows and wakes all of them. See
[Sleep and wake](#sleep-and-wake).

While the separate herdr-wake plugin does the waking (installed, and not switched over yet), it
resumes a session with the env of its pane's shell, as before, and the board keeps its old rule:
it wakes only a session in its own profile, or one in a pane the board opened with that session's
profile (while herdr shows the pane still holds the terminal it opened); any other it refuses,
saying why ([Schedule](#schedule)). A session in a pane whose shell has `CLAUDE_CONFIG_DIR`
exported is then woken in its profile by herdr-wake, not by the board; one started with an alias
like `cld-work` would be resumed by herdr-wake in `~/.claude`, where Claude finds no such session.
"Switch over…" ends that.

**After a restart of herdr (or of the computer).** herdr brings each pane back with a new shell in
its folder and types the session's resume command into it, by default `claude --resume <id>`. That
shell has neither the `CLAUDE_CONFIG_DIR` the board gave a profile's tab nor the one an alias set,
so a work session would not be found there. So when a session starts in a herdr pane in another
folder than `~/.claude`, the board's SessionStart hook tells herdr to resume it with
`board resume <id> --profile <id>` instead (`herdr pane report-agent-session … -- board resume …`,
from a process of its own a second or so later, once herdr holds the session). `board resume`
takes the folder from the session's card (else the profile named), sets `CLAUDE_CONFIG_DIR` to it
(a shell that points there already keeps its own), and runs `launch.claude` with the profile's
`args` and `--resume <id>`, in the foreground, in the session's project folder: the folder it runs
in when the session's conversation is there (a pane herdr restored), else the folder its
conversation records, else the folder it runs in; the profile's start command is not run, as an
alias is only known to a shell. herdr types only a command on PATH: the board reports nothing when
`board` is not on PATH (see [Setup](#setup)). Sessions in `~/.claude`, outside herdr, pi's and
Codex's are left to herdr as before: no report, no call to herdr. One exception keeps what
herdr-wake's own SessionStart hook did for a launcher: with wake's Telegram router on and
`launch.claude` starting a command of yours by its name rather than `claude` (claude-tg, say), a
session in `~/.claude` is reported as `board resume <id>`, so herdr resumes it through your
launcher. Where the separate herdr-wake plugin's SessionStart hook is in the profile (it installs
it into `~/.claude` only) and its `wakeCommand` is one of its own, herdr-wake reports that command
and the board reports nothing.

## pi

[pi](https://pi.dev) sessions in herdr are on the board too. herdr reports a pi pane's session by
its file (`~/.pi/agent/sessions/--<folder>--/<time>_<id>.jsonl`), the card's key, and the board
reads that file as it reads a Claude transcript: the card shows the user's last prompt, pi's last
words (a question at their end puts the card under "Needs me"), the tool it runs and how full its
context is; the session's sheet shows its turns. A name given with `/name` is the card's name. Only
the session as it goes on now is read: a branch left with `/tree` is not. pi writes the file once
the session has something in it; until then the card is bare. Agents in pi keep their card with the
`board` command as Claude's do (herdr's ids are in their env too).

**Profiles.** pi reaches Claude through its bridge
([pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)), whose Claude runs in a profile's
folder: the `CLAUDE_CONFIG_DIR` pi inherited, or, with a bridge that has provider profiles (such
as [Ordinath's fork](https://github.com/Ordinath/pi-claude-bridge)), the folder its config gives a
provider (`claude-bridge-work`, say). That Claude's hooks tell pi's card the profile on each of its
prompts, so the card has the tag of the account its last turn went to, and the profile switch sorts
it. The brief reaches pi the same way. A pi session on another provider (OpenAI, say) keeps the
profile of its last Claude turn, or has none, and is not briefed.

**Starting pi.** Give a profile `pi` as its start command (Settings → Profiles → Start command, or
`"command": "pi"`), with arguments if you like (`pi --model claude-bridge/claude-opus-5-5`), or an
alias for it. The board's launches in that profile (the new-session window, "New here") and
`spawn-agent` start pi in place of Claude, with the session id the board picked
(`--session-id`) and in the profile's env as for Claude, so `claude-bridge` runs in that profile's
account. herdr says which agent came up: the board names a pi session with `/name`, types the
first message, and puts the lane and the profile it is meant for on pi's card. spawn-agent adds
` kind=pi` to the line it prints.

**pi or Claude Code, start by start.** With the board's own launcher (no `launch.command` or
`launch.agent`), a launch request may name the agent it starts as: `"agent": "pi"` in
`POST /api/launch`, which the "New session" window (the web board's and the phone app's) sends when
you pick pi in its Agent row. The board offers pi (`agents` in `GET /api/launch/options`; the row
shows only then) when `launch.pi` is set in config.json or `pi` is on the board's PATH. `launch.pi`
is what it types for such a start: a program, or a list of the program and its arguments
(`["pi", "--model", "claude-bridge/claude-opus-5-5"]`), `pi` when unset; the profile's start command
and `args` are Claude's, so they are left out, while the profile's env is kept (pi's claude-bridge
runs in that profile's account). The session id, the name, the first message, the lane and the card
go as above. `spawn-agent --agent pi` does the same for an agent.

Which one the window starts on is `launch.default`: `"pi"` or `"claude"` (Claude Code when unset,
or when the board does not offer the agent it names). `GET /api/launch/options` answers it as
`agent`, and a request that names no agent starts as it. A failed launch started again keeps its own
agent. Return and Fork are Claude Code's whatever the default (pi resumes and forks no Claude
session), and so is `spawn-agent` without `--agent`. What each agent is started with:

```json
"launch": {
  "default": "pi",
  "claude": ["claude", "--dangerously-skip-permissions"],
  "pi": ["pi", "--model", "claude-bridge/claude-opus-5-5"]
}
```

`launch.claude` is for profiles without a start command of their own; a profile's start command
(the Profiles panel's "Start command") wins over it for its starts, `claude --dangerously-skip-permissions`
too.

Sleep and wake work for pi with the board's own wake ([Sleep and wake](#sleep-and-wake), "pi
sessions"). Not for pi (yet): the archive and Return, restart, the reaper, the session's own name
from the board's rename (the card's name works), question forms (pi has none: answer in a
message), MokuPilot calls, and the status line's context percentage and usage windows.

## New sessions

The window asks for a name, a folder, the lane, where to open it (one of herdr's workspaces or a
new one) and, if you like, a first message. It fills in what fits where it was opened from: the
card's folder and workspace, the lane's folders and the workspace most of its sessions are in,
else the folders of sessions on the board and of recent Claude sessions on this computer. The
folder field completes folder names as you type (Tab or Enter takes one), lists those
suggestions when it has the focus, and "Browse" opens columns to walk the disk, Finder style;
the server says whether the folder exists. The lane follows the folder (by the lanes' folders)
until you pick one. For a folder in a git checkout, "In a new git worktree" makes a branch in a
sibling folder (`repo-branch`) and starts there. Ctrl+Enter starts.

The new card shows in its lane at once, under "Working" while it starts, and becomes the
session's own card once herdr sees it. If it fails, it moves under "Needs me" with the reason
(the folder, a dialog Claude waits on, a timeout) and what to do: retry with the same values,
go to its tab, or dismiss it. A retry starts in the worktree or the workspace the failed launch
made already. One that failed only at its first message has no retry: the session runs; send
the message from its card. Dismissing a launch that still runs only takes it off the board: it
goes on, and its session still gets its lane.

In a folder Claude has not seen, it first asks whether to trust it. The launch then waits on its
card, under "Needs me", with the folder: "Trust and continue" reads the dialog off the screen,
checks it is for that folder, moves the cursor to "Yes" as the screen shows it and confirms; the
board then names the session and sends the first message, each only into an empty input box.
"Close the tab" closes it instead. The same holds when a launcher gives up there (spawn-agent
says "waits for a dialog (folder trust?)"): the session is in its tab, so the board takes it from
there rather than retry. A dialog Claude asks next (a project's MCP servers) is answered in
herdr; the card says it waits there.

How it starts, by `launch` in config.json:

- Nothing set (the default): the board's own [spawn-agent](#spawn-agent), run as a launcher (see
  `launch.command` below), with a session id the board picked, so the card has its lane before
  Claude starts. A new workspace's first tab is used for the session. `launch.claude` (`"claude"`),
  or the profile's start command ([Claude profiles](#claude-profiles)), is what it types into the
  tab: a program, or a list of the program and its arguments, such as
  `["claude", "--dangerously-skip-permissions"]` or `["claude-tg"]`. Without either, `launch.args`
  (from before the board had its own launcher) are `claude`'s arguments. `launch.timeoutSec`
  (120) is how long it waits for Claude to be ready. When Claude stops at a dialog before that, the card
  says so: the folder trust as below, any other in herdr; the board then names the session and
  sends the first message. A start that asks for pi types `launch.pi` instead, and
  `launch.default` says which of the two a start that names none is ([pi](#pi)).
- `launch.agent`: through herdr itself. A tab in the chosen workspace (or a new workspace),
  `herdr agent start <name> --kind <agent> --pane <tab's pane> -- --session-id <id>` (the id for
  `claude` only), then `/rename <name>` and the first message. When Claude stops at a dialog, the
  card says so; answer it in herdr and the board goes on. herdr starts the agent kind's own
  program, so `launch.claude` does not apply; `launch.args` adds the agent's arguments,
  `launch.timeoutSec` (120) how long to wait.
- `launch.command`: your own launcher, run without a shell. The first element is the program,
  each other element one argument, with `{name}`, `{label}`, `{cwd}`, `{workspace}` (herdr
  workspace id), `{workspaceLabel}`, `{category}`, `{message}`, `{messageFile}` (the first message
  in a UTF-8 file), `{sessionId}`, `{resume}` (the id of a session coming back from the
  [archive](#archive), empty for a new one), `{fork}` (the id of the session a [fork](#fork)
  starts from, empty otherwise; a launcher without it leaves forks to the board's own
  spawn-agent), `{profile}` (the Claude profile's id) or `{profileDir}` (its
  folder) filled in; a nested list is left out when a value in it is empty. Nothing from the request becomes a program or an option: values only fill those
  places. It runs with `HERDR_WORKSPACE_ID` set to the chosen workspace (the board itself lives
  in a workspace of its own) and should print `pane=<pane id>` when the session is up; it fails
  with a non-zero exit, its last error line is the reason shown. A new workspace's first tab is
  closed after a launcher opened its own tab in it. `launch.timeoutSec` (180): then the
  launcher and everything it started are ended (`taskkill /T` on Windows, its process group
  elsewhere), so nothing opens a tab after the card said it timed out.
  - Prefer `{messageFile}` to `{message}`. A first message is free text: as a plain argument it
    can start with `-` and be read as an option by a launcher that parses its own arguments.
    The file is written for this user only, new for each launch, and removed when the launcher
    exits, so the launcher must read it before it does.
  - `cmd`, `.bat` and `.cmd` files are refused as the program: cmd.exe reads its own command
    line, so the values would meet a shell after all. Run a script with its interpreter
    (`pwsh -File`, `node`, `python`).

```json
"launch": {
  "command": ["pwsh", "-NoProfile", "-File", "C:\\tools\\start-session.ps1",
              "-Name", "{name}", "-Cwd", "{cwd}", "-Workspace", "{workspace}",
              ["-BriefFile", "{messageFile}"]],
  "timeoutSec": 180
}
```

With more than one Claude profile shown (`CLAUDE_CONFIG_DIR` folders such as `~/.claude-work`),
the session starts in the profile chosen in the window; with one shown, in that one, as before. A
session started from another one ("New here") starts in that session's profile, hidden or not,
and in no other; when the board does not know that session's profile, or the session runs in
another profile than its start asked for, choose one. The board's own
profile, the one its own `CLAUDE_CONFIG_DIR` points to (unset is `~/.claude`, however the folder is
spelled), keeps the env exactly as the board inherited it: no `--env`, nothing changes for a
teammate. Any other profile gets `CLAUDE_CONFIG_DIR=<its folder>`: on the tab with
`herdr tab create --env` (`herdr workspace create --env` for a new workspace) for spawn-agent and
`launch.agent`, which needs herdr 0.9.5 or newer, or in the process env of a `launch.command`. The
board records the panes it opened with a profile's env, so it knows they run in that profile (a
launcher command's own panes are not recorded). The profile's `args` go to Claude after its other
arguments, before `--session-id` (spawn-agent and `launch.agent`'s `claude`). The board never
falls back to another profile: it refuses the start before anything runs when

- more than one profile is shown and none is chosen;
- the profile chosen is hidden (show it in Settings → Profiles), or not listed;
- another profile is chosen than the one of the session it was started from;
- the board does not know the profile of that session, and none is chosen;
- the profile's folder is not there.

herdr that does not take `--env` fails the start, saying so: no Claude was started. The card of a
session the board started says the profile it was meant to run in, so a session whose hooks report
another one shows the "wrong profile" warning; it is not stopped.

### spawn-agent

The command the board starts sessions with, and agents start other sessions with (the install
puts it on PATH; it is `bun src/entrypoints/spawn-agent.ts`):

```
spawn-agent --name <Name> --cwd <folder> [--label <tab label>]
            [--brief-file <utf-8 file> | --brief <text>] [--workspace <herdr workspace id>]
            [--timeout-sec 120] [--session-id <uuid> | --resume <uuid>] [--fork <uuid>]
            [--pane <herdr pane id>] [--profile <id>] [--agent claude|pi] [--trust]
```

PowerShell's spelling works too: `-Name`, `-Cwd`, `-Label`, `-BriefFile`, `-Brief`, `-Workspace`,
`-TimeoutSec`, `-Profile`, `-Agent`, `-Trust`. `--agent pi` types `launch.pi` (default `pi`) instead of the
profile's `command` and `args` or `launch.claude`, for a new session only (no `--resume` or
`--fork`); see [pi](#pi). It opens a tab in the workspace (inside herdr the current one, from
`HERDR_WORKSPACE_ID`), labelled with `--label` or the name, and types the profile's `command`, or
`launch.claude`, into it (with `--session-id` when given). Once herdr sees Claude ready, it gives
the agent a herdr name to address it by (the name in `[a-z0-9_-]`, Cyrillic spelled in Latin, `-2`
when taken), types `/rename <Name>`, then the brief. It prints

```
pane=<pane id> name=<Name> agent=<herdr name>
```

which is how the board knows who started whom. It fails (exit code 1, the reason on stderr) when
the folder is not there, Claude is not ready in time, or Claude waits for a dialog first (the
folder trust): answer it in that tab, then name and brief the session there. `--trust` answers
two such dialogs with Yes instead: the folder-trust one when it names `--cwd` itself, and "Allow
external CLAUDE.md file imports?" when every file it lists is in the user's own Claude folders.
Any other dialog still stops the start. A brief that does not get through fails it too, saying
so: the session runs, send the brief by hand rather than start another. A `/rename` that does
not take is only a warning. `--pane` starts Claude in that
pane instead of a new tab; it must be at a shell prompt, not running an agent. `--resume` brings
back a session that ended (`launch.claude` with `--resume <uuid>`, run in the folder the session
ran in): it keeps its name, so no `/rename` is typed; the board's [archive](#archive) uses it.
`--fork <uuid>` starts a new session with a copy of that one's conversation
(`launch.claude` with `--resume <uuid> --fork-session --session-id <its own id>`, the id given
with `--session-id` or one of its own): named and briefed as any start, in the profile whose folder
holds that conversation, as a resume is; the board's [Fork](#fork) uses it.

With more than one Claude profile (`CLAUDE_CONFIG_DIR` folders such as `~/.claude-work`), a
session an agent starts keeps that agent's profile, the one its own `CLAUDE_CONFIG_DIR` points to,
even when the profile is hidden on the board: a helper of a work session runs in work.
`--profile <id>` starts it in another profile instead, one the board lists and shows. The
profile's `args` go after the profile's `command`, or `launch.claude`, before `--session-id`. The
default profile (`~/.claude`) is the one herdr's own env is taken to be: a start in it, the agent's
own or `--profile default`, leaves the new tab's env as herdr makes it, as before profiles. For any
other profile, the agent's own or the one `--profile` names, the new tab gets
`herdr tab create --env CLAUDE_CONFIG_DIR=<folder>`, which needs herdr 0.9.5 or newer. spawn-agent
then records the pane as opened in that profile, with the terminal herdr opened it with. With
`--session-id`, every start, one that leaves the env alone included, writes the card as meant to
run in its profile, so a session that reports another profile (herdr's own env pointing to another
one, or an alias, say) shows the "wrong profile" warning. Without `--session-id` it writes no such
card, and with a command that picks its own session (`--resume`, `--continue`) the card is not that
session's: neither start shows the warning. spawn-agent never falls back to another profile: it
refuses, before herdr opens, renames or types anything, when

- the agent's own folder is not a profile the board knows (or is named relative to where it
  runs): pass `--profile <id>`;
- `--profile` names a profile the board does not list, or one that is hidden (show it first);
- the profile's folder is not there;
- `--pane` names a pane not opened in that profile, or, for a start in the default profile, one
  that may have been opened in another (leave `--pane` out to get a new tab). herdr is asked
  first which terminal the pane holds: after herdr starts over it gives a pane's id out again.
  A start in a profile takes the pane only when herdr shows it holds the terminal it was
  recorded with; a start in the default profile is refused unless herdr shows it holds another.

herdr that does not take `--env` fails the start too, saying so: nothing was started. The board's
own launches pass `--config-dir <folder>` (the folder of a profile it lists, which it checked; any
other folder is refused) or `--keep-env` (the env as herdr makes it) instead of `--profile`; only
one of the three goes at a time.

Details it takes care of: `/rename` runs without a turn, so herdr calls it stalled, and the
screen is read for "Session renamed" instead. Right after it Claude can drop typed text, and a
short turn can end before herdr sees it working: a brief herdr calls stalled gets an Enter when
it is still on screen (or shows as a pasted-text chip), else it is typed again, three times at
most. A brief that starts with a dash goes with a space before it, or herdr would take it for an
option. From PowerShell prefer `--brief-file` for a brief with quotes or `&` in it: the `.cmd`
goes through cmd.exe. From Git Bash, a brief that starts with `/` (a slash command) reaches it
as a path (MSYS rewrites such arguments for Windows programs): use `--brief-file` there too.

`launch.claude` is typed at the tab's shell prompt (PowerShell, bash, zsh, fish): plain words as
they are, other arguments in single quotes, which those shells take literally (in fish, keep a
backslash away from the end and from another backslash). An argument with a quote in it
(`'`, or a typographic one PowerShell also ends a string at) or a control character is refused.
The program itself must be a name on PATH, or a path without spaces (backslashes only on
Windows, where the tab runs PowerShell).

Launches live in the board's memory. A board that restarts in the middle of one forgets it: its
card goes, a launcher it ran is left running (and finishes or fails on its own), and a session
that comes up lands in the lane its folder gives, or in the chosen one when the board had given
it its session id (the herdr path, or `{sessionId}`). A first message file left behind is
removed when the board starts again.

## Fork

"Fork" in the sheet's row of actions (or under "⋯") and in a Claude session's card menu: a small
window grown out of the button or the card, with the fork's name (the session's with "· fork"
after it, ready to type over) and an optional first message. Fork (Enter in the name, Ctrl+Enter
in the message) starts a new session in a new tab of the session's workspace, in its folder (the
one its conversation was recorded in: Claude resumes a session only from there), lane and Claude
profile, hidden or not, as "New here" keeps it: `claude --resume <id> --fork-session` with an id
of its own, so its card has its lane before Claude starts. It goes through the board's launches:
its card shows at once, under "Working" while it starts, and a failure says why on it; Retry
opens the window again with what it was given. The session itself is not touched: nothing is
typed into it, its card stays as it was.

The fork's card says at its foot whose fork it is, and the sheet's "Sessions" row marks the two
with the fork's glyph: a fork's transcript starts with a copy of its source's conversation, each
copied line marked `forkedFrom` with the source's id, so the board reads the link from the fork
itself, whoever made it (the board, an agent with `spawn-agent --fork` or `board fork`, or
`claude --resume <id> --fork-session` by hand). Those copied lines are the source's: the
sessions it started and the messages it sent are not counted again for the fork.

The board offers Fork where its launcher can make one: its own spawn-agent, a `launch.command`
that takes `{fork}` (one without it leaves forks to spawn-agent), or `launch.agent` for Claude
without arguments that pick the session (`--resume`, `--continue`, `--session-id`). An agent forks
its own session (or another's, with `--session`) with `board fork [--name "<Name>"] ["<note>"]`:
the web board starts it as its Fork does, the note is its first message.

`POST /api/session/<key>/fork` with `{ name?, message? }` (the page only, like a launch), and the
board payload's `fork`. Code: `src/services/launch/fork.ts`, `web/src/hooks/useFork.ts`,
`web/src/components/fork/ForkPop.tsx`.

## When a card is under "Needs me"

1. A dialog holds the session in the terminal (permission prompt, question form, MCP input, a pi
   extension's menu or text input): herdr reports `blocked` from its own screen rules, or from pi
   when an extension says so (`herdr:blocked`). The card shows the question or the permission
   asked; the sheet shows the screen, and a question form, a permission prompt or pi's menu or
   text input can be answered from it.
2. The agent ran `board ask "<question>"` before ending its turn. Cleared by the hook as soon as
   you write to that session.
3. Its last message ends with a question and you have not written since. "No reply needed" on
   the card or in the sheet waves that one question off.
4. You dragged it there yourself to look at it later ("Parked"). The check mark on the card
   ("Seen") takes it out.

## Answering from the board

When a session waits in Claude Code's question form (AskUserQuestion), its card says so with the
header, the first question and its options in a line (`+2 questions` when there are more). The
sheet shows the form itself: every question in order, its header, "Pick one" or "Pick any",
the options with their descriptions, an own answer, and the mockup of an option that has a
preview. The questions come from the tool call in the transcript, not from the screen. A lone
single-choice question is answered with one click on an option, as a digit does in the
terminal; otherwise pick the answers and press "Answer" (or Enter in an own answer). Keys 1 to 9
pick an option of the question in focus while the focus is in the sheet. The conversation shows
each form as a turn of its own, with the answers once given. A form the board cannot answer for
sure is left to the terminal ("Go to herdr"): more than 4 questions or 8 options, a question or
label longer than the board shows whole, two questions with the same text or two options with
the same label. An own answer is one line, without control characters (C0, C1) or the Unicode
marks that change the direction of text.

A permission prompt ("Do you want to proceed?") shows its title, what the tool will do and the
terminal's own choices (Yes, Yes and don't ask again, No...), read from the screen as drawn; one
click or digit picks one. A very long prompt is cut on the board with a mark ("12 more lines: see
the terminal screen"), never silently.

In a pane herdr says runs [pi](https://pi.dev), the board reads pi's dialogs instead
(`src/core/dialogs/pi-dialogs.ts`, pi 1.3): the menu an extension asks with `ctx.ui.select` or
`ctx.ui.confirm` (a git guard's "Approve / Reject / Reject with a note"), and its text input
(`ctx.ui.input`). The sheet shows the menu like a permission prompt, its title and text as drawn
and its options; a click or a digit picks one. No digit picks in pi's menu, so the board moves the
cursor one row at a time with the arrow keys, waits after each until the screen shows the same
menu with the cursor there, and presses Enter only on the option picked. The text input gets a
field: the board clears pi's field (End, Ctrl+U), types the line and presses Enter once the field
shows it (its end, for a line longer than the field). A dialog taller than the pane shows only
its end on the screen; the sheet says its start is above the terminal screen. Claude Code's
dialogs are never looked for in a pi pane, nor pi's in any other.

The board answers by pressing keys in the pane through herdr (`herdr agent send-keys` with the
pane id, and `herdr pane send-text` for an own answer: `agent prompt` refuses a pane in a
dialog). `send-text` types its text literally (backslashes and a leading dash included, herdr
0.9); an own answer that starts with a dash still goes with a space before it, as the board's
other calls do, and the board then takes that space out of the field (Ctrl+A, right, Backspace)
and checks it is gone, since Claude Code would keep it in the answer. How the form takes keys,
as found on a live session (Claude Code 2.1, `src/core/dialogs/questions.ts`):

- The cursor starts on option 1. In a single-choice question a digit picks that option and moves
  on at once; a lone question is then submitted. With previews a digit only moves the cursor and
  Enter picks.
- The own answer is the row after the options. A digit there picks the text it already holds, so
  the board reaches it with the arrow keys (the row then takes text; up leaves it), clears it with
  Ctrl+U, types, and presses Enter. Typing on it in a multi-choice question ticks it.
- In a multi-choice question a digit toggles an option and the cursor stays; "Next" (or
  "Submit" for a lone question) under the options goes on with Enter.
- Several questions, or one multi-choice question, end on a "Review your answers" screen that
  lists every answer above "1. Submit answers". Left and right arrows move between the questions.

What keeps it from pressing keys in the wrong place:

- The answer needs fresh herdr data, like a message, and comes only from the board's own page
  (the `Origin` check of new sessions). The pane must still hold the same Claude session (as
  `send` checks), herdr must say it is blocked, and the transcript must still have that very
  question call without a result: one answered in the terminal meanwhile is refused. One answer
  at a time per session.
- Before every key the screen is read and parsed; the board goes on only when it shows the
  question it expects, with the same options. After every key it waits until the screen shows
  what the key should have done (an option ticked, the next question, the field cleared). A
  dialog begun in the terminal is taken back to its first question and set to the board's
  answers.
- The review screen must list exactly the board's answers, with "Submit answers" as its first
  choice, before that is pressed.
- Done needs proof, which a blank or half-drawn screen is not: the transcript holds the answer,
  or two reads in a row show the agent's input box without the dialog (for pi: its two rules at
  the bottom of the screen, a short footer under them), or a whole other dialog.
- A permission prompt is pressed only while the screen shows the prompt the user saw: a
  fingerprint of its title, text, question and choices exactly as drawn, every character and
  space (`rm -rf build_*` is not `rm -rf build`); where the cursor stands does not count. The
  same for pi's menu and text input, before every key; neither does what pi's field holds, nor a
  timed dialog's countdown ("(12s)").
- On the page, a click or a digit in the first half second after another dialog took the place
  of the one on show is not taken (permission prompts can come back to back), nor is a held key.
  A form that went through stays as "Answered" until herdr sees the session move on (at most 10
  seconds); the same prompt asked again is a new one.
- Anything unexpected stops it at once. The sheet says where it stopped and, once keys went in,
  that the form may be partly filled in (a herdr failure midway too), shows the screen, and
  offers "Go to herdr". Without fresh data the form stays readable and cannot be sent.

`POST /api/session/<key>/answer` with `{ session, toolUseId, answers: [{ options: [labels],
other }] }` and `POST /api/session/<key>/permit` with `{ session, fingerprint, option }` (the
fingerprint comes with the sheet's data), or `{ session, fingerprint, text }` for pi's text
input; both need the `X-Board` header. The session's detail (`GET /api/session/<key>`) has the
dialog on its screen as `dialog`: `{ kind: 'permission', title, body, more, prompt, options: [{ n,
label }], fingerprint }`, `{ kind: 'select', title, body, more, cut, options, fingerprint }` (pi's
menu), `{ kind: 'input', title, body, more, cut, value, fingerprint }` (pi's text input),
`{ kind: 'question', question }`, `{ kind: 'review' }`, or null. Code:
`src/core/dialogs/questions.ts` (the questions, the screen, the keys), `src/core/dialogs/pi-dialogs.ts`
(pi's), `src/services/answer.ts` (the steps through herdr), `web/src/components/questions/` and
`web/src/models/question-model.ts` (the form).

## Side questions

A side question is Claude Code's own `/btw`, typed into the session's pane through herdr as a
message is sent (`herdr agent prompt <pane> "/btw <question>"`). Claude Code answers it in an
overlay over its input box, from what the conversation holds and with no tools, and keeps it out
of the conversation; it answers while a turn runs too. Claude Code does keep a session's `/btw`
questions and answers among themselves: a later side question can draw on an earlier one, and the
user's own `/btw` lists the board's. The board reads the answer off the screen
(`herdr agent read --source visible`), pressing Down while more of it is below, and closes the
overlay with Esc. A `/btw` that shows something other than an answer for a few seconds (an error)
is reported with what it shows. The answer shows in a card over the message box: the question,
the answer and how long it took. Close (×) forgets it; on its way the same button cancels it and
closes the overlay. The cards stay with their session while the page is open, and never go to the
server or the conversation.

It types only where the line lands as `/btw`, checked as before a message
(`src/services/actions.ts`), and otherwise says why and types nothing:

- the session asleep: `/btw` needs the running session, and the board does not wake one for it;
- a dialog, a picker or an overlay open in the terminal (a permission question, `/model`, the
  user's own `/btw`), or the session blocked on one: the line would go into it;
- text in the input box: Enter would send it along;
- another session in the pane by now, or a side question to it still on its way.

Esc goes only to the overlay with this question in it: a key pressed into anything else would
answer it. The answer comes back as the terminal showed it, lists and code as drawn and long lines
wrapped at the pane's width. `/btw` runs no UserPromptSubmit hook, but herdr reports the session
working while it answers: the card moves under "Working" for a few seconds and then back (a
session under "Needs me" returns there); the board cannot keep it in place. A question is up to 790
characters: Claude Code folds a longer paste into "[Pasted text #1]" and sends that to the
conversation as a message.

The switch in the message box (the bubble beside the clip, purple while on) sends the next
message aside; a message that starts with `/btw` goes aside too. Both only in a Claude session
with an id; elsewhere the box is as it was, and `/btw` goes to the session as typed.

`POST /api/session/<key>/aside` with `{ question }` answers `{ ok, text, ms }` or `{ ok: false,
error, busy? }` (the page only, with herdr's data recent enough to act on); the board payload's
`aside` says whether the board can ask. Code: `src/core/aside.ts` (the overlay on the screen),
`src/services/aside.ts` (the steps through herdr), `web/src/hooks/useAside.ts`,
`web/src/components/sheet/Aside.tsx`.

## Terminal

"Terminal" opens a window over the board with a live terminal of the session, one of two (the
switch in its head; the window opens on the one used last):

- **Shell**: a shell in the session's folder, to run something there: `gh auth login`,
  `bw unlock`, the tests. The board opens it the first time as a tab of its own in the session's
  workspace in herdr, named after the session, so it is in herdr too ("Open in herdr" goes
  there). It stays when the window closes; a dot on the sheet's Terminal button says it is open.
  "Close the shell" (two clicks) ends it and closes its tab, unless something else was put in
  that tab since. `exit` in it, or closing it in herdr, does the same, and the board offers a new
  one.
- **Claude** (the session's agent): the session's own pane, for what its terminal asks and the
  board has no form for: `/login`, `/mcp`, a menu, a dialog too big for the sheet. It opens
  without the keys, so an Esc meant for the window never stops a turn. A sleeping session shows
  "Wake" instead.

A click or a tap on the screen gives it the keys; its ring and the line under it say so. From
then on keys go to the terminal: text, Enter, Tab, Esc, the arrows, Home, End, Page Up and Down,
Delete, F1 to F10, and Ctrl or Alt with a key (by the key's place: Ctrl+C on a Russian layout is
Ctrl+C). Ctrl+C with text selected on the screen copies it, Ctrl+V pastes; a paste of several
lines asks first, since every line runs as typed, and its last line break is left off. Ctrl+]
gives the keys back to the board; then Esc closes the window (Ctrl+` closes it from anywhere in
it). On a phone a tap on the screen brings up the keyboard, and a row under the screen has the
keys it lacks: Esc, Tab, Ctrl+C and the arrows. Web links in the output open in the default
browser.

What it shows: herdr has no output stream, so the board reads the pane (`pane read --source
recent-unwrapped --ansi`, its last 400 lines) right after every key, every 120 ms while
something changes, then every 0.4 to 1 s, and sends the page only the lines that changed (a line
longer than 4000 characters is cut there). A board page out of sight reads nothing until it is
back. Typed text shows in about a quarter of a second. Colors as the programs draw them (16, 256 and true
colors; bold, dim, italic, underline, inverse) on a screen that stays dark in both themes, which
is what the programs draw for. The text is sized for the pane's columns to fit, and lines wrap at
the window's edge. herdr does not say where the cursor is: the caret goes after a shell's prompt
or into Claude Code's input box, and only once the screen has been still for a moment.

It runs commands on this computer, so:

- Loopback only, as the whole board, and every request that types, opens or closes needs the
  `X-Board` header, the page's own `Origin` and fresh herdr data. Without fresh data the window
  keeps showing the screen and takes no keys. The stream (Server-Sent Events, which send no
  headers) needs the per-run token of the board payload, as raw files do.
- Keys go only to the shell the board opened for that session (kept in `terminals.json` in the
  state folder, and checked to be still that pane, in its tab, with the terminal it was opened
  with), or to the session's own pane once herdr says the same session still runs there, as for
  a message. A shell moved elsewhere in herdr is no longer the board's: it is neither typed into
  nor closed. The server takes only keys from its list, text without control characters, at most
  16 KB a request; a request with anything else types nothing.
- The board logs nothing typed or shown and keeps none of it. But typed text reaches herdr as a
  command-line argument of `herdr pane send-text` (its CLI takes text no other way), so for the
  moment that call runs it is visible to other processes of the same user and to process
  auditing that records command lines (Windows event 4688, when it is on). A password is better
  typed in herdr itself.
- Keys never land late: a request herdr is slow with shows "Waiting for herdr", the page gives
  it up after 8 s and drops what was typed meanwhile (and says so), and the server starts no
  herdr call for a request older than 4 s. The first call that fails stops the rest of it.
- `"terminal": false` in config.json turns it off: no button, and every terminal route answers
  404 (for a board opened from a phone through a tunnel, say).

`GET /api/term/<key>/<agent|shell>/stream?t=<fsToken>` (the screen, then line diffs),
`POST /api/term/<key>/shell/open`, `/shell/close`, `/shell/focus`, and
`POST /api/term/<key>/<agent|shell>/input` with `{ session, steps: [{ text } | { key }] }`.
Code: `src/services/terminals.ts` (the shell, the reads, the input), `src/server/routes/terminal.ts`
(the routes), `web/src/hooks/useTerminal.ts` and `web/src/components/terminal/Terminal.tsx` (the
window), `src/core/terminal/term-model.ts` (ANSI, line diffs, links, the caret),
`src/core/terminal/term-keys.ts` (keys, both ends).

## Helpers and linked sessions

A session rarely works alone. Its helpers are what Claude Code runs for it: subagents (the Agent
tool, in the background or while the session waits), forks, the agents of a workflow, and
in-process teammates. Sessions in herdr also hand work to each other: one starts another with
`spawn-agent` and they write to each other with SendMessage.

- On a card, only while it is so: "3 helpers at work" with a dot for each (a subagent blue, a fork
  purple, a workflow teal, a teammate in its own color) and what the newest one does. A session
  whose turn is over can still have helpers at work; its card says so where it is. At its foot,
  quietly, the session that started it (a click opens that one) and how many it started. Pointing
  at a card, or tabbing to it, rings the cards of the sessions it works with. The toolbar counts
  the helpers at work on the whole board.
- In the sheet, above the conversation: the helpers at work, each with what it does now (the
  call that runs, or "thinking after Read") and a running clock; with none at work, the newest one
  in a line. "All" opens the list: at work, workflow runs with their agents, teammates, then the
  finished ones, newest first. A helper another helper started goes under it.
- A helper's row opens its own conversation in a window grown out of the row: what the session
  asked it, its messages, its calls folded as in the session's thread, its report; read again
  every second and a half while it works. The head says what it is (subagent, fork, workflow
  agent, teammate; its type, name and model; in the background or not) and how it stands, the
  foot how long it ran, its tool calls and its tokens (the last request's, as Claude Code counts a
  subagent's). Backspace goes back to the list, Esc closes.
- "Sessions" among the card's fields: each linked session once, marked when it started this one
  or this one started it, with the messages each way. A name opens that session.
- A fork (see [Fork](#fork)) is linked to the session it is a fork of, marked with the fork's
  glyph, whoever started it.
- In the conversation, a call that works with others is a line of its own: a subagent, fork or
  workflow it started (it opens the helper, with its status and clock), a message it sent to
  another session or a teammate (it opens to the whole text), a session it started with
  spawn-agent. Another session's or a teammate's message is a bubble with their name; an agent's
  report has "Conversation" beside it.

Where it comes from, all read, nothing written:

- `~/.claude/projects/<project>/<session id>/subagents/agent-<id>.jsonl` is a helper's own
  transcript and `agent-<id>.meta.json` says what it is (agentType, description, the tool call
  that made it, `isFork`, `name`, `requestShape` background or foreground, `taskKind`
  `in_process_teammate`, `parentAgentId` for one a helper started, `stoppedByUser`). Workflow
  agents are under `subagents/workflows/<run>/`; a run's name and totals are in
  `<session id>/workflows/<run>.json` once it is over, its name in
  `workflows/scripts/<name>-<run>.js` while it runs. A teammate's team is
  `~/.claude/teams/session-<id>/` (its members); the board needs only the helper files.
- How a helper stands comes from the end of its transcript: its final answer (done; a teammate
  then waits for its next message), a call without a result or the model at work (at work),
  "Request interrupted" (stopped), an API error (failed). A helper that ended its turn while a
  background command of its own, or an agent it started, is still out is at work: Claude Code
  wakes it when that reports back (after an hour without a word, it counts as done). Only a
  session whose Claude process runs has helpers at work, and only those that process wrote to:
  what a process left half done before the session slept or restarted is stopped, and so is one
  that has not written for six hours.
- Who started whom: the `pane=<id> name=<name>` line spawn-agent prints, matched to the card in
  that pane under that name (a pane id comes back once its tab is gone). Messages: the session's
  SendMessage calls, and the messages that came in (Claude Code records the sender's name and the
  pipe it writes from). A name is matched only when one session on the board goes by it; a reply
  to a pipe, by the session that runs on that pipe now, else by who wrote from it.

What it costs: a helper's meta file and the head and tail of its transcript are read once and
again only when they change (time and size); a session's folder is listed again only when it
changes. The links come from a read of each session's transcript in the background, once in
full and then only what it gained, parsing only the lines with a marker (spawn-agent,
SendMessage, a message from another session). A helper's whole conversation is read only when
its window is open.

`GET /api/session/<key>` carries `helpers` and `workflows`; `GET /api/session/<key>/helper/<id>`
one helper with its conversation, where the id only picks among that session's own helpers. The
board payload has each item's `helpers` (counts and the newest at work) and `links`. Code:
`src/core/helpers.ts` and `src/adapters/helpers.ts` (what the files say, and reading them),
`src/core/links.ts` and `src/adapters/links.ts` (who works with whom), `src/core/transcript-links.ts`
(the calls and messages in a transcript), `src/server/routes/helpers.ts`, `web/src/components/helpers/`
(the window, the rows, the card's and the sheet's parts), `web/src/hooks/useHelpers.ts`,
`web/src/models/helper-model.ts`.

## Moving a card by hand

A card dragged to another column (or set with the status pill in the sheet's head) stays there,
marked with a pin, until the session works again: you write to it, or another session does. Then
the board sorts it by itself as before. Dragged while the session works, it stays under "Working"
and moves once that turn is over. A terminal dialog still puts it under "Needs me". Dropped back
on the column the board would pick, or with "Auto" in the status pill's menu, the pin goes.
"Working" takes no cards. The pin is `pin` in the card file; the hook and the board clear it.

## Favorites

Some sessions matter every day even while they idle (the master sessions you go back to). "Add to
Favorites" in a card's menu, the star in the session panel's head, `f` in the terminal board or
`board favorite` keeps one in sight: first in its column in its lane, whole (never one line in
"Idle", never folded in "Waiting"), on show even while sleeping sessions are hidden, and left
alone by "Archive the sleeping ones". A small star by its name says so. Archiving it by hand
works as for any other. It sleeps and wakes as before. It is `favorite` in the card file.

## Schedule

An agent can ask the board to come back to it later: `board remind in 2h "check the CI run"`,
or on a cron schedule, `board every "0 9 * * 1-5" "go through the inbox"`. When an entry is due,
the board types `[board reminder] <text>` into that session as a prompt (`[board schedule <id>:
<cron>] <text>` for a repeating one), waking it first when it sleeps
([Sleep and wake](#sleep-and-wake)). The agent wrote the text for itself, so it knows what to do.

This is what Claude Code's own CronCreate and ScheduleWakeup cannot do here: they live inside
the Claude process, and a sleep ends that process (wake's reaper puts a session that sat idle for
an hour to sleep, when it is on). The board's entries are files, and the board keeps running.

- Times are local: `in 30m`, `in 1h30m`, `at 15:30` (the next 15:30), `tomorrow 9:00`,
  `fri 17:00`, `2026-10-20 14:00`, or an ISO time with a zone. A date alone means 9:00.
- Cron has the usual 5 fields (minute, hour, day of month, month, day of week; names, ranges,
  lists and steps) or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Day fields work as
  in Vixie cron: two restricted ones are either-or, one that starts with `*` narrows the other.
  Runs closer than 5 minutes apart are refused: each one is a turn of the session. On a DST
  change, a time that does not exist that day is skipped and a repeated hour runs once.
- On time by default: a session that works gets the text right away, and Claude Code queues it
  into the running turn the way your own mid-turn messages arrive. With `--idle` (or the switch
  on the entry in the panel or the sheet) it waits until the session is free instead.
- Either way, a session that waits on a dialog (typing would answer it) or has text the user
  started typing in its input box (read from the screen as wake does: dim suggestions do
  not count) is not touched: the scheduler tries again every tick (15 s) and sends once it can.
  After `scheduleWaitMin` (240) minutes of trying, the run is logged as missed: a one-off entry
  goes, a cron one moves to its next time.
- An entry belongs to the session it is for. After `/clear`, which gives the session a new id,
  it goes to the Claude session now in the same pane and folder (the folder herdr gives the
  pane, not the shell's after a `cd`), and the prompt says it was set before `/clear`.
- `--session` sets one for another session; the tag then names who set it,
  `[board reminder from <name>] <text>`, since the receiver takes it as a prompt. Control
  characters are taken out of the text.
- A cron entry whose session stays gone for 3 runs in a row is dropped (logged as removed).
- Delivery is at least once: a board that dies between typing the text and recording the run
  sends it again once its claim expires (5 minutes).
- With no board running the scheduler, `board remind` says so; the entry goes out once one runs.
- At most two sleeping sessions are woken at once. An entry cancelled while its session wakes
  up is not sent.
- A run for a sleeping session waits while wake is slow to answer, or down and herdr cannot be
  reached, without the wait counting against `scheduleWaitMin` and without the session counting as
  gone: no reminder is lost, and no cron entry dropped, because wake was down. With wake turned off
  the board wakes the session itself and sends the reminder.
- With more than one Claude profile, every wake resumes a session in its own profile
  (`board resume <id> --profile <id>`, see [Claude profiles](#claude-profiles)), so a reminder
  wakes a session of any profile. While the separate herdr-wake plugin does the waking, a sleeping
  session is woken only where it resumes in its own profile: herdr-wake restarts Claude in the
  session's pane, with that pane's env. So the board then wakes a session of its own profile (the
  one its `CLAUDE_CONFIG_DIR` points to), or one in a pane the board opened with that session's
  profile, while herdr shows the pane still holds the terminal it opened. A session started
  outside the board in another profile is not woken: a reminder for it is held, its reason
  "Started outside the board in profile …, so waking could resume it in the wrong account; wake it
  in herdr where you started it", and tried again every tick like any held one. Nor is a session
  in a pane the board opened with another profile's env, the board's own profile included, unless
  herdr shows the pane now holds another terminal: its reason "Its pane was opened in profile …".
  A session whose card names no profile yet is in the one profile shown, when one is. The Wake
  button, "Go to herdr" and a message refuse alike. The board forgets a pane it opened once herdr
  no longer has it, or gave its id to another terminal.
- Runs that came due while the board was off: a one-off is sent once, saying how late it is; a
  cron entry sends one prompt for all the runs it missed, saying how many. Time the board was
  off does not count against the wait.
- A reminder prompt is not the user writing, nor is a background task reporting back
  (`<task-notification>`): the hook leaves the card's `ask` in place, and a question the agent
  asked still waits for you. A column
  you dragged the card to goes, as with any work of the session.
- One file per entry in `%LOCALAPPDATA%\herdr\plugins\agent-board\schedule\<id>.json`, written
  under the same per-file lock as the cards, so an agent cancelling an entry while the
  scheduler marks its run never brings it back. Before sending, the scheduler claims the entry
  in its file: a second board running at the same time (a restart that overlaps) never sends a
  run twice. `log.jsonl` there keeps the last 200 runs.
- The scheduler runs in the web board's server (`src/services/scheduler.ts`), one per machine since
  only one board holds the port; with `web: false` the terminal board runs it.
- At most 30 entries per session.
- The terminal board shows `⏰` (`⏳` for one that waits until the session is free) and the soonest
  time by a card's age, the count in its header.
- A restart (`board restart`, "Restart" on the web board) is an entry too: see [Restart](#restart).
  So is a sleep once the session is free (`board sleep --when-free`): see
  [Several to sleep at once](#several-to-sleep-at-once).

## Restart

A Claude session that restarts stays the same session: Claude exits and resumes in its pane
(`board resume <id> --profile <id>`, which runs `launch.claude` with `--resume <id>` in the
session's profile; see [Sleep and wake](#sleep-and-wake)), with the same session id and
conversation, and on the way it starts every MCP server again and reads settings.json, hooks,
skills and CLAUDE.md anew. That is the reliable way to get a dropped MCP server back, which an
agent cannot reconnect from inside its own turn (`/mcp` is a menu in its own terminal).

- An agent asks with `board restart ["<note for after>"]` during its turn, then ends the turn.
  You ask with "Restart" in the sheet or a card's menu, for a session that lost an MCP server or
  acts up. No confirmation: the conversation stays, and it waits until the session is free. A
  turn that hangs never ends by itself: interrupt it first (Esc in its terminal, "Terminal" then
  "Claude" on the board), or the restart waits and, after `scheduleWaitMin` (240) minutes, is
  logged as missed without a word to the session.
- It is a schedule entry of kind `restart`, due at once, so it survives a board restart:
  `board schedule` and the web board's schedule list it, `board unschedule <id>` or the trash
  can cancel it. Asked again before it happens, it stays one restart (a newer note replaces the
  old one).
- The scheduler (`src/services/scheduler.ts`) waits until the session is free: its turn over
  (for herdr and in Claude's own session registry), no dialog, no text you started typing, no
  background command or Monitor running (that for 10 minutes at most). Then wake puts it
  to sleep (`POST /sleep`, which types `/exit`) and wakes it (`POST /wake`). 8 seconds later, so
  that its MCP servers have a moment to connect, the board types
  `[board reminder; restarted as you asked] <note>` into it (`Carry on.` without a note). After
  a restart you asked for, the prompt says you did, and that its MCP servers, settings, hooks,
  skills and CLAUDE.md are loaded anew.
- How far it got is kept in the entry (`step`): a board that stops halfway leaves the session
  asleep at worst, and the next one wakes it and types the note.
- Wake refusing or failing is tried again, three times in all. Then an agent hears
  `[board reminder] restart did not happen: <why>. Your note for after it: <note>` once it is
  free; so it does when background tasks held it for 10 minutes. Asked again meanwhile, the new
  restart replaces that note. A restart you asked for types nothing then: a toast says it, and
  the schedule's log ("Did not happen"). A session that could not be woken sleeps on; a message
  wakes it.
- The card says it in a line of its own: "Restart" and what it waits for, then "Restarting…"
  with turning arrows while Claude exits and comes back. The card stays whole meanwhile, also
  while the session is asleep for that moment. The sheet lists it under "Schedule" with its
  trash can; the terminal board shows `↻`.
- `board restart` refuses at once, and schedules nothing, while wake is off or does not answer (it
  says how to restart by hand instead), and outside a herdr pane. The web board's "Restart" refuses
  alike, and needs fresh herdr data, as "Put to sleep" does.
- A restart ends whatever lives in that Claude process: background agents and workflows,
  teammates, CronCreate and ScheduleWakeup jobs. A background command or a Monitor holds it
  instead (above). The [`herdr-agents`](skills/herdr-agents/SKILL.md) skill tells agents to
  finish or stop them first and to put what is due later into `board remind`.
- A restart is for the session that asked: after `/clear` (a new session id in that pane), or
  with another Claude started there, it waits as for a session that is gone, unlike a reminder.
- With more than one Claude profile, a restart ends in a wake in the session's own profile
  ([Claude profiles](#claude-profiles)), so a work session restarts in work. While the separate
  herdr-wake plugin does the waking, it follows that plugin's wake rule
  ([Schedule](#schedule)): a session the board could not wake again in its own profile (started
  outside the board in another profile than the board's, or in a pane the board opened with
  another profile's env) is refused before anything is put to sleep, with that rule's reason.
  `board restart` and the web board's "Restart" refuse it at once and schedule nothing
  (`board restart` asks the running board which profile is its own, as its own env may be the
  session's); one asked for before is given up by the scheduler, without a sleep, and the
  session (or, for one you asked for, the log and a toast) hears why. "Is a background command
  running" is read in the session's own profile's registry (`<profile folder>/sessions`). With
  one profile it is all as above.

## Several to sleep at once

A session that coordinates others (one that polls every session at the end of the day, say) puts
the ones it is done with to sleep in one call, instead of one wake `POST /sleep` each:

```sh
board sleep Report-north Report-south w2:p7 3f2a9c1e-...   # names, panes or session ids
board sleep --when-free Report-north Report-south           # the busy ones once they are free
board sleep --when-free Report-north --self                 # and this session, once its turn is over
```

- Every session that is free now goes to sleep at once through wake (four at a time), by
  the checks a restart makes: its turn over (for herdr and in Claude's own registry), no dialog,
  no text the user started typing, no background command or Monitor. The command prints a line
  for each: asleep, asleep already, or kept up and why (working, a dialog, unsent text in its
  input box, background tasks, wake refused, not a Claude session, no such session on the
  board, a name several sessions go by). A session id or a pane names one exactly; a name two
  sessions go by takes neither, and says so.
- `--when-free`: one held by its turn, a dialog, a draft or background tasks (or that wake
  refused just now) gets a schedule entry of kind `sleep` instead, due at once, and goes to sleep
  once it is free; its line gives the entry's id (`board unschedule <id>` cancels it). Asked again,
  it stays one entry. The scheduler waits for it as for a reminder (`scheduleWaitMin`, 240
  minutes), then logs it as missed; wake refusing is tried three times, then the log says it
  did not happen. Nothing is typed into the session, and nothing wakes it: one asleep by other
  means meanwhile counts as done. Like a restart, it is for that session only (not the one after
  `/clear` in its pane), and archiving the session drops it.
- `--self`: the session running the command too, found as `board doing` finds it (its
  `CLAUDE_CODE_SESSION_ID`, else the session herdr sees in its pane), so it need not know its own
  name. It is in a turn then, so it always goes as with `--when-free`, last; the others named with
  it only when `--when-free` is given; a target that names it too goes with `--self`, one line.
  End the turn after it: the session goes to sleep once it is free, its entry waiting as any
  `--when-free` one does; a new turn meanwhile does not cancel it. The skill tells agents to do it
  only when the user asks or a coordinating session's run is over, not by default. Outside a
  session, or for one the board does not know, it refuses and puts nothing to sleep.
- With wake off, or when it does not answer, it refuses at once and puts nothing to sleep.
- For agents that talk to the board over HTTP: `POST /api/sleep` with header `X-Board: 1` and
  `{"targets": ["<id|name|pane>", ...], "whenFree": true}` answers `{ ok, results }`, one per
  target: `result` (`asleep`, `already`, `scheduled`, `kept`), `why` (`busy`, `dialog`, `draft`,
  `tasks`, `gone`, `unknown`, `ambiguous`, `notClaude`, `profile`, `refused`, `error`), `detail`,
  and the session's `key`, `name`, `pane`, and `id` of a scheduled one. It needs fresh herdr data,
  as "Put to sleep" does (`src/services/sleep.ts`, `src/server/routes/sleep.ts`).

## Sleep and wake

A sleeping session costs nothing: its Claude has exited, and its pane is closed, with its tab when
nothing but herdr-sidebar's panes was beside it, so it holds no shell and no sidebar (below). It
comes back in a new tab of its workspace with the same session id and conversation, its card,
name, lane and reminders as they were. The board does this itself,
on every install, with nothing to install or run (it did it through the separate
[herdr-wake](herdr-wake/) plugin before, on Node.js). By itself it does nothing: no session is put
to sleep, woken or typed into until someone clicks "Put to sleep", "Wake" or "Restart", runs
`board sleep` or `board restart`, sends a sleeping session a message or a reminder, or turns the
reaper or the Telegram router on.

**How it runs.** herdr starts it with the board: a startup entry of its own
(`src/entrypoints/wake-start.ts`), which the board's start never waits for, so the board opens
whatever wake does. It opens one pane in a workspace of its own, `Wake`, which shows its log. In
that pane a supervisor (`src/entrypoints/wake-run.ts`) runs the wake process
(`src/entrypoints/wake.ts`), which listens on `127.0.0.1:12421` only: the API the board, the hooks
and herdr's actions use, and what keeps it to one per computer. The supervisor starts it again after
a crash (after 2, 10, then 30 seconds), ends it when its API stops answering, and stops after 5
crashes in 10 minutes, the last error on screen, in Settings and in `board doctor`. After a restart
of herdr, a wake pane brought back as a bare shell is closed and a new one opened. When wake is on
and does not answer, the board starts it once more itself; "Start" in Settings does too. Wake
reads the sessions of every Claude profile, every 15 seconds; its files are in the board's state
folder (`%LOCALAPPDATA%\herdr\plugins\agent-board` on Windows): `wake-sessions.json` (the sessions
it knows, by pane), `wake-pi.json` (the pi sessions asleep, below), `wake-status.json` (its state),
`wake.log` (kept to 2 MB, the one before as `wake.log.1`).

**Settings → "Sleep and wake…"** (its switches and buttons on the computer's own board only; a
phone sees it read only):

- **Sleep and wake**, on or off. On from the install; on starts it at once. Off stops it, closes
  its pane, and the `Wake` workspace when nothing else is in it; nothing of wake runs then, no
  herdr call, and its hooks ask nothing. Sessions asleep when it goes off stay on the board and
  wake from their cards: the board types the resume line into the pane itself, as wake would. "Put
  to sleep", `board sleep` and a new restart say wake is off. `"wake": false` in config.json turns
  it off as the switch does; so does a config.json that does not parse, a `wake` that is not
  `true`, `false` or a section, or an `enabled` that is not `true` or `false` (`"enabled": "yes"`,
  say): a switch that cannot be read is off.
- **Its state**: Off (and how many still sleep), Starting…, Running since when and how many are
  asleep, Crashed with its last error ("Start again" closes its pane and opens a new one, "Log"
  shows the end of `wake.log`), Not running (its pane was closed by hand, say; "Start"), "The
  separate herdr-wake plugin does this now" (below), or "Port 12421 is taken by another program"
  (set another `port` in the `wake` section). On but not running for more than a minute, the
  toolbar has a quiet "Wake stopped" note that opens the panel.
- **Put idle sessions to sleep** (the reaper), off by default, after 60 minutes, and the sessions
  never to put to sleep: names, workspace labels or titles, exact in any case, or `/regex/`, one
  per line.
- **Telegram messages (tg-mcp)**: Auto or Off, Off by default. While wake runs it says what it
  found: "connected to <host>", "no tg-mcp set up", or the last poll's error.
- **Install claude-tg**: the launcher below.
- A shown profile whose `settings.json` lacks wake's hooks is named, with Install (as the Profiles
  panel's), and so is one that has the separate herdr-wake plugin's.

Each of these is in config.json's `wake` section too (below), and a change made there by hand
takes effect the same way, without a restart.

**The reaper.** Every minute, with it on, a session goes to sleep (`/exit` typed into it) when all
of these hold: Claude reports it idle for at least the minutes set (a busy one, or one with a
background command or a Monitor, stays up); herdr sees it idle too, not on a question; its pane is
not the focused one and its input box holds no draft; it is not in the list never to put to sleep;
its conversation shows no CronCreate or ScheduleWakeup call in the last 7 days (such jobs live in
the session and would stop with it); and it could be woken again in its profile
([Claude profiles](#claude-profiles)). When `/exit` asks whether to stop background tasks, wake
cancels and leaves it running. At most `maxPerRound` (3) go to sleep a minute.
`bun src/entrypoints/wake.ts --reap-dry`, in the plugin's folder, prints the verdict for every
Claude pane without putting anything to sleep.

**A session you `/exit` yourself** counts as asleep too while its pane stays open, reaper on or
not: within 15 seconds its pane is marked `💤` and its card offers Wake, and ListAgents,
SendMessage and Telegram take it for asleep. Only sessions seen running in the last 10 minutes
count, so an old shell stays a shell. Close the pane to be done with a session for good.

**Its pane given back.** Once Claude has left, wake closes the pane where the session comes back
in the same Telegram topic ([Telegram](#telegram): a workspace's first tab is `topic:<workspace>`,
the others `topic:<workspace> / <tab>`, and herdr opens a new tab at the end of its workspace):

- a tab that is not its workspace's first: the tab goes, sidebar and all, when only herdr-sidebar's
  panes are beside the session; with a pane of yours beside it, only the session's pane goes and
  the tab stays;
- a workspace's only tab, nothing but sidebars beside the session: the tab goes, and the workspace
  with it, unless another sleeper whose pane was closed comes back to that workspace (whichever woke
  first would take its first tab and the other's topic);
- the first tab of a workspace with other tabs, or one with a pane of yours beside the session,
  keeps its pane as before, labelled `💤 <name>` with the wake line typed at its prompt: closing it
  would move the session, and the tab after it, to other topics.

Only a pane at its shell's prompt is closed: nothing started in it since Claude left, nothing
typed at the last prompt on its screen but the session's own wake line (wake's, or the old
plugin's, wrapped or not), and nothing in its tab focused (the tab you are looking at stays). A
screen without a prompt, or with PowerShell's `>>` continuation prompt, keeps the pane. Sessions
already asleep in a kept pane when this came in (labelled `💤 <name>` by wake) get it closed once
by the same rule, at a look of wake's with this on that herdr answered; then `wake-tidy.json` in
the state folder says it is done, and no later start does it again. One you `/exit` yourself
keeps its pane (below). The session's card keeps the panes it had, so the board's
links still find the session a `spawn-agent` started in one of them, and its reminders follow it
to the pane it wakes in.

What this changes for every setup: a woken session's tab comes back at the end of its workspace
(a whole workspace at the end of herdr's list), not where it was, since herdr's command line cannot
move a tab. `"closePanes": false` in the `wake` section keeps every pane, and the old behaviour, as
before; the panes given back by then wake in new tabs all the same.

**Waking** a session whose pane was given back opens a new tab in its workspace (while herdr has it
under the label it had, else one of that label; a new workspace of its label when there is none),
in its folder, under its tab's label, and runs `board resume <id> --profile <id>` there. One in a kept pane
gets that line typed into its pane, after clearing what is at its prompt (Esc for PowerShell and
cmd, Ctrl+U for bash, zsh, fish and sh, by the shell herdr says runs there). Either way wake waits
for Claude to come up (`wakeTimeoutSec`, 120), answering the development-channels confirmation if
it asks; one that does not come up in its new tab sleeps on there, `💤 <name>`, for the next wake. So a session wakes in its own profile and its
project folder, whatever the pane's shell has ([Claude profiles](#claude-profiles)). A Wake while
wake is slow to answer types nothing (wake may be waking that very session): the board says so.

**Its hooks.** The install puts two Claude Code hooks into each shown profile while wake is on
(`src/entrypoints/wake-hook.ts`, run with the Bun the install ran): after `ListAgents`, the
sleeping sessions of the caller's own profile (those asleep for less than `listSleepingDays`, 7,
at most 15; the rest only counted, all of them wakeable by name) and how long its running ones have
been idle or busy and when they go to sleep; before `SendMessage` to a sleeping session of its own
profile, a wake first, by its session id (refused: the message is not sent, and the agent hears
why). A name only another profile has is left to Claude Code. Neither runs on any other tool, nor
on every prompt, and neither asks anything while wake is off. The install does not write them
beside the separate herdr-wake plugin's: it says so, and "Switch over…" moves them.

**pi sessions** sleep and wake too, when asked: "Put to sleep" on a pi card, `board sleep` (several
at once, `--when-free`), and Wake, a message or a reminder for a sleeping one, or a Telegram
message to its tab. The reaper leaves them alone, and so does the separate herdr-wake plugin. Only a
pi that is free goes to sleep: herdr says it is idle, nothing is typed in its input box, and in its
session file the last turn is over (its last message is pi's own and calls no tool; what pi writes
after a turn, such as its name or a model change, does not count). Wake keeps what brings it back
in `wake-pi.json` beside `wake-sessions.json`, by the session file: the pane, its workspace, the
folder, pi's command line as `herdr pane process-info` shows it, the provider in the session file,
and the Claude account folder pi's bridge ran with (pi's `CLAUDE_CONFIG_DIR`, read from the process
on Linux; elsewhere the profile its card was last told). Then it stops pi and every process pi
started (its MCP servers hold most of its memory): pi gets SIGTERM and 15 seconds, the rest what
pi left of them. The pane is labelled `💤 <name>`, with `board resume --pi <id>` typed at its
prompt, not run.

Its card stays on the board, in its lane, under its session file's key, and keeps showing after wake,
herdr or the computer restarts: wake lists it from its file, the board reads that file itself while
wake does not answer. Its pane counts as its own while herdr has it as a shell in its folder or with
its label; otherwise the card shows no pane. Waking runs `board resume --pi <id>` in that pane,
after clearing its prompt; when it has none, in a new tab of the same workspace, in its folder (a
new workspace of that name when that is gone too). Where it woke is where a message or a reminder
then goes. `board resume --pi <id>` runs pi on the same session file with the command line it had,
less what would start another conversation or set its model (a message, `@files`, `--session`,
`--name`, `--model`, `--provider`, `--thinking`, `--continue`, `--resume`, `--fork`, `--print`), and
with the account folder it had (as `board resume` does for a Claude session's profile). pi takes
the model and provider back from the session file itself, so a session on `claude-bridge-work`, or
on the bridge with Work's folder, comes back on Work, never on the personal account. A pi started
with an option pi does not list, in its `--name value` form (an extension's), is not put to sleep:
whether the next word is its value or a message cannot be told. Woken by hand (Enter on the typed
line), it is awake at wake's next look; one whose session file is gone is forgotten.

A pane where pi was stopped by hand, a shell now, is taken as that session asleep there with
`board sleep <pane> --pi-session <session file>`: its card comes back as a sleeping one, with the
account its card was last told.

**herdr's actions** for the focused pane, as herdr-wake's were: `agent-board.sleep` and
`agent-board.wake`. Bind them to keys as the board's key is bound ([Setup](#setup)), with
`command = "agent-board.sleep"`.

**The API**, for programs on this computer: `GET /status`, `GET /sleeping`, `GET /awake` (running
sessions: status, since when, minutes until sleep or why they stay up), `POST /wake {"target": …}`,
`POST /sleep {"target": …}`, a target being a session name, a pane id or a session id; herdr-wake's
paths and answers, plus each session's `profile` (`{ dir, id }`). pi's sleepers are listed by
`GET /sleeping?agents=all` only, after Claude's, each with `agent: "pi"` and its `cwd` (`pane` empty
when it would wake in a new tab); `/sleeping` stays Claude's, which the hooks read. A pi session's
target is its session file, its id or its pane; `POST /sleep {"target": <pane>, "piSession": <file>}`
takes a pane where pi was stopped by hand as that session asleep. A request from a web page (an
`Origin`, or a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`) is refused.

### Telegram

With [tg-mcp](https://github.com/Eithery-rc/tg-mcp) in router mode (`ROUTER=1` in its `.env`, tg-mcp
0.2.0 or newer) and Telegram set to Auto, your Telegram messages reach sessions without Claude
Code channels: wake long-polls tg-mcp, finds the pane a message is for, wakes the session there if
it sleeps, and types the message in, starting with `[telegram message_id=… ]` (tg-mcp tells agents
to answer such prompts with `send`). Sessions can then drop
`--dangerously-load-development-channels` and `X-Channel`. tg-mcp's url and token are the `wake`
section's `url` and `authorization`, else those of the `telegram` MCP server in `~/.claude.json`
(`server` names another). The routing is herdr-wake's:

1. The pane behind the bot message you replied to, the panes connected to tg-mcp for the topic,
   then the panes the topic's key names: `topic:<workspace>` or `topic:<workspace> / <tab>` names a
   herdr tab (what claude-tg sends), any other key is matched against the panes' folders.
2. A pane running Claude wins; else a pane whose last Claude session wake has seen is woken there.
3. Delivered: 👀 (and a note when it woke the session). A session waiting on a decision, or with
   text you are typing in its input box, gets it later, said once. No pane fits: the message goes
   back to tg-mcp's queue with a note. The folder trust question is left to you.

For exact routing, let sessions tell tg-mcp their pane: a header on the `telegram` MCP server in
`~/.claude.json`, next to `X-Cwd`, `X-Herdr-Pane: ${COMPUTERNAME:-}:${HERDR_PANE_ID:-}` on Windows,
`X-Herdr-Pane: ${HERDR_PANE_ID:-}` elsewhere. `bun src/entrypoints/wake.ts --deliver "<key>"
"<text>"` routes one message by hand, tg-mcp not asked.

**claude-tg**, a Telegram topic per herdr tab: a launcher that starts Claude Code with `TG_KEY` set
to the tab's topic (`topic:<workspace>` for a workspace's first tab, `topic:<workspace> / <tab>`
for the others, non-ASCII dropped; the folder outside herdr), which the `telegram` MCP server sends
as `X-Cwd: ${TG_KEY:-}`. "Install claude-tg" in the panel puts `claude-tg` and `claude-tg.cmd` into
`~/.local/bin`, beside `board`; they take the key from `board tg-key` and need no Node. One that
is not the board's (nor herdr-wake's) is left alone, and said. The install refreshes herdr-wake's
old ones. Then `"launch": { "claude": ["claude-tg", "--dangerously-skip-permissions"] }` in the
board's config.json (without the flag if you run Claude with permission prompts). See
[tg-mcp's README](https://github.com/Eithery-rc/tg-mcp#herdr-launcher) for the server side.

### Switching over from herdr-wake

While the separate herdr-wake plugin is installed, nothing changes: the board talks to it at
`wakeUrl` as before, with its old profile rule ([Claude profiles](#claude-profiles)); the board's
own wake holds back (its start asks herdr for the plugin list once and ends), and the install
writes no hook of its own beside the old ones. The panel says "The separate herdr-wake plugin does
this now", with **"Switch over…"**, which asks once, listing what it will do, then:

1. takes over the old `config.json` into the `wake` section (the reaper, its list, Telegram's url,
   token and server, the port and timeouts; Telegram Auto when the old router had a url and
   token), and its sleeping sessions of the last 7 days into `wake-sessions.json`;
2. compares the old `wakeCommand` with `launch.claude` and, when they start different programs
   (`claude-tg --resume {session}` against `claude`), says how to keep yours in `launch.claude`;
3. uninstalls the plugin (`herdr plugin uninstall herdr-wake`);
4. takes its hooks out of every profile's `settings.json` and puts the board's in, each file
   backed up first (`settings.json.bak-wake-takeover`, then `-1`, `-2`…);
5. closes its `tg-router` workspace when nothing but shells and sidebar panes is in it;
6. turns wake on, if it was off, and starts it;
7. names herdr key bindings that call `herdr-wake.sleep` or `herdr-wake.wake`, with their new
   names (`agent-board.sleep`, `agent-board.wake`); herdr's `config.toml` is not changed.

The panel then says what it took over ("reaper on, 60 min, 2 excluded; Telegram; 4 sleeping
sessions"). Both take over only sessions seen or put to sleep in the last 7 days. Removed by hand
instead (`herdr plugin uninstall herdr-wake`), the same takeover, but for the uninstall, runs once
at wake's next start, without a click: it leaves the reaper and Telegram off (turn them on in the
panel), and the panel and `board doctor` say so until you dismiss it. The old plugin's config and
state folders are left where they are. Back to it: `"wake": false`, the plugin installed again,
and each `settings.json` from its backup.

### The `wake` section

In the board's config.json, every key optional; no section is all the defaults (on):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | wake on; `"wake": false` is `enabled: false` |
| `reaper.enabled` | `false` | put idle sessions to sleep |
| `reaper.idleMinutes` | `60` | how long a session must sit idle |
| `reaper.exclude` | `[]` | names, workspace labels or titles never to put to sleep; exact (any case) or `"/regex/"` |
| `reaper.maxPerRound` | `3` | sessions put to sleep per minute at most |
| `telegram` | `"off"` | `"auto"`: the Telegram router, when tg-mcp's url and token are found |
| `url`, `authorization` | from `~/.claude.json` | tg-mcp's base url (without `/mcp`) and its `Authorization` header |
| `server` | `telegram` | the MCP server in `~/.claude.json` to take them from |
| `port` | `12421` | the API on 127.0.0.1, and what keeps wake to one process |
| `workspace` | `Wake` | the herdr workspace of wake's pane |
| `wakeTimeoutSec` | `120` | how long a wake waits for the session |
| `pollTimeoutSec` | `25` | the Telegram long poll |
| `listSleepingDays` | `7` | ListAgents lists sessions asleep for less than this |
| `closePanes` | `true` | a session put to sleep gives its pane back (and its tab, when only herdr-sidebar's panes are beside it) and wakes in a new tab; `false`: its pane stays, `💤 <name>` |

There is no `wakeCommand`: every wake is `board resume`, and `launch.claude` says how Claude
starts. `wakeUrl` is used only while wake is off or held by the separate plugin.

## Archive

Sessions pile up: one-off jobs that are done, sessions asleep for days. "Archive" takes one off
the board. The board mirrors herdr, so the session's pane closes (its tab, when nothing else is in
it); Claude keeps the conversation on disk, so it can come back.

- No confirmation, forgiveness instead: the card flies into the Archive button on the toolbar
  and a toast says "<name> archived · Return" for a few seconds. Its pane closes 8 seconds after
  the click (`archiveUndoSec` in config.json), so Return (or Ctrl+Z) in that time puts the card back as it was, nothing closed.
  That wait is kept in the archive's record on disk: a reload of the page or a restart of the
  board in between changes nothing (a board that starts closes the ones that are due).
- Or drag the card there: while a card is dragged (with a mouse), an "Archive" place comes up at
  the foot of the board and lights up while the card is over it; let go there, or flick the card
  at it from close by. It goes the same way, with the same toast. A session that may not go yet
  shows why on that place, and a drop on it puts the card back.
- Only a session that is free goes: a Claude session (Return resumes it by its id), its turn
  over, no dialog in its terminal, no helpers at work, no restart under way. The menu item is
  gray with the reason. What only herdr can tell is checked when you click (text you started
  typing in its input box, a background command or Monitor) and again right before the pane
  closes: a session that got to work meanwhile (a Telegram message, another session) stays on the
  board, and a toast says why. A sleeping session goes as it is: its pane with the 💤 closes, or
  none when wake closed it. A shell with no Claude in it is closed only as wake left it, marked 💤
  with nothing running in it but the shell; a Claude that exited by itself, or a program started
  there, keeps the pane.
- Its reminders and repeating pings wait in the record and come back with it: under their old
  ids, a repeating one from its next run, a one-off that came due meanwhile late (the prompt says
  by how much). A restart on its way is dropped: a resume is one. A MokuPilot report with a
  receipt keeps the session on the board until it is delivered.
- The card file stays as it was (name, lane, notes), so the session comes back with them, also
  when you resume it by hand elsewhere.
- Many at once: the menu of the "Idle" column (its head, or a lane's "Idle" in a narrow window)
  and a lane's menu offer "Archive the sleeping ones": asleep for over a day, 3 days, a week, or
  all of them, each with its count. Only sleeping sessions in "Idle": those that wait on you or
  on someone else stay, and so do [favorites](#favorites). One toast, one Return for all.
- "Archive" on the toolbar opens the list, by the day each went, newest first, with a search over
  the name, lane, folder, what the card said last and the day. While sleeping sessions have sat
  in "Idle" for over 3 days, it offers to take them along. Each row has Return and, two clicks,
  "Remove from the archive": the record, the card and the held reminders go; Claude's
  transcript is never touched.
- Return from the list (or a toast whose time is up) resumes the session in a new herdr tab the way new sessions start (see
  [New sessions](#new-sessions)): `launch.claude --resume <id>` through the board's spawn-agent,
  `{resume}` for your own `launch.command` (without it the board's spawn-agent does it),
  `--resume <id>` after `launch.args` for `launch.agent`. It runs in the folder the session ran
  in (Claude finds a session by its folder), in its old workspace while herdr has it, else the
  workspace of its lane, else a new one of its old name. Its card shows in its lane as "back"
  while Claude starts, and becomes the session's own once herdr shows it; one that fails says why
  and offers Return again. A session whose transcript is gone cannot come back, and Return says so. Two Returns at once
  (two windows, say) start it once.
- Agents: `board archive --session <id|name|pane>` takes another session off the board by the same
  rules, its pane closed at once (no undo time: there is no toast to offer it). A session id or a
  pane names one exactly; a name two sessions go by takes neither, and says so. A session cannot
  archive itself: its turn is on while it asks. The [`herdr-agents`](skills/herdr-agents/SKILL.md)
  skill allows it for a one-off session the agent started, or when the user asks.
- Wake takes a closed pane for a session that is over; Return starts it again in a new pane,
  which wake then treats like any other.
- With more than one Claude profile, a session goes to the archive with its profile, and Return
  resumes it in that profile or not at all: one whose profile the board cannot be sure of is not
  archived, and Return refuses one it cannot place, with the reason (resume it yourself in its
  profile). Its transcript is looked for in that profile's folder only. A row in the list carries
  its profile's tag, as its card did. With one profile it is all as above.

One file per session in `%LOCALAPPDATA%\herdr\plugins\agent-board\archive\<session id>.json`, written
under the same per-file lock as the cards; `log.jsonl` there keeps what became of the latest
(closed, kept on the board, returned, removed). The scheduler closes the due ones
(`src/core/archive.ts`, `src/adapters/archive-store.ts`, `src/services/archive.ts`,
`web/src/hooks/useArchive.ts`, `web/src/components/archive/ArchivePanel.tsx`).

## Notifications

On Windows, `herdr plugin action invoke agent-board.notifications` (`bun src/entrypoints/install.ts
--toast`) adds Claude Code hooks that show a Windows notification in the agent's own words:

- a session finished its turn: its last reply;
- it needs a permission or asks for input (Notification, `permission_prompt` and
  `elicitation_dialog`): Claude's message;
- it asks a question (AskUserQuestion): the question.

The title is `<workspace> · <session>`. None comes for the pane you are looking at (focused in
herdr, with the terminal in front), for a subagent, or for a `claude -p` run inside a session. A
newer one replaces the pane's last one in the notification center. They make no sound (herdr
plays its own). A click opens that session on the web board when the board runs and has it (as
`src/entrypoints/web-open.ts --pane` does); else herdr goes to the pane and the terminal comes to
the front.

The click goes through a `claude-pane:<pane id>` link, a URL protocol the script registers for
the current user (`HKCU\Software\Classes\claude-pane`, and the app id `Herdr.ClaudeAgent` that
names the notifications). Any program or page can open such a link, so the handler takes nothing
but a pane id (`w1:p2`) and only shows or focuses that pane.

Keep herdr's own notifications off (`[ui.toast] delivery = "off"`, herdr's default), or each
comes twice; `board doctor` says when they are on, and when another hook with "toast" in its
command shows them too (a script of your own from before: take it out of settings.json). `bun
src/entrypoints/install.ts --no-toast` takes the hooks out again (the protocol entry stays; it
only ever opens a pane). The hooks run `powershell -File src\integrations\toast.ps1` from the
plugin's folder, in the background, so Claude does not wait for them; a click finds Bun on PATH
(else `~\.bun\bin\bun.exe`). To see one, from a herdr pane (`force` shows it for the pane you are
in):

```powershell
'{"hook_event_name":"Stop","last_assistant_message":"Hello"}' | powershell -NoProfile -File src\integrations\toast.ps1 force
```

On Linux and macOS the board shows none; herdr's own (`delivery = "system"`) say that a session
finished, without its words.

## Presence

Off unless you turn it on. The board can keep whether you are at the computer ("here") or away
from it ("away"), so each session knows where its news should go: while you are away, it also
sends results, questions and blockers to wherever you read them away from the computer (Telegram,
say, if that session has a way to); while you are here, the board and the terminal are enough.

Settings → Presence turns it on, or `presence` in config.json:

```json
"presence": { "mode": "auto", "idleMinutes": 15 }
```

`true` is the same as `{ "mode": "auto" }`. The modes:

- `auto` (the default): the board switches by itself. You count as away after `idleMinutes`
  without keyboard or mouse input, or once the screen is locked. You count as here again on input,
  on unlocking, or on using the board's page on this computer.
- `suggest`: the board only offers the switch, next to the toolbar's switch.
- `off`: the manual switch alone.

A switch by hand wins until the next clear change. Press "away" at the keyboard and the input right
after does not bring you back; once you have actually gone and come back, it does. The same goes
for "here" while the screen still counts as idle.

To switch it:

- the board: the toolbar's Here / Away switch, which is also on the phone and in the PWA;
- the command line: `board presence` prints the state, `board presence here|away` sets it, and
  `board away [on|off]` does the same;
- HTTP: `GET /api/presence` gives `{ presence }`, which is null while presence is off.
  `POST /api/presence` with `x-board: 1` takes `{ "state": "here" | "away", "from": "phone" }` to
  switch, or `{ "op": "settings", "on": true, "mode": "suggest", "idleMinutes": 10 }` to change
  the settings. The phone and the Android app use these.

While presence is off, a switch is refused and no state is kept. Turning it off forgets the state.

Nothing is ever sent or typed into a session for it: no reminder, no message, no notification.
Sessions read it passively. A session told of the board (SessionStart) gets a line on the current
state in its context. A prompt (UserPromptSubmit) after a change gets the new line once. `board
presence` prints it at any time. Sessions running when presence was turned on hear of it on their
next prompt. The state lives in `presence.json` in the board's state folder (`src/core/presence.ts`,
`src/adapters/presence-store.ts`, `src/services/presence.ts`, `src/server/routes/presence.ts`).

Detection asks the computer every 30 seconds (`src/adapters/idle.ts`), only while the mode is
`auto` or `suggest`:

- Windows: idle time and a locked screen, from PowerShell;
- macOS: idle time from `ioreg` (a locked screen is not seen yet);
- Linux: logind (`loginctl`: idle and locked hints), `xprintidle` on X11, GNOME's idle time and
  screensaver over D-Bus, and a running screen locker (hyprlock, swaylock, i3lock...). On a
  Wayland desktop with none of these, only the board's page and the manual switch count.

`detects` in `GET /api/presence` says whether this computer told the board anything at its last ask.

## Tasks

An experiment (#202), off unless you turn it on. An agent answers with five points: two are
yours to do, three are unclear, and the talk about those three pushes the first two up the thread
until they are lost. Tasks keep them: one list across sessions, each point with the session it
came from.

Settings → Tasks turns it on, or `todos` in config.json:

- **My pins only** (`"todos": { "agents": false }`): you pin points yourself; agents are told
  nothing and `board todo add` is refused. Nothing changes for the agents.
- **Pins and agents** (`"todos": true`): also, Claude sessions are told in their brief to record
  what they hand you to do, and (with `--mine`) a promise of their own they defer, with
  `board todo add`. Nothing else: not their working steps, not questions (those are `board ask`).
- **Off** (no `todos`): no button, no 📌, no brief line. The points stay on the cards and show
  again once it is back on.

**Pinning.** Under an agent's message in a session's sheet, 📌 opens its points: its list items
(bulleted or numbered, at any depth, outside code blocks), or its first paragraph when it has no
list. A point picked is yours to do, checked, and the menu stays open for the next; picked again,
it is unpinned. "As the agent's promise" pins it as the agent's instead. 📌 stays lit, with how
many of its points are pinned.

**The panel.** "Tasks" in the toolbar, with the count of your open points, opens the list across
sessions, grouped by session, the one with the oldest open point first. Mine, Agents' or All. Each
point: its text, its age, Open (the session's sheet), To chat (the point quoted at the top of the
session's message box, the sheet open) and Done. Done points fold under the list, to open again
or remove; they go after 14 days, or past the 30 newest on a card.

An agent closes only its own promises (`board todo done <id>`); the user closes any. The points
live on the cards (`todos`), changed under the card's lock, so the board and `board todo` writing
at once never lose each other's change. Only sessions on the board count: an archived session's
points come back with it.

Not yet (see #202): a jump to the message a point came from (1b), a badge on the card, the open
points in the sheet, the agent told of a point the user pinned as its promise.

## Phones

Off unless you turn it on. With [Tailscale](https://tailscale.com) on this computer and on a phone,
the phone can use the board: an app (such as
[agent-board-android](https://github.com/MokuTeam/agent-board-android)) sees every session, sends
messages, answers questions and permission prompts, wakes and starts sessions, and opens the
terminal, as the web board does. Without Tailscale, from a tablet or another computer: see
[through your own domain](#another-computer-or-a-tablet-through-your-own-domain).

```sh
board remote on                  # or "remote": { "on": true } in config.json
board remote                     # where it listens, who asks to pair, who is paired
board remote approve <id>        # or Approve in Settings → Phones… on the web board
board remote revoke <id>         # the phone's token stops working at once
board remote pwa on              # the board in a phone's browser, below
board remote off
```

On, the board listens on this computer's Tailscale address as well (on the web board's port, or
`remote.port`), never on any other network; the web board stays on 127.0.0.1. What a request on
it needs:

- **The tailnet vouches for it.** The board asks Tailscale who calls (`tailscale whois`): your own
  Tailscale user, or one `remote.allow` lists (`"allow": ["teammate@example.com"]`). Anyone else
  is refused before anything is read.
- **A paired phone.** The app asks to pair; Settings → Phones… opens on the web board with Approve
  and Deny (`board remote approve` does the same), and the request goes after 10 minutes. The phone
  gets its token once; the board keeps only its hash, with the Tailscale device it was given to
  (`remote-devices.json` in the state folder), and takes it from that device only. Unpair (two
  clicks) or `board remote revoke` ends it.
- **Nothing on this computer's screen.** A phone cannot open files or links here, focus herdr or
  raise windows; the board's page itself is not served to it. Everything else answers as for the
  web board, with the same checks.

A firewall that drops what comes in on the Tailscale interface must let the port through (on
Linux with ufw: `sudo ufw allow in on tailscale0 to any port 12422 proto tcp`). Off, nothing
listens and Tailscale is never asked.

`GET /api/hello` says what the board is (`{ board, api, version, host, name, dnsName, platform,
remote }`, `api` 1). On the Tailscale address also: `POST /api/remote/pair` with `{ name }` (202
`{ id }`), `GET /api/remote/pair/<id>` (`pending`, `denied`, once `approved` with `token`, then
`gone`), and with `Authorization: Bearer <token>` the web board's `/api/*` routes plus
`GET /api/peers`: the other computers on the tailnet whose board answers. Code:
`src/core/remote.ts` (the rules), `src/adapters/tailscale.ts`, `src/services/remote.ts` (pairing),
`src/server/remote.ts` (the listener), `src/server/routes/remote.ts`,
`web/src/components/phones/PhonesPanel.tsx`.

### In a phone's browser

No app needed: a phone's browser opens the board, and the board goes on the home screen as an
app (a PWA). A browser installs a page over HTTPS only, so Tailscale gives the board an HTTPS
address of its own: `tailscale serve` puts this computer's Tailscale name, with its real
`*.ts.net` certificate, in front of a listener of the board's on 127.0.0.1.

Once, in the Tailscale admin console, on the [DNS page](https://login.tailscale.com/admin/dns):
**HTTPS Certificates → Enable** (with MagicDNS on). Until then the Phones panel and `board
doctor` say so, and the board sets nothing up.

```sh
board remote pwa on      # or "Set up the HTTPS address" in Settings → Phones…
board remote pwa off     # serve no longer forwards to the board; board remote off does it too
```

`pwa on` turns the remote mode on, runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>`
(the web board's port plus one, or `remote.pwa.port`) and prints the address with a QR code; the
Phones panel shows them too. Serve keeps it across restarts; the board changes it only when you
ask, and takes back only what forwards to it. When port 443 of the name already serves something
else, it refuses: give `remote.pwa.https` another port (8443, say). In config.json:
`"remote": { "on": true, "pwa": { "on": true, "https": 443, "port": 12423 } }`. On Linux,
`tailscale serve` may need `sudo tailscale set --operator=$USER` once.

On the phone, with Tailscale on: open the address, tap **Ask for access**, and approve it on the
computer (Settings → Phones…, or `board remote approve <id>`). Then add it to the home screen:
Share → Add to Home Screen on an iPhone, ⋮ → Install app on Android.

- **Who calls** is checked as on the remote listener: serve tells the board the caller's Tailscale
  address (X-Forwarded-For, which serve sets itself over anything the caller sent), the board asks
  `tailscale whois`, and only your own Tailscale user or one `remote.allow` lists gets in. Serve's
  `Tailscale-User-Login`, when it sends one, must name the same user. The listener for serve is on
  127.0.0.1 only: what reaches it comes from serve or from a program on this computer, which can use
  the web board itself anyway.
- **The token** is in a cookie the page's scripts cannot read (`__Host-`, Secure, HttpOnly,
  SameSite=Strict): an EventSource sends no headers. Anything that changes something needs the
  board's header and comes from the board's own HTTPS address. Unpair ends the token and the
  streams the phone has open (the app's too). The app and the browser on one phone pair each on
  their own.
- **Nothing on this computer's screen**, as for the app; the page leaves out focus, open and show
  in folder.
- **No connection**: a service worker keeps the page's own files (never `/api` or `/uploads`), so
  the app still opens and says what to check.

Code: `src/core/pwa.ts` (the rules), `src/services/pwa.ts` (serve), `src/core/qr.ts`,
`web/src/components/remote/RemoteGate.tsx` (pairing, no connection), `web/sw.js`,
`web/manifest.webmanifest`, `web/styles/pwa.css`.

## Another computer or a tablet, through your own domain

Off unless you turn it on. The board in any browser at `https://<domain>`, a domain of yours on a
server of yours, live, wherever you are, and on the home screen as an app. No Tailscale and no
other platform in the path: the board on this computer keeps a reverse SSH tunnel open to the
server, Caddy there ends HTTPS for the domain and passes requests through the tunnel, and the
board asks for a login of its own on every one of them. This computer opens no port and needs no
public address: it only dials out over SSH. The server holds nothing of the board's: no code, no
secret, no data.

```
tablet / other computer ──HTTPS──> Caddy, https://board.example.com (your server, :443)
                                     │ reverse_proxy unix//var/lib/boardtunnel/board.sock
                                     ▼
                                   sshd ══ reverse tunnel, opened from the PC ══╗
                                                                                ▼
PC:  ssh -N -R <socket>:127.0.0.1:<tunnel port> boardtunnel@<server>
PC:  the board's tunnel listener, 127.0.0.1:<tunnel port>: a login on every request
PC:  the web board, 127.0.0.1:12422: as before, no login, never behind the tunnel
```

The forward ends in a Unix socket on the server, not in a port. While the tunnel is down, a port
on the server's loopback is free for any program there to take, and whatever takes it gets what
the tablet sends: the login's cookie, a password and a code. The socket sits in a folder only the
tunnel's user and Caddy can enter, so only Caddy reaches it, tunnel up or down.

**What a login reaches.** Read this before you turn it on.

- **The board, as a phone has it**: cards, answers, messages, starting sessions, the terminal.
  Not what acts on this computer's screen (opening files, links or windows, focus), nor what
  Settings → Remote access… and Phones… do: those routes answer this computer's own board only.
- **The terminal is a shell on this computer, with your rights.** Through it, or through a session
  it starts (an agent runs commands too), a login can read and change anything you can, the
  board's own files included: the password's hash, the code's secret, the tunnel's key,
  config.json. A login is full access to this computer.
- **The board's own files are not served through the domain.** The routes that read a file by a
  path the request names (quick look, previews, the folder picker, a checkout's changes) refuse
  the state folder (but its `uploads`, where attached pictures are), the config folder and the
  folder of a key of your own. That is all they guarantee: they are fences on the board's routes,
  not on the terminal.

So treat a login like your own shell. That is why it is a passkey, or a password and a code from
an authenticator app, with a lockout; why a login lasts 30 days at most; and why End and End all,
on this computer, stop one at once: its next request is refused and its open streams, the
terminal's too, end.

**What a request through the domain needs.** The tunnel ends at a listener of the board's own on
127.0.0.1 (by default the web board's port plus two), never at the web board's port, and there a
login is needed whatever the request says: no header, setting or state turns it off. Without a
login only what signing in needs answers (the page and its files, a hello that tells nothing of
this computer, the sign-in routes, the board's probe); everything else is 401. Its Host must be
the domain (with its port, when `tunnel.publicPort` is not 443), Caddy must have had it over
HTTPS, and a change needs the board's header and the domain's own Origin. The password's hash,
the code's secret, the passkeys, the logins (only their tokens' hashes), the failed attempts, the
tunnel's private key and the server's pinned key stay in the state folder: none of it goes into
the board's payload, a log, a URL or to the server. Only the code's secret goes, once, to this
computer's panel, for its QR code.

### On the server

The board sets the server up itself. In Settings → Remote access… on the web board, under **On the
server**, you give it the server's address, a login and its password, once; it looks at the server,
says in plain words what it will do, and does it when you click **Apply**. Or, if you would rather
not give it a password, it gives you **one command** to paste into a shell on the server, which
does the same there. Either way you choose nothing: not the web server, not Docker's network, not
the distribution. The examples below use the defaults: the user `boardtunnel`, the socket
`/var/lib/boardtunnel/board.sock`, the domain `board.example.com`. The server is yours alone (it
ends HTTPS, so root there sees what passes), with OpenSSH 7.8 or newer.

**Before you start.** An A (and AAAA) record for the domain points to the server. 22, 80 and 443
are open at your provider (and 8443 when the board ends up there, case 4 below). The socket needs
no firewall rule: it is a file, not a port.

#### Set up the server

Under **The server and its login**:

1. **Address of the board** (the domain). The **Server** is filled in from it; change it, or its
   **port** (22), when you reach the server by another name or port.
2. **Login** and **Password**, the same as for `ssh`: `root` by default, or the user your host
   gave you, the one with sudo. A key works too: **Log in with a key file instead** (below).
3. **Set up the server.** The board logs in once, looks at the server and shows what it found and
   what it will do, in a few lines:

   ```
   What I found
     Debian 13 · Caddy in Docker serves 443 and 80: a.example.com, b.example.com
   What I will do
     Make the board’s own login on the server (boardtunnel), allowed only to hold the tunnel.
     Add board.example.com to your Caddy and hand it the board’s tunnel.
     Your sites are not touched; each is checked before and after.
   ```

   Every file, line, container and image it involves, and how Undo removes each, is under
   **Details: every file and line, and how Undo removes them**. Nothing has changed yet. When the
   plan installs Docker, it says so ("Docker is not installed: I will install it from Docker’s own
   repository."), and **Apply** waits for its tick, **OK, install Docker**.
4. **Apply.** The board runs the plan on the server, step by step, and shows each as it goes.
   Then Test connection runs by itself, for up to 2 minutes while the certificate comes. After
   that the panel shows the tunnel's status and "Set up on Oct 23, 10:04 AM: Caddy in Docker" with
   **Undo**, and the login's fields fold away.
5. **Undo**, then **Undo? Click again**, logs in as Set up does: a key that works is enough, else
   it asks for the password again, since the board did not keep it ("Undo logs in to the server
   again: type root’s password, then Continue."). Then it shows its own plan, and its **Undo**
   takes off the server what the board put there.

On a server the board does not set up, the plan says why in one line, and the panel keeps the
commands for such a server, step by step, folded under **Your server needs steps by hand**
(below).

**The password.** The board uses it for that one click and keeps it nowhere: not in config.json,
not in a log, not on the server, not on a command line. It reaches ssh through a small helper of
the board's that answers ssh's password prompt and nothing else, and, when the login is not root
and sudo asks, goes to sudo on its standard input. The panel keeps it in the page while it is
open, from Set up the server to Apply, so you type it once; once Apply or Undo has it, the panel
forgets it too. Apply after the page was reloaded asks for it again, and runs the same plan. The
board tries it once per click: some servers lock a login after a few wrong ones. If sudo wants a
password of its own, the panel then asks for that one too. What the board cannot answer stops
with a hint: a one-time code or any other question, root's login refused by the server
(`PermitRootLogin prohibit-password`, usual on Ubuntu's images: log in as the user with sudo), a
server that takes keys only, or an ssh on this computer older than OpenSSH 8.4 (Windows 11's is
9.x). Then use a key, or the one command.

**A key instead.** With no password typed, the board logs in with what ssh does by default (the
ssh agent, the usual `~/.ssh` keys) or a key file you name. With a password typed, the keys are
tried first and the password after. The board never asks for a key's passphrase (put such a key
in the agent), and never makes, copies or keeps a key of yours.

**The server's key.** The first login pins the server's host key in the board's own known_hosts,
and the plan shows its fingerprint. Compare it with the one your host shows, or with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. The board can show it only once
it has met it, and by then the password has gone to that server: if you cannot trust the network
in between for that first login, log in with a key, or use the one command in your own ssh
session. After the first login, a key that changed is refused.

#### What the board makes on the server

First, what lets its tunnel in and nothing more, each part only where the server lacks it:

- **A login of its own**, the tunnel's user: a system user with no shell and no home
  (`useradd --system --user-group --no-create-home --home-dir /nonexistent --shell
  /usr/sbin/nologin`, then `usermod -p '*'`, since an sshd with `UsePAM no` refuses an account
  `useradd` leaves locked).
- **The socket's folder**, `/var/lib/boardtunnel`: mode `2750`, the tunnel's user and its own
  group. The setgid bit (the `2`) gives the socket the folder's group; the board's web server
  gets that group (case 2 gives the folder Caddy's group instead), and nobody else can open it.
- **The keys file**, `/etc/ssh/authorized_keys/boardtunnel` (root's, mode `644`, out of the tunnel
  user's reach), with the board's key allowed to forward only: `restrict,port-forwarding` before
  the key, on one line.
- **sshd's fence** for that user, the block below, in a file of its own,
  `/etc/ssh/sshd_config.d/00-agent-board.conf`, where sshd_config includes that folder (Debian 12
  and later, Ubuntu 22.04 and later). Where it has no `Include`, the block goes at the end of
  sshd_config between `# >>> agent-board` and `# <<< agent-board`, with `Match all` after it so
  that nothing added below it later is the tunnel user's alone. Then `sshd -t`, then a **reload**,
  never a restart (your open sessions stay), then two checks: the fence is in force for the tunnel
  user (`sshd -T`), and `sshd -T` for root and for the login you gave is what it was before
  (`permitrootlogin`, `passwordauthentication` and every other line). Any difference puts sshd's
  config back and reloads it: your own next login works as before.

```
Match User boardtunnel
    AuthorizedKeysFile /etc/ssh/authorized_keys/boardtunnel
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    PermitListen none
    AllowStreamLocalForwarding remote
    StreamLocalBindUnlink yes
    StreamLocalBindMask 0117
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitTTY no
    ForceCommand /bin/false
    ClientAliveInterval 15
    ClientAliveCountMax 2
```

- `AllowTcpForwarding remote` with `PermitListen none`: no TCP forward either way. sshd lets a
  socket forward through only where remote forwards are allowed, so `AllowTcpForwarding no` would
  refuse the board's own too. `remote` refuses every `-L` and `PermitListen none` every TCP
  listen: the key reaches nothing on the server's network and listens on no port. There is no
  `permitlisten` in the keys file: it limits TCP listens only and says nothing of a socket's path.
- `AllowStreamLocalForwarding remote`: socket forwards from the server to this computer only.
- `StreamLocalBindUnlink yes`: a new forward replaces the socket a dead connection left (after
  sleep or a lost network), so the tunnel is back at once. Without it every new forward fails
  with "remote port forwarding failed for listen path …" until someone removes the file.
- `StreamLocalBindMask 0117`: the socket is `srw-rw----`, its owner and the folder's group only.
- `AuthorizedKeysFile`: the key lives in root's file, out of the tunnel user's reach.
  `ForceCommand` and the nologin shell: it runs no command. `ClientAlive*`: a dead connection's
  sshd ends within about 30 s.
- `PermitListen` needs OpenSSH 7.8 or newer. `KbdInteractiveAuthentication` and not
  `ChallengeResponseAuthentication`: before 8.7, sshd refuses the latter in a `Match` block.

No sshd or `authorized_keys` option names the paths a socket forward may take; the folder does.
Only the tunnel's user (and root) can make a socket in it and only the folder's group can open
it, so no other user on the server can take the path. Elsewhere the tunnel's user can make a
socket only where anyone may write (`/tmp`), and nothing connects to it there. What is left is
the key itself: whoever holds it can take the board's path. The board's probe through the domain
then fails and says so (below); Generate key makes a new key (Apply again puts its line in place
of the old one), and End all ends every login a stand-in may have caught.

Then the web server in front of the tunnel, by what holds 80 and 443:

| On 443 | On 80 | Case | The board's address |
|---|---|---|---|
| nothing | nothing | 1: the board's own Caddy in a container on 80 and 443 | `https://<domain>` |
| nothing | something else | 1b: the board's Caddy on 443 alone (certificate by TLS-ALPN) | `https://<domain>` |
| Caddy as a systemd service | any | 2: a site file of the board's and one `import` line in your Caddyfile | `https://<domain>` |
| Caddy in Docker on a user network, or the host network | any | 3a, 3b: a marked block in your Caddyfile and a small helper container | `https://<domain>` |
| something else | nothing | 4a: the board's Caddy on 8443, and on 80 for the certificate | `https://<domain>:8443` |
| something else | nginx as a service, including `conf.d` | 4b: as 4a; a file of the board's in nginx's `conf.d` passes on the certificate checks | `https://<domain>:8443` |
| anything else | | steps by hand | |

"Anything else": Caddy in Docker on the default bridge only, Apache or Traefik on 80 with 443
taken, two programs on one port; the domain already in your config; Podman, rootless Docker,
Docker with user namespaces, SELinux enforcing; another board's setup on the server. A Caddy the
board does not edit (run from JSON or `--resume`, its admin endpoint or automatic HTTPS off, its
Caddyfile baked into its image, Caddy 1) is left alone: case 4 when 80 allows it, else steps by
hand. Case 4 sets `tunnel.publicPort` to 8443 and its Undo back; open 8443 at your provider.

- **Nothing on 80 and 443 (1, 1b).** Docker, then the board's Caddy in a container of its own:
  `--cap-drop ALL` (it keeps `NET_BIND_SERVICE`), `no-new-privileges`, the socket's folder (not the
  socket) mounted read-only, `--group-add` the folder's group, its config folder
  `/etc/agent-board/caddy` read-only, its certificates in volumes of its own, the images pinned by
  tag and digest.
- **Caddy as a service (2).** The board's site in `/etc/caddy/agent-board/board.caddy`, this one
  line at the end of your Caddyfile, `caddy validate` as Caddy's user, then
  `sudo systemctl reload caddy`; the folder takes Caddy's group:

  ```
  import /etc/caddy/agent-board/board.caddy # agent-board
  ```

  The site is this block (the board's file has it with a comment line first):

```
board.example.com {
    reverse_proxy unix//var/lib/boardtunnel/board.sock
    header Strict-Transport-Security "max-age=31536000"
}
```

- **Caddy in Docker (3a, 3b).** This block at the end of your Caddyfile, written in place (a file
  bind mount keeps the file it had: an editor's save-and-rename would never reach your
  container), validated inside your container, then `caddy reload` there (no restart):

```
# >>> agent-board: the board through its tunnel. Added by "Set up the server"; its Undo removes it.
board.example.com {
	reverse_proxy agent-board-socket:8080
	header Strict-Transport-Security "max-age=31536000"
}
# <<< agent-board
```

  and the board's helper, `alpine/socat` as nobody with the folder's group, read-only, on your
  Caddy's network (3a) or listening on the host's 127.0.0.1:8481 (3b, with `127.0.0.1:8481` in the
  block instead).
- **nginx or something else (4a, 4b).** The board's Caddy on 8443; on 80 too when 80 is free (4a),
  or behind your nginx for `/.well-known/acme-challenge/` of the domain only, through a file of
  its own in `conf.d` (4b). Nothing of yours changes. nginx as the board's own proxy (no Caddy)
  gets this note only: the socket's folder then takes nginx's group (`www-data` on Debian and
  Ubuntu), and the domain's `server` block passes everything to
  `proxy_pass http://unix:/var/lib/boardtunnel/board.sock:;` with `proxy_buffering off;`,
  `proxy_http_version 1.1;`, `proxy_set_header Connection "";`, `proxy_read_timeout 1h;`,
  `proxy_set_header Host $host;`, `proxy_set_header X-Forwarded-For $remote_addr;`,
  `proxy_set_header X-Forwarded-Proto https;`.

Caddy gets and renews the certificate, keeps the Host header, sets `X-Forwarded-For` and
`X-Forwarded-Proto` itself (over anything the caller sent), and passes event streams on at once.
The board's live updates and the terminal are event streams: put no `encode` in front of the board
unless you have checked that they still flow, since compression can hold them back. The board
sends `X-Accel-Buffering: no` on its event streams through the tunnel too.

**Case 3 turns the socket into a TCP port again, inside your Docker.** Your Caddy cannot see the
host's socket, and giving it a mount would mean recreating your container, so the board's helper
passes bytes from a TCP port to the socket. In 3a that port lives in the helper's own network
namespace, on your Caddy's network, not on any of the host's addresses; in 3b it is on the
host's loopback, free while the helper is down. What can connect around your Caddy (your other
containers on that network in 3a, any process on the host in 3b, root) still meets the board's
login on every board route, and can send its own `X-Forwarded-*`, which the board uses only to
show addresses and group its rate limits. While the helper is on your network, `docker compose
down` cannot remove that network and says so ("Resource is still in use"); your containers stop
as usual, and `up` works.

#### How a run goes

- **Looking** reads and changes nothing: who holds 80 and 443 (a systemd unit, a container,
  Docker's proxy), Docker (its version, Podman, rootless, user namespaces), the distribution, the
  config of the web server it would touch (its path, how it is mounted, its host names, its
  hash), what the server has of the tunnel's user, folder, key and sshd's fence, the domain's DNS,
  and an earlier setup's record. Your config's text never leaves the server: only its host names
  and a few facts do.
- **Apply** runs the plan on the server as one script, detached from the connection, under a
  lock, at most 20 minutes. Every step checks before it acts, so Apply twice changes nothing
  ("Nothing to change"). The run first checks that the server is as the look saw it (who holds the
  ports, your config's hash, your container): if not, it stops before any change ("Look again").
  A step that fails rolls back everything the run did, newest first, and says what was put back. A
  lost connection (the PC asleep) neither stops nor half-finishes a run: it ends on the server by
  itself, and the next look reads how. A run told to stop (TERM: the 20 minutes, a shutdown) lets
  its step end, then rolls back; one killed outright (a power cut) leaves a record that names what
  it was changing, and the next look offers its Undo. Where systemd-logind has
  `KillUserProcesses=yes` (off by default on Debian and Ubuntu), a lost connection ends the run
  with your login session: on Debian 13 the step going on is ended and the run rolls back; on
  Ubuntu 26.04 the run is killed outright, and the next look offers its Undo, which puts your
  files back as they were.
- **Undo** looks again first, then shows its own plan: your line or block taken out of your file
  as it is now (not the backup: your edits since stay), your web server checked and reloaded when
  the look finds it running that file (else the file is only edited), the board's containers and
  volumes removed (by name and label: one with the name but not the label is not the board's), its
  images only when it pulled them and nothing else uses them, the folder's group back, a file of
  the board's you edited only when you tick it, Docker only when the board installed it, nothing
  else uses it and you tick it; then what the board made of the tunnel's login (sshd's fence
  first, checked and reloaded as when it went in, then the keys file, the folder and the user),
  and last `/etc/agent-board`. What was on the server before the board came (a tunnel user, a
  folder, a key or a fence you made yourself) stays.
- **sudo.** Root needs none; sudo without a password is used as it is (`sudo -n`); otherwise the
  login's password goes to `env LC_ALL=C sudo -S -p '' -- sh -c 'eval "$(echo <the script in
  base64> | base64 -d)"'` on ssh's standard input, once per click. sudo and sudo-rs (Ubuntu
  25.10's and 26.04's) alike. `requiretty` (classic sudo) and a login without sudo stop with a
  hint: log in as root, or paste the one command into your own terminal.
- **What is kept, and what never is.** On the server, `/etc/agent-board`: the record
  (`setup.json`: the case, the tunnel's user and socket, the domain and port, and each thing the
  board added), backups of your files (for a run's own rollback only), the last five runs'
  scripts and logs, the lock. In config.json, `tunnel.admin` (the login's name and key file, never
  a password) and a summary, `tunnel.setup`. No password is in any of it, on either side, nor in a
  log, a URL, an answer or a command line; a run's output goes to the panel, and `web.log` gets one
  line per step (its name, ✓ or ✗, how long). The record on the server is what Undo follows, so a
  reinstalled board or another PC with the same tunnel user and socket can undo the setup, and the
  board and the one command each see what the other set up.
- **Which servers.** Debian 12 and 13; Ubuntu 22.04, 24.04, 25.10 and 26.04; with sudo, sudo-rs or
  root, and systemd. Docker, when the board installs it, comes from Docker's own apt repository by
  the steps Docker documents, its key checked by fingerprint.

#### Your server needs steps by hand

On a server the board does not set up ("anything else" above), nothing is changed: the plan says
why in one line, and **Your server needs steps by hand**, folded, has the steps for you to paste,
filled in with your values, each with Copy. A server the board does set up never shows them.

**The board’s own login on the server** first, what the board would make (above):

- **All of step 1 in one paste**, once Generate key has made the board's key: the parts below as
  one script that stops at its first error, makes only what is missing, and is safe to paste
  twice. It also makes `/run/sshd` when there is none (an Ubuntu 24.04 sshd no one has connected
  to yet), since `sudo sshd -t` stops without it.
- **The tunnel's user and the socket's folder**:

```sh
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin boardtunnel
# useradd leaves the account locked; an sshd with UsePAM no refuses a locked one, key or not
sudo usermod -p '*' boardtunnel
# the socket's folder: the tunnel user makes the socket; its group is the reader's (step 3)
sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel
# the key's file belongs to root, out of the tunnel user's reach
sudo install -d -m 755 /etc/ssh/authorized_keys
```

- **The keys file, /etc/ssh/authorized_keys/boardtunnel**: this line, with the board's key once
  Generate key has made it:

```
restrict,port-forwarding ssh-ed25519 AAAA… agent-board@<PC>
```

- **At the end of /etc/ssh/sshd_config**: the `Match` block above. Then `sudo sshd -t` and a
  reload (`sudo systemctl try-reload-or-restart ssh`, or `sshd`).

Then **The web server**: for the case Look found, or the one you pick under **What holds 80 and 443
on your server?** (**Nothing on 80 and 443**, **Caddy as a service**, **Caddy in Docker**, **nginx
or something else**, on Debian or Ubuntu), its steps as commands, each with why, what to check
after and how to undo it; what only the server knows is a `<placeholder>`, each with the command
that finds it. For another board's setup on the server, that setup's Undo. **Then Test
connection.**

#### Do it myself (one command)

For when you would rather not give the board a password. **Do it myself (one command)** in the
panel has one line with **Copy**, about 60 KB:

```
echo H4sIAAAA… | base64 -d | gunzip | sh
```

Paste it into an ssh session on the server, as root or as a user with sudo (it runs itself again
with sudo, which asks for your password in your own terminal). It carries what the board knows
(the domain, the tunnel's user and socket, the public port, the board's key) and the board's own
scripts, so you fill in nothing. On the server it looks, chooses as the board would, and prints
what it found and its plan in the same plain words; then it asks once, `Go ahead? [y/N]`, reading
the answer from the terminal, so a paste never changes anything without your yes. Then it runs the
same steps as Apply, with the same record, lock, rollback and checks, and ends with
`done: https://board.example.com`, or with why it stopped and what it put back. On a server the
board does not set up, it stops before changing anything and says why.

- It needs `base64`, `gunzip` (gzip's) and `sh` to start, and `awk`, `sed`, `grep` and `od`;
  every supported distribution has them. Without `base64` or `gunzip` the line stops at once (your
  shell names what is missing) and nothing runs; the others it checks before anything else.
- Then press **Test connection** on the board: it finds the board's address (on 443, else 8443)
  and keeps the port.
- Copied again from the panel and pasted, it says "Set up already" and changes nothing. The
  panel has the Undo command too, under **To undo it later (one command too)**, which follows the
  server's record as the board's Undo does; the board's own Set up the server and Undo see a setup
  the command made, and the other way round.
- **What is inside (the script, readable)** shows the script.
- Opened before the board's address is typed, it says "Type the board’s address first." and makes
  the command once the address is there. The command is in the board's language.

### On this computer

Settings → **Remote access…** on the web board: on this computer's own board only, never through
the domain or Tailscale. It has three parts: Tunnel, Login and Active logins.

1. **The fields**: the server, the user (`boardtunnel`) and the domain; the SSH port (22), the
   key, the socket, the public port (443) and the local port have defaults (see
   [Settings](#settings)). Each is saved on Enter or when you leave it, and checked first: a
   value ssh would read as an option (a leading `-`), a socket right in a folder anyone could
   take its name in (`/tmp`, `/run` and the like), or a port the board has already is refused,
   saying why. Changing the domain later removes the passkeys (they belong to the old one) and
   ends every login; the panel asks first. Changing the public port keeps both.
2. **Generate key**: an Ed25519 key without a passphrase in the state folder (`tunnel/id_ed25519`),
   that only you can read (on Windows the board sets its ACL), and its line for the keys file
   (what the board puts on the server, above), with Copy. Generated again, it replaces the old one, and the server needs the
   new line; the panel asks first. A key of your own (`tunnel.key`) is used as it is: no
   passphrase, its rights yours to set.
3. **Test connection**, with the tunnel still off. Each step ✓ or ✗, with what to fix: ssh and the
   key; the server takes the socket; the domain reaches this board (a fetch of
   `https://<domain>/api/probe/<nonce>` from this computer, with `:<publicPort>` after the domain
   when the public port is not 443). With the tunnel off it runs a short
   ssh of its own to a listener that answers that one probe and nothing else, closed when the test
   is over (within 40 s). With the tunnel on it runs no ssh of its own, since a second forward on
   the same socket would take the tunnel's, and checks the running one.
4. **The server's key.** The first connection pins it in the board's own `known_hosts` in the state
   folder (never `~/.ssh`), and the panel shows its fingerprint: compare it with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. If it changes later, ssh
   refuses and the status says so; **Forget the server's key** when you changed the server on
   purpose.
5. **Login**: the password (12 characters at least) and the code: a QR code for an authenticator
   app, the key as text, and a code to check it with. The codes need this computer's clock right
   to within about 30 s. Changing either later ends every login.
6. **Turn on** (or `board tunnel on`), once the fields check out and the password and the code are
   set up; until then the panel says what is missing.

### On the tablet

Open `https://<domain>`. The board's login screen offers **Sign in with a passkey** first; the
first time on a device, **Use password and code**. Then the page offers **Add a passkey for this
device**: it asks for the next code (the one you signed in with works once only, so wait for the
next, up to 30 s), then Face ID, a fingerprint or the device's PIN. After that, signing in is one
tap. A passkey is added on the device itself: it belongs to the domain, so this computer's board
on 127.0.0.1 cannot make one. The panel lists them, each with Remove, which ends the logins made
with it.

Then Share → Add to Home Screen on an iPad or iPhone, Install app in Chrome or Edge. An app on the
iOS home screen keeps its cookies apart from Safari's, so it signs in once on its own. **Sign out**
is in the page's Settings menu. The domain opened on this computer itself asks for a login too:
the request came through the server. While this computer sleeps or the board is closed, Caddy
answers 502, and the page, kept by its service worker, says so and tries again by itself.

### How it keeps itself up

The board that holds the web port runs ssh: Windows' own (`%SystemRoot%\System32\OpenSSH\ssh.exe`)
first, else `ssh` on PATH; without a shell, with `-F none` so that your `~/.ssh/config` cannot
change it, and with keepalives.

- An ssh that exits starts again after 1 s, then 2, 4 and on up to 60 s; a connection that stayed
  up a minute starts the count over. Errors that do not heal by themselves (the key refused, the
  key's rights, the server's key changed, the server refusing the socket) show as an error with
  what to fix, and are tried again every 60 s.
- After sleep, or when this computer's addresses change (another network), ssh starts again at
  once.
- When the board restarts (its code changed), the new one brings the tunnel back. Only one board
  runs it, never two ssh at a time, and an ssh a killed board left behind is ended first.
- A stale socket on the server is replaced by the next forward (`StreamLocalBindUnlink yes`), so
  the tunnel is back as soon as the network is.

How it stands: off, connecting, connected, reconnecting (the attempt and the next try), or an
error with ssh's own last lines and the fix. While connected, the board fetches its probe through
the domain a few seconds after it connects and every 5 minutes. When that fails (a 502, a TLS
error, something else answering), the tunnel stays connected with a warning that the domain does
not reach this board, and ssh is left alone; a forward on the same socket made with the tunnel's
key would take its place, and this is how you would know.

```sh
board tunnel        # on or off, since when, an error or the warning, the domain, the socket, ssh
board tunnel on     # or Turn on in Settings → Remote access…; refused, saying why, until it can run
board tunnel off
board tunnel test   # Test connection, a line for each step
```

`board doctor` checks it while it is on: ssh found, the key there and taken, the settings, the
password and the code set up, the tunnel's state, and its last probe through the domain.

**No recovery codes, no e-mail.** This computer's board is the way back: a new password, the code
set up again, a lockout lifted. Five failed password-and-code sign-ins in a row lock that way in
for a minute, each further one doubling the wait up to an hour; a passkey sign-in is never locked
out, and every sign-in route is rate-limited. Active logins, in the panel, lists each login (the
device, how it signed in, when, last active, from where) with End, then End all and the recent
failed attempts.

**One tunnel, one computer per domain.** The Android app stays on Tailscale ([Phones](#phones));
the tunnel and the Tailscale listeners are independent, either on without the other.

## Language

English and Russian. Settings (the gear) on the web board's toolbar switches between them; the
choice is `language` in config.json (`"auto"`, the default, follows the system's language,
English when there is no dictionary for it). A switch reaches at once the web board, the
terminal board, error messages, and the agents' next brief, which tells them the language to
write their cards in. Titles you give lanes and whatever agents write stay as written.

All texts live in `src/core/i18n/`, shared by the browser and Bun. Another language is one more
dictionary there plus its plural rule; a test checks that every dictionary has every text.

## Everything updates live

- Cards (agents' `board` calls, edits on either board): instantly.
- herdr state, transcripts, sleeping sessions: every `refreshSec` (2 s).
- config.json, edited by hand or from the web board: the running board reloads it, the web
  board and the terminal board redraw, and the agents' next brief lists the new categories.
- Plugin code: the pane runs `src/entrypoints/run.ts`, which restarts the board when a file in `src/`
  changes (by its time and size: on Windows a plain read fires the watcher too); open web pages
  reload themselves when a file in `web/` changes. A board that crashes starts again by itself
  (after 2 s, then 10 s, then 30 s; after five crashes in ten minutes it waits for the next code
  change), and `web.log` in the state folder keeps the error.

Code: `src/server/`, `web/src/` (React; no build step: the server bundles `web/src/main.tsx` in
memory with Bun; springs in `web/src/models/spring.ts`, the sheet's place in
`web/src/components/panel/` with its geometry in `web/src/models/panel-layout.ts`), styles in
`web/styles/`.

The web API (`GET /api/board` and SSE `/api/events`) includes `stale` and
`lastSuccessfulRefreshAt` (Unix milliseconds, or `null` before the first successful refresh).
A failed refresh keeps the last snapshot and marks it stale; the indicator turns orange until
Herdr data can be collected again. Opening the SSE connection alone does not mark data live.
SSE sends the board again only when it changed (stale included); GET always has the latest
`lastSuccessfulRefreshAt`.

Claude usage (`src/entrypoints/statusline.ts`, `src/adapters/claude-home.ts`): the install action sets Claude Code's status line
to the board's own command when there is none (a status line someone else set stays). Claude runs it
after every reply with the session's state; it keeps the account's 5h and 7d usage windows
(`claude-limits-latest.json` in the state folder, the usagebar shape) and each session's context fill
(`context/<session id>.json`), and prints a short line under the prompt: `ctx 34% · 5h 23% · 7d 41%`.
The board shows the windows as a pill by the live dot (windows past their reset left out) and the
context fill in the sheet; without the status line it falls back to the usagebar cache and to the
tokens of the last request in the transcript.

Files (`src/adapters/files.ts`, `src/server/routes/fs.ts`, `web/src/components/files/`): `POST /api/fs/stat` (which of these paths exist),
`POST /api/fs/preview`, `POST /api/fs/open` (`open` or `reveal`, through explorer.exe, `open`
or `xdg-open`, no shell) and `POST /api/open-url` (http(s) only) need the `X-Board` header like
every POST. `GET /api/fs/raw` serves images, PDF, video and audio, with ranges, to the page's
`<img>`, `<video>` and the quick look's viewers (Word documents and spreadsheets too), which cannot
send headers: it needs the `fsToken` from the
board payload, new on every start, which only the board's own page can read. Text never comes
raw, and raw responses carry a CSP that runs no script. The quick look's viewers
(`web/src/viewers/`, `src/server/viewers.ts`) are scripts of their own beside app.js, each bundled
apart and imported only when such a file is opened: `pdf-viewer.js` (PDF.js, which reads the PDF
through `/api/fs/raw`, in ranges past 8 MB), PDF.js's worker as `pdf.worker.js`, and what the
worker fetches as a PDF needs it under `pdfjs/` (decoders, character maps, fonts);
`document-viewer.js` and `document-worker.js` (mammoth turns the .docx into HTML in the worker,
DOMPurify keeps only its text, structure, web links and pictures as data: URLs in the page);
`spreadsheet-viewer.js` and `spreadsheet-worker.js` (SheetJS reads the workbook in the worker;
the page puts each cell in as text).

New sessions (`src/services/launch/`, `web/src/components/launch/`): `GET /api/launch/options` (herdr's workspaces,
recent folders, the launcher, and `agents`: the agents a start may name, `[{ id, title }]` with
`claude` first and `pi` when it is offered, none with `launch.command` or `launch.agent`; `agent`:
the one a start that names none starts as, `launch.default` when offered), `POST /api/fs/dirs` (the subfolders of a folder, or the drives),
`POST /api/launch` (starts one in the background; `agent`, optional, one of `agents`, else refused
with `field: "agent"`; its progress is `launches` in the board payload, each with its `agent`), `POST /api/launch/<id>/dismiss` and `/focus`. `POST /api/launch` also needs the page's
own `Origin` when the browser sends one, and fresh herdr data like every action through herdr.
Renaming: `POST /api/session/<key>/rename` with `{ name, claude }`. Restarting:
`POST /api/session/<key>/restart` (a schedule entry, see [Restart](#restart); `{ id, again }`).
Archive: `POST /api/session/<key>/archive` (`{ held, dropped, closeAt }`), `GET /api/archive` (its
records), `POST /api/archive` with `{ op: "archive" | "return" | "remove", keys }` (`{ done, failed }`);
the board payload has `archive: { log }`. Archiving and Return need fresh herdr data and the
page's own `Origin`, as a launch does.

Setup (`src/core/setup.ts`, `src/adapters/setup-facts.ts`, `src/services/setup-check.ts`,
`web/src/components/SetupPop.tsx`): `GET /api/setup` runs the checks again and answers
`{ checks, todo, sig }`; the board payload has `setup: { todo, sig }` from the last check.

## Board keys

| Key | Action |
| --- | --- |
| arrows / hjkl, mouse click | select |
| g / G (Home / End) | the first / the last card |
| Enter, double click | go to the session (wakes it if it sleeps) |
| m | send the session a message (typed into its prompt) |
| w | set what it waits for (empty clears) |
| x | clear its card (doing, wait, result, a column set by hand) |
| z | put the session to sleep (wake; idle sessions only) |
| f | a favorite, or not any more (see [Favorites](#favorites)) |
| c | change its category (n: a new one) |
| 1-9 / 0 | show one lane / all |
| W M O D I | show one column alone: Working, Needs me (me), Waiting on others, Done, Idle; the same again shows all |
| / | search as you type: names, what sessions do, wait for, said or ask, lanes (Enter keeps it, Esc takes it off) |
| o | open the web board |
| q, Esc, the board key again | back to where you were (with a column alone or a search on, Esc ends those first) |
| Ctrl+C | close the board |

The same keys work on a Russian keyboard layout.

**The Terminal style.** With `"look": "terminal"` in config.json (see [Settings](#settings)) the
terminal board draws each card as a rounded box (its name, age and profile; what it does, waits for
or asks; what it is at), the column heads over a heavy rule in their colors, and lanes as
`▾ name count` over a thin rule in cyan and magenta in turn; a session asleep in Idle stays one
line. It draws in the terminal's own sixteen colors, so a terminal theme (Omarchy's included) is
the board's too. The keys stay the same.

The web board takes these keys too in its Terminal style (Settings → Style → Terminal): h j k l and
the arrows move between cards, g / G go to the first / the last, Enter opens the session, m writes
to it, w sets what it waits for, x clears its card, z puts it to sleep, f makes it a favorite or not,
c picks its lane, r refreshes, q closes the panel, 1-9 / 0 show one lane / all, W M O D I one
column alone (Esc shows them all again), and / searches, as always. The board's own keys (n, Shift+N,
F2, digits answering a question) come first. In the Classic style the page's keys are as they were.

## Agents

```
board cat <id>            lane of this session
board cat <id> "<Title>"  a new client: adds the category to the config too
board doing "<text>"      what it works on now
board wait "<text>"       what it waits for outside the chat (card goes to "Waiting on others")
board ask "<question>"    needs your answer: "Needs me" until you reply
board done ["<text>"]     finished: clears doing, wait and ask
board favorite [off]      keep this session in sight: first in its column, whole, left out of
                          "Archive the sleeping ones" (off: back among the others)
board list                every session, one line each
board cats                known categories
board remind <when> "<text>"   at that time, "[board reminder] <text>" goes into the session
board every "<cron>" "<text>"  the same on a cron schedule
  --idle                  (remind, every) wait until the session is free, not on time
board restart ["<note>"]  once this turn is over: Claude exits and resumes in its pane (MCP
                          servers, settings, hooks, skills load anew), then gets
                          "[board reminder; restarted as you asked] <note>"; see Restart
board schedule [--all]    this session's entries (every session's)
board unschedule <id|all> remove an entry (all: every entry of this session)
board call-report --session <id> --file <report.md>
                          a MokuPilot call's results for the session (MokuPilot runs it):
                          typed in once the session is free, for its information
board archive --session <id|name|pane>
                          another session off the board, its pane closed (a one-off one you
                          started, or one the user asked you to); the user brings it back from
                          the board's archive; see Archive
board sleep <id|name|pane>... [--when-free] [--self]
                          several sessions to sleep at once, a line for each: asleep, or kept
                          up and why; --when-free: the busy ones once they are free; --self:
                          this session too, once its turn is over; see Several to sleep at once.
                          pi sessions too, with the board's own wake; `board sleep <pane>
                          --pi-session <file>` takes a pane where pi was stopped by hand as that
                          session asleep (see Sleep and wake)
board fork [--name "<Name>"] ["<note>"]
                          a fork of this session in a new tab, with a copy of its conversation
                          (the web board starts it; the note is its first message); see Fork
--session <id|name|pane>  for another session's card
board presence [here|away]
                          whether the user is at the computer or away (where news goes: also
                          Telegram while away); here|away sets it; see Presence
board away [on|off]       the same switch: away (on), back at the computer (off)
board todo add [--mine] "<text>" | done <id> | list
                          tasks (with "todos": true): what you hand the user to do, or (--mine) a
                          promise of yours you defer; done closes your own; see Tasks
board doctor              what is set up on this computer, and what is missing
board resume <session id> [--profile <id>]
                          resumes that session here, in its own Claude profile (what herdr types
                          into a restored pane); see Claude profiles
board resume --pi <pi session id>
                          resumes a pi session wake put to sleep here, with the command line and
                          the account it had (what wake types into its pane); see Sleep and wake
spawn-agent --name <Name> --cwd <folder> [--brief-file <file>]   a new session in a herdr tab
```

Agents in herdr also get a skill, [`herdr-agents`](skills/herdr-agents/SKILL.md), which the
install puts into `~/.claude/skills` (with more than one profile, into the `skills` folder of
each one the board shows). Claude Code keeps only its one-line description in a session's
context and reads the rest when it is needed: how to start another session, message or wake one,
put the sessions it coordinates to sleep in one call, itself too once its run is over (`board sleep`), do something later (`board remind` rather than CronCreate, which dies when the session sleeps),
restart itself when an MCP server dropped or its settings, hooks or skills changed
(`board restart`), and run a server or an interactive login in a pane of its own. herdr puts the
pane's ids into its environment (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`,
`HERDR_WORKSPACE_ID`); when they are there, the board's brief
([`src/core/brief.ts`](src/core/brief.ts)) tells the session its pane and points it to the skill,
and outside herdr it says nothing of it. For herdr's own command reference, `herdr --skill`. A
skill of that name that is not the board's is left alone, and `board doctor` says so (per
profile, with more than one).

### Retry-safe call exports (opt-in)

A caller that can retain a stable export/revision ID can opt into a receipt:

```sh
board call-report --session <uuid> --report-id meeting-42:revision-1 --file report.md
board call-report --session <uuid> --report-id meeting-42:revision-1 --status
```

The response is JSON with `reportId`, canonical lower-case `session`, `entryId`, `state`, and
`reused`. Repeating the same session, report ID, and normalized full content returns the original
receipt without creating another queue entry. A changed report under that ID is a conflict;
use a new revision ID deliberately. Different IDs may carry identical content. IDs are case-sensitive,
1–128 ASCII letters/digits/dots/colons/underscores/hyphens, starting with a letter or digit.
Inputs are capped at 1 MiB before any queue write; the existing 16,000-character prompt limit remains.
BOM, line endings and outer whitespace are normalized before hashing, including the untruncated text.

States:
- `queued`: accepted locally; waits for the original session to be free. Unlike legacy reminders,
  receipt-backed exports do not follow a replacement session after `/clear`.
- `dispatching`: the transport attempt was recorded before sending. Exit code 2 means do not replay.
- `sent`: Herdr's prompt command returned success. This does **not** prove the agent read, understood,
  or executed anything. The report remains informational, with the existing no-auto-work instruction.
- `delivery-unknown`: a crash, ambiguous failure, or inconsistent queue left delivery uncertain.
  Exit code 2; automatic retry never creates another attempt. Inspect the conversation before deciding
  whether to submit a deliberately new revision. Known busy/draft/dialog guards keep the entry queued.
- `cancelled` / `missed`: terminal receipts; repeating the ID does not revive them.

Receipt metadata lives in `call-receipts.json` beside the schedule folder. It stores hashes and
identifiers, not report text. On POSIX, the journal and receipt-backed queue files are created with
mode 0600, including scheduler rewrites. The journal is bounded to 1,000 IDs across sessions; new
IDs are rejected at capacity, while existing retries remain available. No automatic TTL or eviction
is used: forgetting an ID would make old retries unsafe. Keep receipts for as long as clients can
retry. Archiving/removing them requires explicit operational reconciliation; do not blindly clear
this file to fix a failure. Windows ACL policy is inherited from the user's profile.

Queue creation and receipt creation are serialized under one receipt lock. A surviving orphan queue
entry is treated as unknown rather than replayed. A dispatch marker surviving a process restart also
becomes unknown without another send; locating an interrupted attempt may still wake its original
session. Terminal receipt cleanup never wakes a session. Corrupt journals fail closed. Receipt locks are never stolen
based on age: after an interrupted writer, stop the board and export producers, inspect/reconcile
pending reports, and only then remove the abandoned `call-receipts.json.lock` directory. A lock timeout
is an error, never permission to submit with a new ID automatically.

These guarantees cover cooperating processes and ordinary process restarts, not power loss (there
is no fsync transaction), hostile local file modification, or atomic delivery into Herdr's terminal.
Herdr's identity check and prompt write are separate calls. This is bounded retry suppression, not
exactly-once agent consumption. Existing callers without `--report-id` keep their current output,
queue behavior, and legacy at-least-once delivery. MokuPilot must retain and supply stable IDs before
it benefits; this board change alone does not alter MokuPilot.

With more than one Claude profile there is still one journal: a receipt is keyed by the session's
UUID, whichever profile the session runs in, and waking it for a report goes through the same
profile guard as any other wake. The code: [`src/adapters/call-receipts.ts`](src/adapters/call-receipts.ts).

## Settings

`%APPDATA%\herdr\plugins\config\agent-board\config.json`: `language` (`auto`, `en`, `ru`),
categories (id, title, color, folders that guess the category, the usual Claude profile),
`profiles` (the Claude profiles: id, title, folder, color, hidden, args; see
[Claude profiles](#claude-profiles)), `placement` (`workspace`
default: the board lives in a workspace of its own and stays open; `tab`; `overlay`),
`look` (`terminal`: the terminal board in its Terminal style, and the web board in it in a browser
that has not picked a style in Settings; Classic otherwise, and without it),
`refreshSec`, `wake` (sleep and wake: `false` turns it off; its section is under
[The `wake` section](#the-wake-section), and Settings → "Sleep and wake…" sets it), `wakeUrl` (the
separate herdr-wake plugin's router, used only while wake is off or held by that plugin),
`scheduleWaitMin` (how long a due entry waits for a
busy session, 240), `port` (web board, 12422), `web` (false turns the
web board off), `terminal` (false turns the web board's [terminal](#terminal) off), `browser`
(path for the app window), `foldWaiting` (how the web board folds a session asleep in
"Waiting" down to its name, what it waits for and its time: `push`, the default, unfolds it on
hover moving the cards below apart; `over` unfolds it over them; `off` keeps it whole; the gear's
Settings set it too), `terminalTitle` (window title pattern to
raise, default `<COMPUTERNAME>:*`), `raiseTerminal`, `launch` (how new sessions start: `claude`,
`command`, `agent`, `args`, `timeoutSec`, see [New sessions](#new-sessions)), `mokupilot` (calls
with a fork of a session: `false` turns them off; `{ "dir": "<MokuPilot checkout>" }` runs its
`.venv` Python with `run.py` on Windows, its `meet` elsewhere; `{ "command": [...] }` a program
and its first arguments, one per element, no shell, the board adding `call --claude-session <id>
--cwd <folder>`, or the whole line when it has `{session}` or `{cwd}` in it; `"mode"`:
`"auto"`, `"local"` or `"link"`, where a call starts, set by Settings → MokuPilot…, the older
`"link": true` read as `"link"`).

`tunnel` (the board [through your own domain](#another-computer-or-a-tablet-through-your-own-domain);
Settings → Remote access… and `board tunnel on|off` set it): `on` (false), `host` (the server),
`sshPort` (22), `user` (the tunnel's user on the server), `key` (the private key's path; empty:
the one Generate key made, `tunnel/id_ed25519` in the state folder), `socket` (the Unix socket on
the server, `/var/lib/boardtunnel/board.sock`), `domain` (a bare host name such as
`board.example.com`), `publicPort` (the port the server serves the domain on; empty: 443. Another
one makes the board's address `https://<domain>:<publicPort>`: the Host and Origin it takes, the
passkeys' origin and the probe follow it; the passkeys and logins stay; case 4 of the web
server's setup sets it to 8443 and its Undo back), `port` (the tunnel listener's on 127.0.0.1;
empty: the web board's port plus two), `admin` (`{ "user", "key" }`: who the board connects as to
set up the server, [On the server](#on-the-server); `key` empty: the ssh agent and the usual
`~/.ssh` keys), `setup` (`{ "case", "address", "at" }`: what Apply set up, a summary of the
server's own record, filled in from it when missing; Undo removes it). None of it is secret: no
password is ever in it. The board checks every field before it uses it, and runs nothing
while one does not check out.

Cards: `%LOCALAPPDATA%\herdr\plugins\agent-board\cards\<session id>.json`. Sessions in the archive:
`archive\<session id>.json` beside them (see [Archive](#archive)).

**Sharing cards with an isolated preview (#71).** `HERDR_BOARD_CARDS_DIR` selects an absolute
cards directory for this process. Unset or empty, the layout above is unchanged. Set the preview
to the authoritative cards folder already used by its `board` CLI and Claude hooks, or explicitly
set the same folder for every writer. Paths with spaces, other alphabets and `%` are literal
paths; relative paths and `~` are refused, because processes can have different working folders.
This does not change config, schedules, archives, uploads or the rest of runtime state.

For example, on macOS/Linux, a preview with its own `APPDATA` and `LOCALAPPDATA` can use:

```sh
export HERDR_BOARD_CARDS_DIR="$HOME/.local/state/herdr/plugins/agent-board/cards"
```

Choose the authoritative folder before starting it. There is no copying, merging, migration or
clearing of old asks. Do not share the whole `LOCALAPPDATA` between running previews: separate
schedulers must keep separate schedules. `board doctor` and Setup show this process's effective
cards folder, its source, and its schedule folder. A Unix preview with a custom `LOCALAPPDATA`
and no explicit cards folder warns that outside writers may use another store. These diagnostics
cannot infer another process's environment; compare its own `board doctor` output. Installing a
hook from a different checkout alone does not choose its store or propagate this variable.

Writes to the same card use a per-card directory lock (`<session id>.json.lock`) around the
read/merge/rename. Contention waits at most two seconds, then reports an error without replacing
the card. Locks are released on ordinary errors. A writer killed mid-write leaves its lock
behind; a write holds it for milliseconds, so one older than 30 seconds is taken over by the
next writer. A card write the board itself fails at is retried on its next refresh.

## Development

[Bun](https://bun.com/docs/installation) 1.4.3 or newer and git on PATH, in a clone with the
repository's full history:

```sh
bun install     # react, react-dom and the viewers' libraries, and the dev tools: TypeScript, Biome, the types
bun test        # the whole suite (a couple of minutes); two symlink tests skip without symlink rights
bun run check   # type check (tsc) and lint (Biome)
```

The parity tests compare the board with the old page and with upstream's code as git has them
(`git show <commit>:<file>`; the commits are named in `test/web/support/old-app.ts` and the
tests): a shallow clone (`--depth`), a tarball or a fork without that history fails them with
"git show … failed". Biome wants LF line endings: on Windows, clone with
`git clone -c core.autocrlf=input …` (or turn `core.autocrlf` off) so `bun run check` passes.

The code is in layers: `src/core` (pure rules, no I/O), `src/adapters` and `src/integrations`
(files, processes, herdr, Claude's files, wake's API and herdr-wake's), `src/services` (what the
board does with them), `src/server`, `src/tui` and `src/entrypoints` (the web server, the terminal
board, the commands), `web/src` (the React page). Tests mirror them under `test/`.

Sleep and wake has its rules in `src/core/wake`, its engine, supervisor, start, Telegram router
and takeover in `src/services/wake`, and five entrypoints: `wake-start.ts` (herdr's startup entry,
and the board's Start), `wake-run.ts` (the wake pane: the supervisor), `wake.ts` (the wake process
and its API; `--reap-dry`, `--deliver`), `wake-hook.ts` (the ListAgents and SendMessage hooks) and
`wake-action.ts` (herdr's `agent-board.sleep` and `agent-board.wake`). `bun test` covers it on
fakes and sandboxes only: a compiled fake herdr or an in-memory one, temp folders, ports of the
test's own. No test asks this computer's herdr, its Claude folders, or `127.0.0.1:12421` (wake's
port) or `12422` (the web board's): every test that starts a wake gives it a port of its own, and
the board's tests run with `"wake": false` unless they turn it on so. The tests that compare
wake's API and hooks with herdr-wake's run that plugin's code with Node.js, and skip without it.

The board through your own domain: `src/core/tunnel.ts` (the `tunnel` settings and their checks,
the ssh line, what ssh says, the doctor's checks), `src/core/tunnel-snippets.ts` (the server's
snippets, which the panel shows and this README has word for word: a test keeps them the same),
`src/core/totp.ts`, `src/core/access.ts` (the login's rules: cookie, lockout, rate limits, device
labels), `src/core/webauthn.ts` (passkeys, without a library), `src/core/own-files.ts` and
`src/adapters/own-files.ts` (the board's own files), `src/adapters/ssh.ts` (ssh and ssh-keygen,
the key's rights, the pinned server key, the pid record), `src/adapters/access-store.ts` (the
login's files), `src/adapters/probe.ts`, `src/services/access.ts` (the login),
`src/services/tunnel.ts` (ssh kept up, the probe, Test connection), `src/services/remote-access.ts`
and `src/server/routes/access.ts` (the panel's view and changes), `src/services/tunnel-facts.ts`
(`board tunnel`, `board doctor`), `src/server/tunnel.ts` (the tunnel listener),
`src/server/tunnel-probe.ts`, `src/server/streams.ts` (what the remote listeners share),
`web/src/components/access/` (the panel), `web/src/components/remote/LoginScreen.tsx`. Tests never
run the real ssh: `BOARD_SSH_BIN_PATH` and `BOARD_SSH_KEYGEN_BIN_PATH` name other binaries (a fake
in `test/support`), and `BOARD_TUNNEL_PROBE_ORIGIN` another origin than `https://<domain>` for the
probe.

Setting up the web server on the server: `src/core/server-look.ts` (Look's two scripts and their
parsers, into `src/core/server-facts.ts`'s types), `src/core/server-plan.ts` (the case, the plan per
case, the record and whose it is, Undo, the facts "Do it myself" fills with placeholders),
`src/core/server-texts.ts` (what the board puts on the server: its Caddyfile, the site, the line,
the marked block, nginx's file, its containers' argv, Docker's install, the pinned images),
`src/core/server-script.ts` (the run, its launch and follower, the progress, "Do it myself"'s
blocks), `src/core/server-shell.ts` (shell words), `src/core/server-admin.ts` (the admin's ssh line,
sudo's probe, the remote command, the hints), `src/core/server-view.ts`,
`src/services/server-setup.ts` (Look, Apply, Undo over the admin connection),
`web/src/components/access/ServerSetup.tsx` and `DoItMyself.tsx`, `web/src/models/server-setup.ts`.
`BOARD_SETUP_ACME_CA` (a directory URL) and `BOARD_SETUP_ACME_CA_ROOT` (a PEM's path on the
server), both set, give the board's own Caddy a test CA (tests only; without them its Caddyfile
names no CA).

The integration tests run on Docker Desktop, never on a server of yours, and only when asked:
`BOARD_SERVER_IT=1 bun test test/integration/server-setup.test.ts --timeout 3600000` builds the
test servers of `test/integration/server/` (systemd, sshd, sudo, Docker inside) and runs every
scenario on Debian 13 and Ubuntu 26.04 side by side, and three on Ubuntu 24.04 (with
`BOARD_SERVER_IT_ALL=1` also on Debian 12 and Ubuntu 22.04): a sandboxed board with Windows' own
ssh, Pebble as the CA, a stand-in board at the tunnel's end, about an hour.
`BOARD_DOCKER_IT=1 bun test test/integration/two-proxies.test.ts` proves that their proxy and the
board's serve side by side, with the board's own images, flags and texts (a few minutes).
`BOARD_IT_KEEP=1` keeps the built images and the Docker Hub mirror for the next run. Without these
variables `bun test` skips them and starts no container.

`herdr-wake/` is the separate plugin, deprecated (the board does this now) and kept one release
for those who still run it, on Node.js rather than Bun: `bun test`, `bun run check` and tsc leave
it out (their roots are `test`, `src`, `web/src`), and its tests run with
`node --test herdr-wake/test/*.test.mjs` (Node.js 20 or newer).
