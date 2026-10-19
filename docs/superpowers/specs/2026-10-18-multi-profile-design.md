# agent-board: Claude multi-profile — design (phase 2 of 5)

Date: 2026-10-18 · Branch: `feature/multi-profile`, on top of `feature/ts-rework` @ `cac785c`
(phase 1, see `2026-10-16-ts-bun-react-rework-design.md`). Local commits only, never pushed.

## Intent

The owner runs Claude Code in more than one account ("profile"), each a config folder picked with
`CLAUDE_CONFIG_DIR`. Today they start sessions from Git Bash aliases (`~/.bashrc`):

```
cld          CLAUDE_CONFIG_DIR=$HOME/.claude          claude --allow-dangerously-skip-permissions
cld-work     CLAUDE_CONFIG_DIR=$HOME/.claude-work     claude --allow-dangerously-skip-permissions
cld-gamedev  CLAUDE_CONFIG_DIR=$HOME/.claude-gamedev  claude --allow-dangerously-skip-permissions
```

`cld-work` is for their work for BluBanyan, started in a project folder under
`c:/migo/development/bb/<project>` (SunPower and the other folders there are BluBanyan's clients
and products). `cld` is private. `~/.claude-gamedev` is used little; `~/.claude-general` is not used.

The board (upstream and phase 1) knows only `~/.claude`. It installs its hooks and status line
there and reads session names, titles, conversations and usage from there. It also ignores
`CLAUDE_CONFIG_DIR`. A work session shows only as a bare herdr pane: no status from hooks, no
title, no conversation. Multi-profile support was the main reason for the phase 1 rework, which
put everything read from Claude behind one `ClaudeHome` built from a root folder
(`src/adapters/claude-home.ts`).

**Goal:** one board for every profile. Every session is shown with its profile, the board starts
a session in the profile the owner chooses, and the owner manages the profiles on the board.

## The worst outcome (anti-goal no. 1)

**A session running in the wrong account**, for example a work task started or resumed in the
private subscription, without the owner noticing. Every design choice below puts this first. If
the board can't be sure of the profile, it refuses or asks. It never falls back quietly.

## Decided with the owner

- **One board, many profiles**, not one board per profile.
- **The owner chooses the profile, never the folder.** Folder rules were rejected because the
  folder layout may change. Today the alias decides.
- **The board shows the profiles it found**, minus the ones the owner hides. The owner's wish:
  private and work shown; general hidden; gamedev "maybe not even shown".
- **Profiles are managed on the board:** rename and show/hide (the owner asked for this).
- **Lanes (categories) stay as they are**: one per client or project, each a section with its
  own columns. Profiles are a separate dimension: a lane can hold sessions of any profile.
- The owner approved the mockups of:
  - the board with a profile switch;
  - a profile tag on each card;
  - usage per profile;
  - the profile choice in the new-session window, preselected;
  - a lane's usual profile.

## What the owner sees

1. **Profile switch** in the toolbar, next to the lanes control: "All profiles", then each shown
   profile. It filters the cards, the same way the lanes control does. Remembered per browser, as
   the lane pick is.
2. **Profile tag** on each card: the profile's name in its color. It is left out when the switch
   shows only one profile.
3. **Usage per profile:** the usage pill shows the profiles with recent usage. Its popover lists
   every shown profile's windows (5 h, week), or "no session lately".
4. **New-session window:** a profile choice (one segment per shown profile).
   - **Preselection, first match wins:**
     1. started from a session: that session's profile, with no choice offered;
     2. the lane's usual profile (see 6);
     3. the profile last used for a launch in that folder (remembered, not a rule);
     4. nothing.
   - **Start stays disabled until a profile is chosen.** The chosen profile is shown in its color
     right next to Start.
5. **Profiles panel**, opened from "Profiles…" in the Settings (gear) menu and built like the
   Categories panel. The menu item appears only when more than one profile folder is found. One
   row per profile:
   - color;
   - name (editable);
   - folder (read-only);
   - sessions now;
   - a Shown/Hidden toggle.

   Below the rows:
   - "Add a folder somewhere else";
   - per shown profile, a note when the board's hooks are missing there, with an Install button.
6. **A lane's usual profile:** an optional field per category, set in the Categories panel. A
   lane's **+** preselects it.
7. **One profile shown** (every teammate today, and the owner until they show Work): no switch,
   no tags, no profile choice in the new-session window, no `--env` on launches. The board looks
   and acts exactly as in phase 1. The only possible difference is the "Profiles…" item in the
   Settings menu, and only on a machine with more than one profile folder.

The terminal board (`src/tui`) shows the profile tag. A profile filter there is the builder's call.

## Behaviour

### Profiles

- **Found automatically:** `~/.claude` and every `~/.claude-*` folder that holds `settings.json`
  or `projects/`.
