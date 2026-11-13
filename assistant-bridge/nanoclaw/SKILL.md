---
name: add-hub-bridge
description: Connect this NanoClaw to an agent-board team hub through the assistant bridge, so the owner's board and the host assistant can message each other. Use when the owner asks to add the hub bridge, to check it, or to switch it off.
---

# Add the hub bridge (the host assistant's topics, and group chats)

The assistant bridge (agent-board repository, `assistant-bridge/`) holds the hub key and connection. This skill adds the NanoClaw half: a module that writes hub messages into the host assistant's topic sessions, and two agent tools, `hub_send` and `hub_inbox`. Containers never see the hub key or the bridge socket.

Written for NanoClaw 2.0.x (the v2 architecture, 2.0.64). Check that `src/channels/adapter.ts`, `src/delivery.ts` (`registerDeliveryAction`), `src/session-manager.ts` (`resolveSession`, `writeSessionMessage`) and `container/agent-runner/src/mcp-tools/server.ts` (`registerTools`) exist before you start.

## Files

Copy from this folder into the NanoClaw checkout, same paths:

| From here | To NanoClaw |
|---|---|
| `src/modules/hub/protocol.ts` | `src/modules/hub/protocol.ts` |
| `src/modules/hub/core.ts` | `src/modules/hub/core.ts` |
| `src/modules/hub/core.test.ts` | `src/modules/hub/core.test.ts` (vitest) |
| `src/modules/hub/index.ts` | `src/modules/hub/index.ts` |
| `src/modules/hub/index.test.ts` | `src/modules/hub/index.test.ts` (vitest) |
| `src/container-env.ts` | `src/container-env.ts` (new; see the edits below) |
| `container/agent-runner/src/mcp-tools/hub.ts` | `container/agent-runner/src/mcp-tools/hub.ts` |
| `container/skills/hub/SKILL.md` | `container/skills/hub/SKILL.md` |

`protocol.ts` must stay the same code as the bridge's own `assistant-bridge/src/protocol.ts`; NanoClaw's prettier formats it its own way (the pre-commit hook does), and a test in the agent-board repository compares the two without the formatting.

Checked against NanoClaw 2.0.64: `pnpm run typecheck`, eslint (no errors in these files), prettier, `pnpm exec vitest run` (the core's 14 tests; the rest as without the module) and, in `container/agent-runner`, `tsc --noEmit` and `bun test` (as without the module). On Windows the core test uses a named pipe, since Node takes a socket path only on Linux and macOS.

## Three small edits

1. `src/modules/index.ts`: append `import './hub/index.js';`
2. `container/agent-runner/src/mcp-tools/index.ts`: add `import './hub.js';` beside the other tool imports, before `startMcpServer`.
3. `src/container-runner.ts`: import `containerEnvFor` from `./container-env.js`, and in `buildContainerArgs`, after the provider's env vars are pushed, pass the module env to the container:

   ```ts
   for (const [key, value] of Object.entries(containerEnvFor(agentGroup))) {
     args.push('-e', `${key}=${value}`);
   }
   ```

   This is how a group's container gets `NANOCLAW_HUB=1` and nothing else does. Without this edit the host assistant still works; group chats in containers get no hub tools.

All of it does nothing unless the hub is switched on below.

## Switch it on

In `.env` (or the service's environment):

```
HUB_BRIDGE_SOCKET=<the bridge's state dir>/bridge.sock
HUB_BRIDGE_HOST_GROUP=<the host assistant's agent group folder>
HUB_BRIDGE_GROUPS=<other agent group folders, comma-separated; optional>
```

The bridge's config must name the inbox topic (`inbox.topic`) by NanoClaw's thread id for it or by its name. Then build and restart NanoClaw the way this install does it (`pnpm run build`, restart the service).

For each group in `HUB_BRIDGE_GROUPS`, add a publish entry to the bridge's config, by the agent group's id (`ncl groups list`), and send the bridge SIGHUP:

```json
{ "alias": "crew", "at": "group:<agent group id>", "about": "the crew chat" }
```

The owner then opens a topic titled `[crew] ...` on the board; it lands in that chat's main session and its answers come back to the same topic. Add `"members": true` to let teammates open such topics too. A running group container gets the hub tools only after it restarts (`ncl groups restart --id <agent group id>`, or the idle reaper).

## Check it is on

- The log has `hub: module started` and `hub: connected to the bridge`.
- `assistant-bridge status` on the bridge's side shows the module connected.
- In a topic of the host assistant, ask the assistant which hub tools it has: `hub_send` and `hub_inbox`.
- A message from the owner's board lands in the inbox topic's session; the bridge writes one title line into that topic for a new hub topic.

## Check it is off

Remove `HUB_BRIDGE_SOCKET`, restart: no `hub:` lines in the log, no `hub` channel among the started adapters, and no hub tools in any agent's tool list (`NANOCLAW_HUB` is never set). Nothing else changes; the files can stay.

## What it touches

- The host assistant's agent group (`HUB_BRIDGE_HOST_GROUP`) and its Telegram chat, and each `HUB_BRIDGE_GROUPS` group's oldest Telegram chat. A hub tool called from any other session is answered `not sent`.
- Host-runtime agents inherit `NANOCLAW_HUB=1` from NanoClaw's environment, so every host-runtime group gets the two tools; the host side refuses all but the chats above. Container agents get the tools only for the `HUB_BRIDGE_GROUPS` groups (`src/container-env.ts`).
- A group answers only in the hub threads bound to its chat, opens new topics only with the owner, and its `hub_inbox` shows only its threads (the bridge enforces it). Notices never go to a group chat.
- Hub messages are written as inbound rows (`sender: "Hub"`), never posted to a chat. Only the bridge's title notices are posted, into the inbox topic.
