# agent-board: a start command per Claude profile — design

Date: 2026-10-19 · Branch: `feature/profile-command`, on top of `feature/ts-rework` @ `814351b`
(multi-profile, see `2026-10-18-multi-profile-design.md`). Approved by the owner in chat.

## Intent

The owner starts Claude through Git Bash aliases, one per profile:

- `cld` = `CLAUDE_CONFIG_DIR=$HOME/.claude command claude --allow-dangerously-skip-permissions`
- `cld-work` = the same with `$HOME/.claude-work`

Today the board types `launch.claude` (one command for every profile) into the new tab. The owner
wants each profile to say which command starts its sessions, so the aliases stay the one place
that defines a profile: a flag or a model added to `cld-work` later reaches the board's Work
sessions without touching the board. If a profile names no command, the board types `launch.claude`
as today.

## Behaviour

- **New profile field.** Each profile gets an optional `command`: what the board types at the new
  tab's shell prompt instead of `launch.claude` when it starts a session in that profile. It is a
  program, alias or function the tab's shell knows, optionally with arguments, for example
  `cld-work`. It is stored in config.json's `profiles` entry. A string is split on spaces, and a
  list is taken as it is. Both are checked with the same rules `launch.claude` has today: no
  leading dash on the program, no quotes or control characters, and the program is a single word.
  Unknown fields are kept, as for all board files.
- **What is typed.** `[...(profile.command ?? launch.claude), ...profile.args, '--session-id', <id>]`.
  That is today's line with the program replaced. The session-id rule (`choosesSession`) looks at
  the whole line.
- **Where it applies:**
  - every start that types a command into a tab: the board's default launcher (spawn-agent, for a
    board launch in any profile, the inherited one included);
  - "New here", forks, helpers and agents' own `spawn-agent` starts, whenever the profile of the
    start is known.

  It does not apply to `launch.agent` (herdr starts Claude itself) or to `launch.command` (that has
  `{profile}` and `{profileDir}`). The board's env rule is unchanged: `--env` is used for a
  non-inherited profile even when the profile has a command.
- **Safety.** An alias can name its own `CLAUDE_CONFIG_DIR`. If it names another profile's folder,
  the session runs there. The existing check catches this (the card's `profileWant` against the
  hooks' report): the red "Wrong profile" tag and a herdr notification. Nothing else is needed. A
  command that fails the check refuses the launch with a message, before anything starts, as a bad
  `launch.claude` does today.
- **Profiles panel.**
  - Each row gets a "Start command" text field, saved on Enter or blur and reset on Esc, like the
    name.
  - Its placeholder shows what is typed without it (the program of `launch.claude`, `claude` by
    default).
  - A one-line hint says: typed in the new tab instead of `claude`, an alias like `cld-work`
    works, and the board adds its own arguments.
  - It is sent as `{ op: 'update', id, command }`. `''` clears the field, and an invalid command
    is refused with the check's message, as a 409 toast.
  - English and Russian texts.
- **The payload** gains `command` on `BoardProfile` (string, `''` when none), so the panel can show
  it. `isBoardProfile` accepts it.
- **One profile shown, with no command set** (every teammate): byte-for-byte today's behaviour and
  page.
- **README "Claude profiles":** the start command, with the owner's example (`cld` / `cld-work`).

## Non-goals

- Running a command through `launch.agent` or `launch.command`.
- Checking what an alias does. The wrong-profile check is the guard.
- Changing the shell or the alias files.

## Constraints

All phase-1 and multi-profile conventions hold:
- strict TS, layers, Bun, React only, Biome;
- English and Russian;
- unknown fields kept;
- tests in sandboxes only, never the owner's real herdr, `~/.claude*`, `%APPDATA%\herdr` or port 12422;
- web code never imports `src/core/profiles.ts` (it uses `node:path`).
