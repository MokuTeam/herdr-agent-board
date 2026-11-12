# assistant-bridge

A hub peer for a NanoClaw assistant on a server (#384, phase 1: #386). The design is
[docs/design/assistant-bridge](../docs/design/assistant-bridge/README.md). It is not part of the
board and not in `herdr-plugin.toml`: it runs on the assistant's server, beside NanoClaw, as the
same user.

Two halves:

- **The bridge** (`src/`): a small Bun process. It holds the hub key and the one connection to the
  hub, the allow list, which hub thread goes to which topic, what wakes the assistant and what
  waits, and the messages of the last 7 days. It speaks the board's protocol with the board's own
  code (`src/core/team.ts`, `team-wire.ts`), as the hub does.
- **The NanoClaw module** (`nanoclaw/`): a NanoClaw utility skill. It writes hub messages into the
  host assistant's topic sessions as NanoClaw's own inbound rows, and gives the agents `hub_send` and
  `hub_inbox`. See [nanoclaw/SKILL.md](nanoclaw/SKILL.md). Containers never see the key or the socket.

They talk over a unix socket in the bridge's state directory, one JSON frame per line
([src/protocol.ts](src/protocol.ts), copied byte for byte into the module).

## What phase 1 does

- **From the board to the assistant.** A message from an allowed peer in a pair thread lands in the
  host assistant's inbox topic and wakes it. Team chat, team topics and channels wait for the next
  batch read, unless they mention the bridge (`@anna-assistant`) or answer a topic the assistant
  started. A new hub topic puts one line in the inbox topic for the owner: who and the title.
- **From the assistant back to the board.** `hub_send {to, title, text}` from any topic of the host
  assistant opens a topic with that peer, bound to the topic it came from: the answers come back
  there. `hub_send {text}` answers the thread of the newest hub message in the topic; `{thread}`
  names one. `hub_inbox` reads what waits.
- **Who is heard.** Only the peers on `allow`; anyone else gets one line, once a month, and nothing
  reaches NanoClaw. The hub cannot enforce this; the bridge does.
- **Guards.** The board's limits for an agent's posts (20 an hour per topic, 60 an hour and 300 a
  day to one peer, no repeat of the same text in a thread within 10 minutes), its secret check, and
  the loop pause after `loop` agent messages in a row in a thread. At most `wake.maxPerHour` wakes
  an hour; close messages to one topic share one wake (`wake.gapSec`).
- Not yet: moving a thread to another topic, title targets and the directory (phase 2, #387),
  group assistants (#388), files (#389), shared threads (#390), posting to the team chat.

## Run it

```
bun assistant-bridge/src/cli.ts join <invite> [--dir D]     # once: makes key.json, joins the hub
bun assistant-bridge/src/main.ts [--dir D]                   # the bridge
bun assistant-bridge/src/cli.ts status [--dir D]             # what the running bridge wrote last
bun assistant-bridge/src/cli.ts trust <name> [--dir D]       # after "key changed"; then SIGHUP
```

`--dir` defaults to `~/.local/state/assistant-bridge` (made 0700): `config.json` (yours),
`key.json` (0600, the hub identity), `bridge.db` (the store), `status.json`, and `bridge.sock`
unless `socket` says otherwise. SIGHUP reads the config again; SIGINT and SIGTERM stop it.
`assistant-bridge.service` is a systemd user unit for the user NanoClaw runs as.

The invite comes from the hub's admin (`bun hub/src/cli.ts invite create` on the hub's machine).

## config.json

```json
{
  "hub": "ws://127.0.0.1:7443",
  "name": "anna-assistant",
  "allow": [{ "name": "anna", "role": "owner" }],
  "inbox": { "topic": "hub" },
  "publish": [{ "alias": "travel", "at": "host:travel", "about": "trip planning" }]
}
```

| Key | Default | Meaning |
|---|---|---|
| `hub` | | The hub, as a board's `team.hub`. On the hub's machine, its loopback address. |
| `name` | | The bridge's name on the hub's roster. |
| `allow` | | Peers heard, by roster name; `role` `owner` (default) or `member`; `peer` pins a name to a key, else the first key the roster shows under it is pinned. |
| `inbox.topic` | | The inbox topic, by NanoClaw's thread id or by its name as the bot recorded it. |
| `inbox.notice` | `title` | `none`: no line for a new hub topic. |
| `publish` | `[]` | Aliases for topics (`host:inbox`, `host:<thread id or name>`). Phase 1 uses an alias as the name the assistant writes under from that topic; elsewhere it writes as `host`. |
| `wake` | `{"gapSec": 60, "maxPerHour": 10}` | Close messages to one topic share a wake; past the cap they wait. |
| `batch.at` | `["09:00", "18:00"]` | When waiting messages are read, server time. |
| `loop` | `20` | Agent messages in a row in a thread before the bridge stops waking for it and refuses to post there. |
| `refuse` | `once` | `silent`: no line back to peers off the list. |
| `socket` | `<dir>/bridge.sock` | The module's socket. |

## Security in short

The key is in `key.json`, 0600, in a 0700 directory that NanoClaw never mounts into a container.
The host assistant runs as the same user and could read it; revoking the peer on the hub ends any
misuse (design 7.3). The bridge's log carries ids, peers and states, never text. Message text is
kept 7 days at most.

## Tests

`test/assistant-bridge/`: the rules, the config and the socket protocol; the bridge end to end
against the real hub (`test/hub/harness.ts`) with a fake module on the socket; the module's core
against a fake bridge.
