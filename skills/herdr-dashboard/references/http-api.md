# Local HTTP API

These are the existing TypeScript web UI's routes, not a separately versioned public SDK.
Verify them against the running checkout after an upgrade. Prefer the CLI for card lifecycle
and schedule creation; use the web API for the UI operations below. The server binds
`127.0.0.1`; first discover the actual origin/port using [discovery](discovery.md).

## Read before acting

| Method/path | Returns / use |
| --- | --- |
| GET `/api/board` | Current items, categories, profiles, limits, schedules, scheduleLog, setup summary, freshness and bundle version. |
| GET `/api/events` | Server-sent board snapshots and reveal events. |
| GET `/api/setup` | Full setup checks with id, level, detail and suggested fixes. Reading is not installing. |
| GET `/api/session/<key>` | Session detail, conversation, helpers, queued messages and current dialog, when available. |
| GET `/api/session/<key>/changes` | Git changes for its checkout. |
| GET `/api/session/<key>/history?q=<query>` | Related conversation history in that session's profile. |
| GET `/api/archive` | Archived records and undo interval. |
| GET `/api/launch/options` | Available launch choices; does not itself start a session. |

Encode returned keys in URL paths. Do not invent session IDs or dump private conversation
payloads. `/api/board` includes a per-run `fsToken`: it is for protected file/terminal reads,
not something to log, embed in documentation, or reuse as an account credential.

Example inspection, using the verified origin (12422 is only the default):

```sh
BOARD_ORIGIN='http://127.0.0.1:12422'
curl -fsS "$BOARD_ORIGIN/api/board" | python3 -c '
import json, sys
b = json.load(sys.stdin)
print({k: b.get(k) for k in ("version", "stale", "lastSuccessfulRefreshAt")})
print({"cards": len(b.get("items", [])), "schedules": len(b.get("schedules", []))})'
```

## Configuration and schedule writes

All operations in this table are POST requests with JSON and `X-Board: 1`. Profile operations
also check Origin when supplied; use the verified board origin, never spoof a different one.
`X-Board` and Origin checks are request guards, not user authentication or permission grants.

| Path | Accepted operation/body fields | Effect / limitation |
| --- | --- | --- |
| `/api/settings` | `language`: `auto`, `en` or `ru` | Only language; not a generic configuration patch. |
| `/api/categories` | `create`: id/title/color/paths | Creates a lane; ID is lowercase `[a-z0-9_-]{1,32}`. |
| `/api/categories` | `update`: id and optional title/color/paths/profile | Changes existing lane; `profile:""` clears its usual launch profile. |
| `/api/categories` | `order`: ids array; `delete`: id | Delete also clears affected card assignments; fallback `other` stays. |
| `/api/profiles` | `update`: id and optional title/color/hidden/command | At least one shown profile; `args` is not handled here. |
| `/api/profiles` | `add`: dir | Adds an existing absolute or `~/...` folder. Does not create/login to an account. |
| `/api/profiles` | `install`: id | Writes owned hooks/status line/skill into that profile; not just visibility. |
| `/api/schedule` | `cancel`: id; `mode`: id/idle boolean | No create, text/time edit, pause or run-now op. Restarts cannot change mode. |

Example **authorized change**, not a probe:

```sh
curl -fsS "$BOARD_ORIGIN/api/settings" \
  -H 'X-Board: 1' -H 'Content-Type: application/json' \
  -d '{"language":"en"}'
```

For category/profile/schedule bodies include `op`, for example
`{"op":"update","id":"<verified-category-id>","title":"Project"}` or
`{"op":"mode","id":"<returned-schedule-id>","idle":true}`. Keep unknown config fields;
these endpoints return structured errors for refused operations. Config edits normally return
200 or 409; schedule cancellation/mode returns 404 for a gone ID and 400 for unsupported ops.
Do not assume unsupported JSON fields are validated: some are ignored.

## Other supported UI actions

These are discoverable capabilities, not generic examples to execute. Before automating one,
read its exact body schema in the listed route/client source and resolve the target again.

| Route family | Supported actions | Source / guard detail |
| --- | --- | --- |
| POST `/api/session/<key>/<action>` | `focus`, `wake`, `sleep`, `restart`, `message`, `answer`, `permit`, `rename`, `card`, `archive`, `mokupilot` | `src/server/routes/session.ts`; all require X-Board. Herdr actions require fresh data; dialogs/archive also Origin, MokuPilot Origin. Rename with `claude:true` sends `/rename` and checks freshness. |
| POST `/api/archive` | `archive`, `return`, `remove`, with keys array | `src/server/routes/archive.ts`; X-Board/Origin, fresh data for archive/return. Inspect both `done` and `failed` even on HTTP 200. |
| POST `/api/launch` and `/api/launch/<id>/...` | Start; `dismiss`, `focus`, `trust`, `close` | `src/server/routes/launch.ts`, `src/core/launch/`; X-Board/Origin, fresh data except dismiss. Trust and close have real effects. |
| `/api/term/...` | Stream and input/control for the session or shell terminal | `src/server/routes/terminal.ts`; token for GET stream, X-Board/Origin/fresh data for POST. Input executes in the target terminal. |
| `/api/fs/...`, `/api/open-url`, `/api/upload` | Directory/stat/preview reads, file/URL opening, raw media and uploads | `src/server/routes/fs.ts`, `src/server/uploads.ts`; file inspection uses POST too. Opening and uploading are side effects; raw reads use the per-run token. |

Message bodies include the current `session` identity, `text`, optional uploaded file paths
and `requestId`. The handler rechecks the live session/pane and gates duplicate requests. Do not
replace a lost-response retry with a new identity/request ID; inspect delivery first. Dialog
answers use current question/permission data, not a reusable blanket approval body. A permission
prompt must never be answered merely because an endpoint exists.

Some endpoints are POST even when inspecting files; classify the operation by its effect,
not just its verb. A 404 can mean the target disappeared; a 409 can indicate stale state,
identity/profile mismatch or another refusal. Read the response, refresh state and fix the
cause. Never force a mutation by suppressing guards or switching to raw terminal input.

Implementation map: `src/server/app.ts` registers routes; `src/server/http.ts` defines guards;
`src/core/payload.ts` describes board data; `web/src/api/client.ts` and the feature-specific
web hooks/models show the exact payloads the UI sends. The authoritative code for launch and
terminal bodies is intentionally referenced instead of duplicating those changing schemas.
