# Local HTTP API: source index

The dashboard UI has internal HTTP routes, not a separately versioned public SDK. There is
no OpenAPI/Swagger specification or API-doc generator in this checkout. For exact request
bodies, guards and responses, read the **running version's** route and UI client together;
TypeScript types alone do not describe every runtime check.

First establish the origin with [discovery](discovery.md). Read-only starting points are
`GET /api/board` and `GET /api/setup`. The board payload's `fsToken` must not enter logs or
reports. Example using the verified origin (12422 is only the default):

```sh
BOARD_ORIGIN='http://127.0.0.1:12422'
curl -fsS "$BOARD_ORIGIN/api/board" | python3 -c '
import json, sys
b = json.load(sys.stdin)
print({k: b.get(k) for k in ("version", "stale", "lastSuccessfulRefreshAt")})
print({"cards": len(b.get("items", [])), "schedules": len(b.get("schedules", []))})'
```

Paths below are relative to the source checkout. This is a navigation map; do not construct a
mutation from a route name alone.

| Surface | Authoritative implementation |
| --- | --- |
| Board snapshot / event stream | `src/server/routes/board.ts`, `src/server/board-state.ts`, `src/core/payload.ts` |
| Setup inspection | `src/server/routes/setup.ts`, `src/services/setup-check.ts` |
| Language, categories, profiles | `src/server/routes/settings.ts`, `src/adapters/config-file.ts` |
| Schedule cancellation / mode | `src/server/routes/schedule.ts`; creation is in `src/entrypoints/cli.ts` |
| Session reads, messages, dialogs and actions | `src/server/routes/session.ts` |
| Archive batches | `src/server/routes/archive.ts` |
| New-session lifecycle | `src/server/routes/launch.ts`, `src/core/launch/` |
| Terminal stream / control | `src/server/routes/terminal.ts` |
| File inspection, open and upload | `src/server/routes/fs.ts`, `src/server/uploads.ts` |
| Route registration / guards / UI calls | `src/server/app.ts`, `src/server/http.ts`, `web/src/api/client.ts` and feature hooks |

Before an authorized write, resolve the target again and read the handler's exact accepted
fields. `X-Board: 1`, Origin, freshness and per-run-token guards serve different purposes;
none grants user authorization. Do not assume every endpoint uses every guard. Some file
inspection requests use POST, so classify by effect, not HTTP verb alone.

Inspect response bodies as well as status. Archive batches can return HTTP 200 with both
`done` and `failed`. A successful send is not proof of completed work; preserve its request
identity and inspect delivery before retrying an uncertain response. A missing method or
refused target is not permission to bypass guards with terminal input.

Keep exact schemas in code and behavior in README. Update this index when a route family or
its owning source moves; verify the example against an isolated fixture after payload changes.
