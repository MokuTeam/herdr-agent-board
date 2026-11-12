---
name: add-hub-bridge
description: Connect this NanoClaw to an agent-board team hub through the assistant bridge, so the owner's board and the host assistant can message each other. Use when the owner asks to add the hub bridge, to check it, or to switch it off.
---

# Add the hub bridge (phase 1: the host assistant's topics)

The assistant bridge (agent-board repository, `assistant-bridge/`) holds the hub key and connection. This skill adds the NanoClaw half: a module that writes hub messages into the host assistant's topic sessions, and two agent tools, `hub_send` and `hub_inbox`. Containers never see the hub key or the bridge socket.

Written for NanoClaw 2.0.x (the v2 architecture, 2.0.64). Check that `src/channels/adapter.ts`, `src/delivery.ts` (`registerDeliveryAction`), `src/session-manager.ts` (`resolveSession`, `writeSessionMessage`) and `container/agent-runner/src/mcp-tools/server.ts` (`registerTools`) exist before you start.

## Files

Copy from this folder into the NanoClaw checkout, same paths:

| From here | To NanoClaw |
|---|---|
| `src/modules/hub/protocol.ts` | `src/modules/hub/protocol.ts` |
| `src/modules/hub/core.ts` | `src/modules/hub/core.ts` |
| `src/modules/hub/index.ts` | `src/modules/hub/index.ts` |
| `container/agent-runner/src/mcp-tools/hub.ts` | `container/agent-runner/src/mcp-tools/hub.ts` |
| `container/skills/hub/SKILL.md` | `container/skills/hub/SKILL.md` |

`protocol.ts` must stay byte for byte the bridge's own `assistant-bridge/src/protocol.ts`.

## Two one-line edits

1. `src/modules/index.ts`: append `import './hub/index.js';`
2. `container/agent-runner/src/mcp-tools/index.ts`: add `import './hub.js';` beside the other tool imports, before `startMcpServer`.

Both modules do nothing unless the hub is switched on below.

## Switch it on

In `.env` (or the service's environment):

```
HUB_BRIDGE_SOCKET=<the bridge's state dir>/bridge.sock
HUB_BRIDGE_HOST_GROUP=<the host assistant's agent group folder>
```

The bridge's config must name the inbox topic (`inbox.topic`) by NanoClaw's thread id for it or by its name. Then build and restart NanoClaw the way this install does it (`pnpm run build`, restart the service).

## Check it is on

- The log has `hub: module started` and `hub: connected to the bridge`.
- `assistant-bridge status` on the bridge's side shows the module connected.
- In a topic of the host assistant, ask the assistant which hub tools it has: `hub_send` and `hub_inbox`.
- A message from the owner's board lands in the inbox topic's session; the bridge writes one title line into that topic for a new hub topic.

## Check it is off

Remove `HUB_BRIDGE_SOCKET`, restart: no `hub:` lines in the log, no `hub` channel among the started adapters, and no hub tools in any agent's tool list (`NANOCLAW_HUB` is never set). Nothing else changes; the files can stay.

## What it touches

- Only the host assistant's agent group (`HUB_BRIDGE_HOST_GROUP`) and its Telegram chat. A hub tool called from any other session is answered `not sent`.
- Host-runtime agents inherit `NANOCLAW_HUB=1` from NanoClaw's environment, so every host-runtime group gets the two tools; the host side refuses all but the host assistant. Container agents do not get the tools in this phase.
- Hub messages are written as inbound rows (`sender: "Hub"`), never posted to a chat. Only the bridge's title notices are posted, into the inbox topic.
