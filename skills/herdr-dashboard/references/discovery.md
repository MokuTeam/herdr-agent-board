# Discover the instance and verify changes

## Reuse the existing authorities

- `herdr --help`, then the relevant group or explicit `--help`: the installed Herdr CLI.
  `herdr --skill`: agent/pane/workspace semantics and caller-context requirements. Do not run
  bare `herdr` for discovery; it launches or attaches the TUI. Do not fabricate `HERDR_ENV`.
- `herdr-agents`: the plugin's installed instructions for Claude sessions already in Herdr.
- The repository [README](https://github.com/MokuTeam/herdr-agent-board/blob/feature/ts-rework/README.md):
  full product behavior, installation, launchers, questions, terminals, archive and settings.
- The source in the checkout that actually runs: `src/entrypoints/cli.ts`,
  `src/server/routes/`, `src/adapters/paths.ts`. These references describe the TypeScript
  branch; the older Node installation uses different entrypoints. There is no separate
  dashboard MCP server declared here. Optional integrations can supply their own tools.

## Resolve code, state and target separately

1. Establish the host and dashboard origin from the user's context or running installation.
   The default web port is 12422, not a promise about this instance. Localhost on a phone or
   another machine is not the dashboard host. Reuse only an already authorized remote route.
2. Inspect plugin registration (`herdr plugin list --plugin agent-board --json`, where the
   installed CLI supports it), the listener/process cwd and the command shim. Check Git remote,
   SHA and dirty state in that checkout. Package version and browser bundle hash are useful
   evidence but do not identify a Git branch or installer by themselves.
3. Resolve the process's effective config/state roots:

   | Data | Resolution in `src/adapters/paths.ts` |
   | --- | --- |
   | Config | Under `APPDATA` (fallback `<home>/.config`): `herdr/plugins/config/agent-board/config.json` |
   | State | Under `LOCALAPPDATA` (fallback `<home>/.local/state`): `herdr/plugins/agent-board/` |
   | Profile | `CLAUDE_CONFIG_DIR`, otherwise `<home>/.claude` |

   Hooks and CLI run outside plugin context and use these same environment-derived roots.
   A separate preview can serve copied cards while installed hooks update the normal state.
   Compare the relevant launcher and paths; do not dump its entire environment.
4. Read `GET /api/board` and `GET /api/setup` from the verified origin. Inspect only the fields
   needed. Omit `fsToken` and unrelated conversation content from reports. Check `stale` and
   `lastSuccessfulRefreshAt` as well as transport connectivity: a connected stream can carry
   stale Herdr data, and copied card metadata can be old even with fresh Herdr data.
5. Resolve the target from the returned `items`: key, session, name, pane, cwd and profile.
   A card key is not always a Claude session UUID; non-Claude cards can be pane-based. Preserve
   exact returned identifiers. A human-readable name may be ambiguous or change.

If the existing config is present and the CLI points to this instance, these inspect it:

```sh
board list
board cats
board doctor
board schedule --all
```

`board` with no arguments reads the caller's card. `--session <UUID|name|pane>` targets another
card. The CLI loads config on entry and can create defaults if the config file is missing;
for a strictly read-only audit of a running server, prefer the two GET endpoints above.
Use `board --help` (also `board help` or `board -h`) for command usage. There is no
`board --json` interface; inspect `cli.ts` when a command's behavior needs clarification.

For a known preview, an explicit invocation can avoid the normal command shim. POSIX shell
syntax below is a template; set all four paths to values you have verified first:

```sh
APPDATA="$CONFIG_ROOT" LOCALAPPDATA="$STATE_ROOT" \
  "$BUN" "$BOARD_ROOT/src/entrypoints/cli.ts" schedule --all
```

Keep the intended profile's environment. Do not set a different `CLAUDE_CONFIG_DIR` just to
make an error disappear. Never start the real server against a state directory merely to
inspect it: server/TUI startup can discover profiles, write runtime files and run due jobs.

## Verify and undo within scope

- Before an edit, capture the affected fields/files and their current versions or hashes.
  Preserve unknown config fields and concurrent edits. For installation, include command
  shims, selected profiles' settings and owned skills, plugin registration and launcher.
- After a UI/config edit, re-read its fields and refresh the view. Theme and panel placement
  are browser-local; language/categories/profiles belong to the dashboard config.
- For schedules, record returned ID, target, text, mode and next UTC/local time. Inspect
  both delivery log and destination result. See [Schedule](schedule.md) for retry limits.
- Inspect structured errors and per-item results, not just HTTP status. In particular, the
  archive batch endpoint can return HTTP 200 with both `done` and `failed` entries.
- Undo a config edit by restoring its old fields, preserving unrelated newer changes. A
  deleted category also clears assignments on cards: retain those assignments before deletion.
- Cancel an unwanted new schedule by its recorded ID; cancellation cannot retract an already
  delivered prompt. Do not restore an old schedule directory over a running scheduler.
- A requested code/config migration needs a concrete source/target/backup/rollback plan. Prefer
  keeping the authoritative live state in place over replacing it with a preview's copy. Do
  not merge stale ask/wait fields into current cards or rewrite Claude transcript history.
- Reverting TS to Node needs special care: the Node installer does not recognize TS hooks.
  Restore/remove only owned TS entries before reinstalling Node, preserving other hooks and
  custom status lines. See README “Setup”; do not treat install as an inspection command.

Keep commit author, checkout/fetch time, file mtime, process start and installation actor as
separate evidence. Claim who installed it only from an installation receipt/log or equivalent
actor evidence, not from commit authorship.