- **Stored in the board's `config.json` as `profiles`:** a list of objects. Each object has:
  - `id`: stable; derived from the folder (`.claude` → `default`, `.claude-work` → `work`);
  - `title`;
  - `dir`;
  - `color`: from the categories' palette;
  - `hidden`;
  - `args` (optional): extra Claude arguments for this profile's launches.
- **A found folder that is not listed yet** is added with a title from its name ("Default",
  "Work", "Gamedev"). `default` is added shown, every other found folder hidden, so a stray
  backup or test folder never changes a teammate's board. The owner shows Work once in the
  Profiles panel and renames `default` to "Private".
- **Rules:**
  - A profile is known by its folder. Renaming or recoloring it never changes `id` or `dir`.
  - Unknown fields are kept on write, as for all board files.

### Which profile a session is in

- **The hooks and the status line report it.** They run in the session's own environment, so
  they read `CLAUDE_CONFIG_DIR`. If it is unset, the profile is `~/.claude`. The folder is mapped
  to a profile id (same-folder rules as `sameDir`) and written to the card as `profile`.
- **Reading a session's records:** the board reads a session's names, title, conversation,
  helpers and context from that profile's `ClaudeHome`. It looks through the `sessions/` registry
  of every shown profile.
- **A session whose folder is not a known profile:** it shows with an "unknown profile" tag that
  names the folder, and the Profiles panel offers to add it. It is never folded into another
  profile.
- **A session with no card yet** (no hook has run): it shows like a herdr pane does today, with
  no tag.
- **A running session in a hidden profile** (its hooks were installed before it was hidden) still
  shows, with its tag, under "All profiles". Hiding only takes a profile out of the switch, out
  of the board's launch choices and out of Install. The board also reads the registries of
  hidden profiles, so these cards keep their titles.

### Starting a session in a profile

- **The inherited environment is checked, never assumed.** The board's own process inherits
  `CLAUDE_CONFIG_DIR`: unset on a teammate's machine, `C:/Users/migo/.claude` (user-level) on the
  owner's. "Unset" and "set to `~/.claude`" are the same profile (`default`, same credentials) but
  not the same state. Claude keeps `.claude.json` (folder trust, user MCP servers, account info)
  in `~/.claude.json` when the variable is unset, and in `<dir>/.claude.json` when it is set. Both
  files exist on the owner's machine. So:
  - **The chosen profile is the one the inherited env points to** (unset counts as `~/.claude`;
    same-folder rules): the launch leaves the env exactly as inherited, with no `--env`.
    Teammates see no change, and the owner's private launches use the same state as `cld`.
  - **Any other profile:** the start sets `CLAUDE_CONFIG_DIR=<dir>` explicitly.
    - **spawn-agent (default launcher) and `launch.agent`:** `herdr tab create --env
      CLAUDE_CONFIG_DIR=<dir>`. The flag exists in herdr 0.9.5. If the running herdr rejects
      `--env`, the launch refuses with a message. `min_herdr_version` stays 0.9.2. The env holds
      for anything later started in that tab.
    - **`launch.command`:** the env of the process, plus new placeholders `{profile}` and
      `{profileDir}`.
  - **The profile's `args`:** added to the Claude arguments.
- **Inherited starts keep the parent's profile.** These are helpers, forks, "New here" from a
  session, and agents that run `spawn-agent` themselves (from their own env). This holds even
  when the parent's profile is hidden. If the parent's profile is unknown, the board asks; it does
  not default.
- **`spawn-agent --profile <id>`** overrides the parent's profile.
- **There are no scheduled launches.** The scheduler only types reminders into sessions that
  already exist. A reminder that has to wake a sleeping session follows the wake rule below.
- **After a start, the board checks the result.** The new session's hook must report the chosen
  profile. If it reports another one, the card shows a red "wrong profile" warning and a
  notification says so. The session is not stopped automatically.
- **No silent fallback:** a launch refuses with a message if:
  - the profile chosen in the board, or passed with `--profile`, is hidden or missing;
  - its folder does not exist;
  - herdr cannot set the env.

### Waking a sleeping session (herdr-wake)

herdr-wake is a separate, third-party program (Eithery-rc/tg-mcp). The board only POSTs
`{target: pane}` to it (`src/integrations/herdr-wake.ts`), and herdr-wake restarts Claude with
`--resume` in the pane. It also sleeps and wakes sessions on its own: after an idle hour, and on
Telegram messages. This phase does not change herdr-wake.

- **Which wakes the board allows (button, menu, and reminders that wake):** a session whose
  profile is the board's inherited one, or a session whose pane the board itself opened with
  that profile's `--env` (the launch records it). For any other session the board refuses the
  wake and explains why: "started outside the board in profile X, so waking could resume it in
  the wrong account; wake it in herdr where you started it". A reminder that would need such a
  wake is held, with that reason.
