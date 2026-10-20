# Dashboard operations

The [README](https://github.com/MokuTeam/herdr-agent-board/blob/feature/ts-rework/README.md)
is the full feature reference. This page selects the right surface and explains ambiguous
states; use [discovery](discovery.md) first if the instance is not established.

## Capability map

| Intent | Existing surface | Effect / verification |
| --- | --- | --- |
| Inspect sessions, questions, helpers, history or Git changes | Cards and session sheet; `board list`; read endpoints | Inspect the correct profile/session, not only a display name. |
| Keep an agent's card current | `board cat`, `doing`, `ask`, `wait`, `done`, `clear` | Writes card metadata; re-read that card. |
| Organize work/personal/project lanes | Categories editor or category API | Changes classification, not account access. |
| Choose Claude account context | Profiles panel, new-session selector, profile config | Selects a concrete Claude config folder; does not move existing sessions. |
| Start a named helper | `spawn-agent`; new-session UI | Starts a process/tab. Follow installed `herdr-agents` and README “spawn-agent”. |
| Message, answer a question or permission prompt | Session sheet; session API | Sends input to a live session. Verify target and current dialog; requires authorization for that input. |
| Sleep, wake or restart | Session actions; `board restart` | Depends on herdr-wake and profile guards; restart ends process-local work. |
| Schedule work | `board remind` / `board every`; Schedule panel | Persistent prompt delivery to a session; see [lifecycle](schedule.md). |
| Archive / return | Archive UI; `board archive`; archive API | UI/API closes the pane after its undo window; the CLI closes it immediately. Return starts a session. |
| Use a terminal, files or MokuPilot | Session sheet, when enabled/available | Terminal input runs commands; opening files/URLs and starting a call are actions too. |

Typical authorized updates to the caller's card:

```sh
board cat work
board doing "Reviewing the implementation"
board ask "Which of the two approaches should I use?"
board wait "Review from the other session"
board done "Review complete; findings are in the report"
```

These are alternative lifecycle updates, not a script to run all at once. `doing` clears
prior wait/ask/result, `done` clears doing/wait/ask and keeps its result, and `clear` removes
those text fields. `cat <id> "<Title>"` can also create a new category. Use `--session` only
for a verified, authorized other target. A genuine user prompt clears an agent's ask; board
reminders and background-task notices do not count as that answer.

## Read the indicators correctly

| Indicator | Meaning | What to check |
| --- | --- | --- |
| Working / Needs me / Waiting on others / Done / Idle | Work, user attention, external dependency, completion, idle | The sheet's actual question/result; a manual column pin lasts until the session works again. |
| A card age such as `12 h` | Needs me: `askSince`, else activity. Waiting on others: `waitSince`, else activity. Other columns: activity. | Elapsed time, not active work duration. Activity can be the transcript file's mtime. |
| `Usage —` | No usable local usage reading, not zero use | The usage popover names source/time when known; usage comes from status line or usagebar cache. |
| Usage percentage | Percentage consumed in 5-hour/7-day windows | Readings older than 30 minutes are stale. With multiple shown profiles, inspect per-profile readings. |
| `Setup incomplete` | Checks comparing this copy to installed commands/hooks/config | Another installed copy can be intentional for a preview; check paths before running an installer. |
| Connected indicator | The browser's connection/data freshness state | It does not prove that copied card metadata is current. Inspect timestamp sources and state roots. |

Setup counts `warn`/`error` checks; optional `off` and platform `na` entries do not raise its
incomplete count. `board doctor` inspects setup; `agent-board.install` changes it. Install
rewrites owned shims/hooks and the `herdr-agents` skill in shown profiles, preserving a custom
status line and unrelated settings. Hidden profiles are skipped by the general installer.
The per-profile Install action targets the selected profile, so verify its identity first.

## Categories, profiles and workspaces

| Concept | What it controls | Boundary |
| --- | --- | --- |
| Category | A card's lane, title, color, order, folder rules and usual launch profile | Explicit card category wins; otherwise the longest matching folder rule wins. Not an ACL. |
| Claude profile | A config folder/account environment, shown/hidden state, launch command/args and usage | Hidden removes it from selectors/new sessions/general Install. Its running sessions still appear and agents can start helpers in their own hidden profile. |
| Herdr workspace | Terminal layout/grouping and where the board/session opens | A workspace ID differs from its label; it is not a Claude account or a ChatGPT Space. |

A lane's usual profile affects future launches, not existing sessions. Profile IDs/folders
remain stable when renamed. Do not identify a session's account from its category or name.
A missing profile tag or a zero profile count can reflect missing hook metadata; it does not
prove no sessions exist. Do not fill that gap by guessing a profile or copying credentials.

The board can discover the default profile, its own `CLAUDE_CONFIG_DIR` and used sibling
profile folders. Other discovered folders start hidden. Showing or adding a profile is not
OS authentication; changing its folder, start command or hooks changes execution context.
There is no dashboard user/role ACL or grant-access API. Keep the existing localhost boundary
unless a separate remote-access design is authorized.

## Configure the interface

- Settings → Appearance, Session panel and Show sleeping sessions: this browser's view.
- Settings → Language: `auto`, `en` or `ru` in this dashboard's config, shared by its viewers.
- Categories: titles, colors, order and folder rules. Keep IDs stable; deleting a category also
  clears its assignments on cards, and the fallback `other` category cannot be deleted.
- Settings → Profiles (when multiple folders are found): title/color, shown/hidden and start
  command; at least one profile remains shown. A start command can invoke an existing alias;
  it is not a place to put credentials or bypass permission checks. Profile `args` is a
  config-file field, not an accepted field of the profile-update HTTP operation.
- Other config fields include `workspace`, `placement`, `port`, `refreshSec`, `wakeUrl`,
  `scheduleWaitMin`, `web`, `terminal`, `launch` and `mokupilot`. See README “Settings” and
  “New sessions”. Preserve fields not involved in the request; do not replace the entire
  config with a partial example. Port/server-start choices need a controlled restart, while
  language/category/profile edits are watched live.

Changing a label or browser view does not imply a request to install hooks, enable accounts,
start a session, expose the port or schedule work. Verify the authorized change through its
own state and effect; optional integrations being off is not a reason to install them.

Source map (paths relative to the running checkout): `src/entrypoints/cli.ts`,
`src/adapters/config-file.ts`, `src/core/profiles.ts`, `src/core/setup.ts`,
`web/src/models/card.ts`, `web/src/models/limits.ts`, `web/src/models/settings-menu.ts`.
