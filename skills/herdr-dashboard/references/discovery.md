# Identify the instance and verify an operation

Use the README in the running checkout as the feature reference. The online
[README](https://github.com/MokuTeam/herdr-agent-board/blob/main/README.md) follows `main`;
a copied skill or another checkout can describe a different version.

1. Establish the host and dashboard origin from the user's context or running installation.
   A preview, registered plugin, `board` on PATH and session hooks can point to different code
   or state. Localhost on another device is not the dashboard host; reuse only an authorized
   remote route.
2. Inspect the listener/process cwd, launcher and command shim. Check the checkout's remote,
   SHA and dirty state. Inspect registration through the installed Herdr CLI only when its
   `herdr --skill` caller-context rules permit it; do not fabricate `HERDR_ENV` or control a
   focused session from outside Herdr. Package version and bundle hash alone do not identify
   a branch or installer.
3. Resolve effective roots from `src/adapters/paths.ts`, not a remembered machine layout:

   | Data | Resolution |
   | --- | --- |
   | Config | Under `APPDATA` (fallback `<home>/.config`): `herdr/plugins/config/agent-board/config.json` |
   | State | Under `LOCALAPPDATA` (fallback `<home>/.local/state`): `herdr/plugins/agent-board/` |
   | Claude profile | `CLAUDE_CONFIG_DIR`, otherwise `<home>/.claude` |

   Compare relevant launcher values without dumping the environment. Copied card files can
   stay old while installed hooks write to another root.
4. Read `GET /api/board` and `GET /api/setup` on the verified origin. Check `stale` and
   `lastSuccessfulRefreshAt`; transport connectivity alone does not prove current data. Omit
   `fsToken`, credentials and unrelated conversations from reports.
5. Resolve the returned item key, session, pane, cwd and profile. Keys need not be Claude UUIDs;
   names can be ambiguous. Preserve returned identifiers and the intended profile context.

For this instance's syntax use `board --help` (also `help` / `-h`); README **Agents** lists the
commands. The CLI loads config on entry and can create defaults when it is missing. Prefer
the two GET endpoints for a strictly read-only audit of an already-running server. Do not
start a server to inspect state: startup can write runtime files and deliver due jobs.

For an existing preview whose four paths you have verified, this POSIX template bypasses the
normal shim without starting another scheduler:

```sh
APPDATA="$CONFIG_ROOT" LOCALAPPDATA="$STATE_ROOT"   "$BUN" "$BOARD_ROOT/src/entrypoints/cli.ts" schedule --all
```

Before a change, retain the affected fields or files and their versions. Afterwards, re-read
persisted state and inspect the actual outcome; follow the [schedule checklist](schedule.md)
for deliveries and the [HTTP index](http-api.md) for per-item response handling. Undo only the
changed fields while preserving concurrent edits. Category deletion clears card assignments,
so retain those too. Do not restore stale cards or schedule directories over live state.

Installation or migration needs an explicit source, destination and rollback plan, including
owned hooks, shims, skills and launcher. Follow README **Setup**; install is not a diagnostic
probe. Never overwrite Claude transcript history or silently substitute another account/host
when the intended target refuses an operation.

Keep commit author, checkout/fetch time, file mtime, process start and installation actor as
separate evidence. Attribute installation only to a receipt/log or equivalent actor evidence.
A manually copied skill does not update when Git changes: retain its source SHA in the
installation receipt and refresh its whole folder only as part of an authorized update.