- **herdr-wake acting on its own** is outside the board's control. Resuming a session id in the
  wrong profile is expected to fail, because Claude can't find that session's transcript in the
  other folder; it should not quietly run in the wrong account. The manual run checks this. The
  usage guide tells the owner how to start work sessions so that waking stays safe: from the
  board, or in a pane whose shell has the variable exported.

### MokuPilot calls

MokuPilot runs as a single instance and takes its profile from its own environment. A call from
the board goes to the instance that is already running, so the env the board sets is ignored.
The board allows a MokuPilot call only from a session in the board's inherited profile. From any
other profile it refuses the call and says why. Making MokuPilot take a profile per call is out of
scope for this phase.

### Install and setup check

- **Install** writes the board's hooks and status line into the `settings.json` of every shown
  profile, each with its own `settings.json.bak-agent-board`. The rules are the same as today's
  for `~/.claude`: replace the board's own entries in place, and touch nothing else.
  - Hidden profiles are not touched.
  - Showing a profile later offers Install for it (panel note, setup check).
- **The setup check** reports per profile.
- **Never touched:** credentials, `.claude.json` or anything else in a profile folder beyond
  `settings.json`, its backup and `skills/herdr-agents`.

### Usage

- **Per profile.** Today the status line writes the board's limits file once
  (`claude-limits-latest.json` in the board's state folder). It becomes per profile, keyed by
  profile id. An existing file is read as the `default` profile's.
- **The usagebar fallback** reads each profile's own `<dir>/herdr-usagebar/`.

### The `board` command and the API

- **`board` commands an agent runs** act within its own profile wherever that matters.
- **Payloads:** new fields only (`profile` on items; `profiles` on the board payload). Nothing
  existing is renamed. `web/src/api/client.ts` validators accept the new fields, tested on real
  server output.
- **Scope of changes:** the hook output, the status line output and the `board` command's output
  for one profile do not change.

## Non-goals

- Running one board per profile.
- Choosing the profile by folder rules.
- Logging in, managing accounts, or reading credentials.
- Moving a running session to another profile.
- Syncing settings, skills or plugins between profiles.
- Upstreaming. The team decides later, as with phase 1.

## Anti-goals (failure even if it works)

- A session started, forked, reminded, woken or called (MokuPilot) in a profile other than the
  one intended (see above).
- Any change a single-profile teammate would notice.
- The board writing anything in a profile folder beyond its own hook and status line entries, or
  touching a hidden profile.
- Losing existing cards, categories or settings when upgrading from phase 1.

## Constraints

All phase 1 conventions hold:
- Bun, strict TS, React and react-dom only, Biome.
- Layers (core pure; adapters and integrations import only core; services orchestrate).
- English and Russian texts.
- Windows first-class; no shell when spawning.
- Unknown JSON fields kept; JSON from disk or network checked by narrowing functions.
- Port 12422, loopback, `X-Board`/`Origin` checks.
- Tests use temp folders and `test/support` fakes, never the owner's real `~/.claude*`, herdr
  config or port 12422.
- Later phases reuse this: the watcher agent (phase 5) picks a profile through the same launch
  request field.

## Testing

- **Unit:**
  - finding profiles;
  - folder → id;
  - config read and write (unknown fields, renames);
  - card `profile` from the hook env;
  - preselection order;
  - launch argv/env per launcher;
  - install into several fake homes;
  - limits per profile.
- **Web:** tag, switch and panel markup. With one profile the page markup is unchanged from
  phase 1 (snapshot against phase 1).
- **Manual run on the owner's machine:**
  - `cld` and `cld-work` sessions side by side;
  - starting from the board in each profile;
  - a fork and a helper;
  - a reminder into a work session;
  - waking a work session started from the board, and the board refusing to wake one started
    with `cld-work`;
  - a MokuPilot call refused from a work session;
  - usage per profile;
  - hide gamedev.

## Calls made after the builder check (the owner can overturn them)

1. **The inherited env is kept when it already points to the chosen profile.** Otherwise the
   board sets `CLAUDE_CONFIG_DIR`. Why: to keep `.claude.json` state and teammates unchanged.
2. **herdr-wake and MokuPilot are not changed.** The board refuses its own wakes and calls when
   it can't be sure of the profile.
3. **There are no scheduled launches.** Reminders follow the wake rule.
4. **"One profile" means one profile shown.** Found folders other than `default` start hidden.
   The Profiles panel lives in the Settings menu.
5. **Hidden profiles' running sessions stay visible, with their tag.** Agents inside a hidden
   profile can still run `spawn-agent`.

## Left to the builder

- Exact layout and styling of the switch, tag and panel (follow the lanes control and the
  Categories panel).
- File and module names.
- How the found profiles merge into the config on first read.
- The terminal board's profile filter.
- Profile colors, picked from the palette and distinct from the column colors.
