# Assistant bridge: the team hub and a NanoClaw assistant

Design for [#384](https://github.com/MokuTeam/herdr-agent-board/issues/384). Nothing here is built
yet. It is written so that an agent who was not part of the discussion can build each phase from
it, and it fits the threads design of [#379](https://github.com/MokuTeam/herdr-agent-board/issues/379)
(draft PR #381, `docs/design/threads`) instead of adding a parallel idea of a thread.

Names in the examples are made up. The owner is anna; her board is the hub peer `anna`; her
assistant's server joins the hub as the peer `anna-assistant`; ben and cleo are teammates. The
host assistant has topics such as `hub`, `travel` and `garden`, and runs a group assistant for a
group chat called `book-club`.

## What the owner wants first

Two things, and phase 1 does both:

- **From the board to the assistant.** The owner, or one of the owner's sessions, sends something
  from the board to the assistant on the server: a task, a file's contents, a question.
- **From the assistant back to the board.** The owner, talking to the assistant in any of its
  Telegram topics, has it send something to the board: a result, a note for a session, a task.

Everything else in this document (moving threads between topics, the directory, group assistants,
files, shared threads) builds on those two paths.

## The owner's decisions

The open questions of the first draft, answered by the owner on 2026-11-12. The document below
follows these answers.

1. **Who may address the assistant:** the owner's own board only (the owner in the Team panel and
   the owner's sessions). A teammate can be added later as a `member` (8.1), whose requests the
   assistant handles the way it handles a request from a person in one of its group chats; anything
   that commits the owner goes to the owner first.
2. **The roster:** teammates see `anna-assistant` in the roster and get one line back if they write,
   "this assistant takes messages from anna's board only". No hub change.
3. **No separate system user.** The bridge runs as the same user as NanoClaw, and the key is
   protected by file permissions (7.3).
4. **The inbox topic:** the bridge writes one line there for each new hub topic (who and the title,
   never the text), and the assistant writes what it decides to.
5. **The directory** publishes only the aliases the owner lists in the bridge's config (4.5).
6. **Limits:** batched traffic is read at 09:00 and 18:00 server time and only when something
   waits; at most 10 wakes an hour from the hub; the loop pause after 20 agent messages in a row in
   a thread.
7. **Lanes:** the owner's sessions may talk with the assistant from every lane. Which lanes the
   board shares with the bridge peer is a setting, and its default is all lanes (8.4).
8. **The NanoClaw part** is a change in the owner's NanoClaw checkout, reviewed there like any
   other change, and the same files are kept in this repository as a NanoClaw skill for other
   owners (9.1).

## Contents

1. [The answer in short](#1-the-answer-in-short)
2. [What exists today](#2-what-exists-today)
3. [Architecture](#3-architecture)
4. [Addressing and thread to topic binding](#4-addressing-and-thread-to-topic-binding)
5. [Wake and batch](#5-wake-and-batch)
6. [How input reaches the assistants](#6-how-input-reaches-the-assistants)
7. [Security](#7-security)
8. [Visibility](#8-visibility)
9. [Packaging and the switch](#9-packaging-and-the-switch)
10. [Phases and the issues to open](#10-phases-and-the-issues-to-open)
11. [Not in this design](#11-not-in-this-design)

## 1. The answer in short

The assistant's server joins the hub as one ordinary peer with its own key and invite. The hub
needs no change: it already relays for any client that signs its frames, and it never checks what
the client is.

Two pieces run on that server:

- **The bridge**, a small Bun process from this repository (`assistant-bridge/`, beside `hub/`).
  It holds the hub key and the one hub connection, the allow list, the table that binds hub threads
  to the assistant's topics and groups, the wake and batch rules, and a short-lived message cache.
  It reuses the board's wire code (`src/core/team.ts`, `team-wire.ts`) exactly as the hub does.
- **The hub module**, a thin addition to NanoClaw. It writes hub messages into the right agent
  session as NanoClaw's own inbound rows, with or without a wake, and gives the agents four tools
  (`hub_send`, `hub_inbox`, `hub_bind`, `hub_threads`). It talks to the bridge over a unix socket.
  Containers never see the key or the socket.

Routing works like email. A hub message in a thread nobody has bound goes to the host assistant's
inbox topic. There the assistant handles it or moves it to a topic or a group with `hub_bind`, and
from then on every message in that hub thread goes straight there. A sender may name the target
in the topic's title (`[travel] Hotel options`), from a directory the bridge publishes. When the
assistant writes from a topic, the message goes to the hub thread bound there, or opens a new one
bound to that topic.

Hub text is never posted into a human group chat. It reaches a group assistant as context, and the
assistant decides whether to say anything in the group.

Messages addressed to the assistant wake it at once. Everything else waits in the bridge and is
read on a schedule, one wake for the lot.

Decisions this document takes, each argued where it comes up:

| Question | Decision |
|---|---|
| One process inside NanoClaw, or a separate bridge? | Both halves: the NanoClaw part must run inside NanoClaw's process, the hub part need not and is better outside it. (3.1) |
| How is input "typed into" the host assistant? | It is not typed. NanoClaw's host assistant is a set of per-topic sessions started on demand; the module writes an inbound row into the topic's session and wakes it. (6.1) |
| How does a sender reach a group or a topic? | The bridge's binding table; a title prefix from the published directory now; the assignee of a shared thread once #379 phase 4 lands. No new wire field. (4) |
| How does the assistant answer the hub? | Only through `hub_send`. NanoClaw's default reply goes to the session's own chat, which in a group is the humans' chat. (4.6, 6.2) |
| What wakes it? | A message in a pair thread, a reply in a thread it started, a mention. Team traffic waits for the scheduled read. (5) |
| Who may write to it? | An allow list kept by the bridge; by default the owner's board only. The hub cannot enforce it. (8) |
| Is this the "two-way bridge to an outside chat" that #379 rejects? | No. Telegram text never goes to the hub; only what the assistant sends with `hub_send` does. (3.4) |

## 2. What exists today

### 2.1 The hub and the board

Read from the code at `main` 0995603b.

- **The hub relays and queues.** `hub/src/hub.ts`: a peer says `hello {v, peer, client, caps,
  box}`, gets a `challenge`, answers with `auth` (a known key) or `join` (a single-use invite), and
  receives `welcome`, the roster and whatever was queued for it. A peer is an Ed25519 key plus a
  name; the hub has no notion of person, board or agent, and the `client` string is never checked.
  `board team join` (`src/services/team-join.ts`) is already a second, minimal client.
- **Messages.** A signed envelope `{from, payload, sig}`, relayed byte for byte. The payload has
  `id, from, to, kind, ts, ttl_s, body`; the body has `text` (up to 4,000 characters), `via:
  "agent"` with the sending session's name in `agent`, `thread`, `replyTo`, `post`, `file`. The hub
  checks only the signature, `text`, `kind` and `to`, and passes other body fields through as
  signed, so a new body field needs no hub release. Boards read bodies strictly, so a sender only
  adds a field for a peer whose caps say it understands it.
- **Delivery.** A queue per recipient with a TTL (24 hours by default, 7 days at most). The
  recipient acks every delivery with a signed ack, and the hub then drops the body. There is no
  history and no order across senders.
- **Threads and channels are the boards' idea.** A topic is a `ThreadRef {id, title, link, group,
  members}` inside the body. A team post is one signed copy per member; a channel is a team thread
  with a member list, sent to its members only. The hub audits nothing but the thread id.
- **Files** are sealed end to end to the recipient's X25519 box key, which the peer advertises in
  `hello`. Text is not end-to-end encrypted: the hub holds it while it is queued.
- **No access control between peers.** Every member sees the whole roster and may send to any
  active member. A board can only leave Agents off for a peer (its messages wait in the Team panel)
  or mute it.
- **The board's router** (`src/services/team-router.ts`) sends an inbound message to the session
  that handles its thread, else to the board's listener. It notices a session with a line in the
  board's own words, `[board reminder from team] ...`, never the peer's text; the session reads the
  text with `board team thread <ref>`, framed as data.
- **What the board holds back** from an agent's post (`agentPost`): a draft for the owner when
  Agents are off for that peer, the session's lane is not shared with the peer, the text looks like
  a secret or names an unshared lane, a text file it carries looks like a secret (#415), or the
  last 20 lines of the thread all came from agents (the loop pause, 1 to 100 per peer). Refused past 20 posts an hour per session, 60 an
  hour and 300 a day per peer.
- **No handoff or mention on the wire.** Task offers and statuses are conventions in the
  `agent-board-team` skill (`taken`, `done: ...`). #379 turns them into shared threads with a `work`
  body field behind a `work` cap (its section 11).
- **No plugin registry in the board.** Optional features are gated by `config.json` keys and by
  caps on the wire. Code that runs on a server and not under herdr already lives here: `hub/`, a
  zero-dependency Bun service with its own systemd units, README and tests in `test/hub/`, outside
  `herdr-plugin.toml`.

### 2.2 NanoClaw

The design targets the NanoClaw the owner runs: a fork of NanoClaw 2.0.64 (the v2 architecture)
with the owner's own commits, and after that the fork's main branch. Upstream NanoClaw has moved on
since; this design does not track it. The facts below were read from the owner's checkout. File
names are relative to NanoClaw's root; line numbers are left out.

- **One host process.** A single Node process runs the channels, the router, delivery and a sweep.
  A central SQLite DB holds agent groups, messaging groups (chats), the wirings between them,
  sessions and destinations. Each session has two more SQLite files: `inbound.db`, written only by
  the host, and `outbound.db`, written only by the agent (`src/session-manager.ts` states the
  one-writer rule).
- **Channels.** `ChannelAdapter` (`src/channels/adapter.ts`): `setup(ChannelSetup)` with
  `onInbound` and friends, `deliver(platformId, threadId, msg)`, `supportsThreads`. A channel
  registers itself with `registerChannelAdapter` and is switched on by one import line in
  `src/channels/index.ts`; a factory that returns null leaves it off. Several channels run at once,
  and chats are keyed by `(channel_type, platform_id)`.
- **Inbound path.** `onInbound` → `routeInbound` (`src/router.ts`): find the chat, pick the agent
  group by its wiring (`engage_mode` pattern, mention or mention-sticky; `ignored_message_policy`
  drop or accumulate; `session_mode`), find or make the session, write a `messages_in` row with
  `trigger` 1 or 0, wake the session.
- **Topics are sessions.** Telegram reports `supportsThreads: true`, and in per-thread mode each
  forum topic is its own session of one chat, with its own context. Topic names are recorded as the
  bot sees them. There is no code that creates a topic, and none that sends into a topic other than
  the session's own.
- **Agents run per session, on demand.** A session's agent starts when it is woken, is reaped after
  20 minutes idle and resumes its conversation next time. Most agent groups run in docker; an agent
  group with `runtime: host` runs the same agent runner as a plain process on the host with the
  owner's user rights. The host assistant is such a group: one session per topic, at most a few at
  once (an extra wake evicts a session that has been quiet for 2 minutes).
- **Context versus wake.** A `trigger: 0` row never wakes the agent; it rides along with the next
  `trigger: 1` batch. The agent reads at most 10 rows per prompt, triggers first and then the newest
  context (`container/agent-runner/src/db/messages-in.ts`), so a pile of context rows loses its
  oldest. A row may carry `process_after`, which is how scheduled tasks work (a host sweep every 60
  seconds).
- **Direct injection already exists.** The Telegram channel writes rows straight into a session
  with `writeSessionMessage` (`src/session-manager.ts`) and wakes it, bypassing the router (poll
  results with `trigger: 1`, notes with `trigger: 0`).
- **Output.** Only `<message to="...">` blocks leave the agent; bare text and `<internal>` are its
  scratchpad (`container/agent-runner/src/poll-loop.ts`). The `send_message` tool with no `to`
  replies into the session's own chat. A reply to a destination takes the thread of the newest
  inbound row from that destination. Delivery checks the target against the session's own chat or
  an `agent_destinations` row (`src/delivery.ts`).
- **Container to host requests.** An agent writes a `kind: 'system'` row; the host dispatches it to
  a handler registered with `registerDeliveryAction` and writes the answer back as a `trigger: 0`
  row. `cli_request` (`src/cli/delivery-action.ts`) is the working example. Agent tools are modules
  in `container/agent-runner/src/mcp-tools/`, one import each.
- **Containers have the network.** They run on docker's default bridge network with unrestricted
  egress (NanoClaw's `docs/SECURITY.md`) and can reach the host through `host.docker.internal`.
- **Extension.** NanoClaw is extended by skills: feature skills as git branches merged into the
  owner's fork, utility skills whose files are copied into place (`docs/skills-as-branches.md`).
- **Memory, not CPU, is what a small server runs short of.** Every wake starts an agent process or
  container.

### 2.3 Where the starting hypothesis meets the code

The brief's hypothesis holds in its shape: one participant, two kinds of addressee, one bridge
that routes, email-like binding, silence in groups, wake versus batch, a visibility setting. Nine
details change:

1. **There is no long-lived host assistant to type into.** The host assistant is one agent group
   whose sessions, one per topic, start when woken and stop when idle. Input reaches it the way it
   reaches a container: a row in the topic's session and a wake. No pty, no tmux.
2. **The host assistant and a group assistant are the same kind of thing to NanoClaw**; only the
   runtime differs. They stay two kinds of addressee because their rights differ (6.1, 6.2).
3. **The bridge cannot live wholly inside NanoClaw's process without cost**, and cannot live wholly
   outside it: only the host process may write a session's `inbound.db`, and NanoClaw's sockets
   offer no injection. So the NanoClaw part is a module in the host process and the hub part is a
   process of its own (3.1).
4. **Moving a thread to a topic has no native support.** The binding table is the bridge's, and
   the move is a tool. NanoClaw cannot create a topic: the owner creates the inbox topic by hand.
5. **Containers have network access.** That containers cannot reach the hub is not a property of the
   network. It holds because containers hold no key and no socket, and every hub action passes
   through the host module (7.2).
6. **Group silence is native, with one gap.** Group wirings accumulate and bare output is never
   sent, but `send_message` without `to` posts into the group chat. Hub replies go through
   `hub_send` only.
7. **The batch cannot be a pile of context rows.** A prompt reads 10 rows at most, so the bridge
   keeps the batch and the agent reads it with a tool (5.3).
8. **"Addressed to her" has no field on the wire.** It comes from the thread's kind (a pair thread
   versus a team copy), a mention in the text, and later #379's `work` fields (5.1).
9. **Visibility cannot be enforced by the hub**, and the peer shows in every member's roster. The
   bridge drops what its allow list does not cover (8).

## 3. Architecture

```mermaid
flowchart LR
  subgraph Boards["Peers on the hub"]
    AB["anna's board<br/>(Team panel, her sessions)"]
    BB["ben's board"]
  end
  HUB[("team hub<br/>relay and queue")]
  AB <-- "signed frames" --> HUB
  BB <-- "signed frames" --> HUB

  subgraph Server["the assistant's server"]
    BR["assistant bridge<br/>key, allow list, bindings,<br/>wake and batch, cache"]
    subgraph NC["NanoClaw host process"]
      MOD["hub module<br/>delivery actions, injection"]
      TG["Telegram channel"]
      RT["router, delivery, sweep"]
    end
    HS["host assistant<br/>one session per topic"]
    GC["group assistant<br/>container per group"]
  end
  HUB <-- "one connection<br/>(loopback when on the same machine)" --> BR
  BR <-- "unix socket" --> MOD
  MOD -- "inbound rows, wake" --> HS
  MOD -- "inbound rows, wake" --> GC
  HS -- "system rows: hub_* tools" --> MOD
  GC -- "system rows: hub_* tools" --> MOD
  TG <--> RT
  RT --> HS
  RT --> GC
  MOD -. "title line in the inbox topic" .-> TG
```

### 3.1 Two parts, and why

The NanoClaw part has to run inside NanoClaw's host process: a session's `inbound.db` has one
writer, the host, and neither of NanoClaw's sockets can put a row into a chosen session or set
`trigger: 0`. So the module that writes rows, registers the delivery actions and hosts the tools'
handlers is NanoClaw code.

The hub part does not have to, and four things argue for keeping it out:

- **The wire code stays in one place.** The hub imports `src/core/team.ts` and `team-wire.ts`; the
  bridge does the same. When #379 adds `work`, or any later change touches the wire, the bridge's
  tests run in this repository's suite beside the hub's. A copy of the protocol inside a NanoClaw
  fork would drift.
- **NanoClaw restarts often** (an owner may deploy it automatically from a branch). The bridge keeps
  its hub connection and its queue through those restarts and delivers what arrived once the module
  is back.
- **Off is simple to prove.** Without the bridge's socket configured, the module's factory returns
  null and NanoClaw runs exactly its old code (9.4).

The cost is two parts to version together. The socket protocol carries a version number, and each
phase ships both halves.

The alternative, all of it inside NanoClaw, works too: one process, no socket. It is the fallback
if the owner prefers one piece over the reasons above.

Both run as the same user (the owner's decision 3). The bridge's state directory lies outside every
directory NanoClaw mounts into a container.

### 3.2 The bridge's store

One SQLite file in the bridge's state directory (mode 0700), in WAL mode as the hub's is:

| Table | Holds |
|---|---|
| `peers` | The allow list as pinned keys: peer id, roster name, role (`owner` or `member`), state (`trusted`, `changed`). |
| `bindings` | Hub thread key (`<peer>/<thread id>` or `team/<thread id>`, the board's form) → location, who bound it, when. |
| `messages` | Inbound and outbound messages, kept 7 days and at most 200 per thread: id, thread, sender, role, text, state (`batched`, `delivered`, `read`, `dropped`), and the run counter for the loop pause. |
| `outbox` | What the bridge sent and the hub has not settled; resent on reconnect, as the board does. |
| `deliveries` | What was handed to the module and not yet confirmed, so a NanoClaw restart loses nothing. |
| `schedule` | The next batch read per location, at most one each. |

The bridge acks a hub delivery once the message is in `messages`, also when it then drops it (a
peer not on the allow list), so the hub does not hold it for days.

### 3.3 The socket

Newline-delimited JSON over a unix socket in the bridge's state directory, mode 0600, owned by the
user both run as. Every frame has `v: 1`.

| Frame | From | What it does |
|---|---|---|
| `hello` | module | The protocol version and the locations it can deliver to: the host assistant's topics (thread id and the name the bot sees), the agent groups (id). |
| `deliver` | bridge | One message for one location: id, location, `trigger`, the text with its header (6.3). |
| `confirm` | module | The row is written; the bridge marks the message `delivered`. |
| `schedule` | bridge | A batch read for a location at a time. The module keeps at most one pending. |
| `call` / `result` | module, bridge | A tool call from a session (`send`, `inbox`, `bind`, `threads`), with the location it came from, and its one-line result. |
| `notice` | bridge | A line for the owner in the inbox topic: a new hub topic, a loop pause, a changed key. |

The module learns the calling location from the session that wrote the system row, never from the
call's arguments, so a group's container cannot pose as the host. This is #379's rule that a write's
author comes from its path.

### 3.4 Not a chat mirror

Section 12 of the threads design rejects a two-way bridge between an outside chat and board threads
because it brings a second identity model, a second place for text to leak, and a new way for
outside text to reach agents. This design avoids all three:

- **One identity model.** The bridge is an ordinary hub peer with its own key, pinned by the boards
  that talk to it like any peer.
- **No mirror of Telegram.** What people write in Telegram never goes to the hub. Only what the
  assistant sends with `hub_send` does, after the bridge's outbound checks (7.4).
- **The boards see an agent, nothing more.** On anna's board the assistant's posts arrive as
  `anna-assistant`'s agent posts and go through the same notices, framing as data, drafts and loop
  pause as any other peer's.

## 4. Addressing and thread to topic binding

### 4.1 Addressees and locations

Inside the bridge an addressee is a **location**:

| Location | Is | Example alias |
|---|---|---|
| `host:inbox` | The host assistant's inbox topic, which the owner created for hub traffic. | `hub` |
| `host:<topic>` | Another topic of the host assistant, by its Telegram thread id. | `travel` |
| `group:<agent group>` | A group's container assistant, by NanoClaw's agent group id. | `book-club` |

The bridge's config gives a location an **alias**, a short name the owner picks, unique across
topics and groups. Aliases are what peers see; thread ids, group ids and the Telegram names of
topics and groups are not published.

On the outbound side the assistant's messages carry `via: "agent"` and the alias in `agent`, so
anna's board shows "anna-assistant's agent travel" or "anna-assistant's agent book-club". The board
already accepts any printable name up to 40 characters there.

### 4.2 Where an inbound message goes

The first rule that matches decides:

| # | The message | Goes to |
|---|---|---|
| 1 | From a peer not on the allow list, or a team copy or channel whose sender is not on it | Nowhere: acked, kept 7 days as `dropped` for the count, the one-line refusal sent once (8.1). |
| 2 | In a hub thread that has a binding | The bound location. |
| 3 | A new topic whose title starts with `[<alias>]` and the alias is published to that sender | That location, and the thread is bound there. |
| 4 | Any other pair thread (the pair's `general`, a new topic) | `host:inbox`. |
| 5 | Team chat, a team topic, a channel | `host:inbox`, as batch unless 5.1 says otherwise. |

Rule 2 comes before rule 3, so a title cannot pull an existing thread away from where the
assistant put it.

### 4.3 Binding

`hub_bind {thread, to, now?}` moves a hub thread to a location. Hub threads are named the way the
board's CLI names them: the first 8 characters of a topic's id, `team` for the team chat's general,
or `general:<peer name>` for a pair's general.

- From any host topic, the host assistant may bind any thread it can see to any location.
- From a group, the group assistant may only hand a thread of its own back to `host:inbox`.
- The new location gets one `trigger: 0` row: "hub thread 1a2b3c4d 'Hotel options' with anna is
  now here; read it with hub_inbox thread=1a2b3c4d". With `now: true` the row wakes it.
- Binding `general:anna` to a topic is allowed and moves everything anna's board sends outside
  topics. The assistant usually leaves general in the inbox.
- `hub_bind {thread, to: "inbox"}` unbinds.
- A binding is never removed by a peer. The bridge sends no notice to the peer about a move; the
  peer sees only who answers (the `agent` alias).

A location may hold several hub threads. One hub thread is bound to one location at a time.

### 4.4 Naming a target

**Now, with no board change:** a sender opens a topic whose title starts with the alias in
brackets: `board team post anna-assistant --new "[travel] Hotel options for May" "..."`. The person
in the Team panel types the same. An alias the bridge does not publish to that sender is ignored,
and the topic lands in the inbox like any other.

**With shared threads (#379 phase 4):** a shared thread carries an assignee, a party
`{kind: 'peer', peer, name, agent?}`. A thread shared with `anna-assistant` whose assignee names
`agent: "travel"` routes to that alias. The threads design lets a board refuse an assignee that names
one of its own sessions from outside; the bridge is not a board and takes it as a routing hint
from a peer that may address that alias, and as an offer from anyone else. The one change this asks
of #379 phase 4 is on the sending side: `board thread new --to anna-assistant/travel` composes such
an assignee for a peer that advertises the `assistant` cap (4.7).

No new wire field is introduced for routing. The title convention retires once boards send the
assignee.

### 4.5 The directory

The bridge publishes what may be addressed, per allowed peer, in a topic it opens with that peer,
titled `anna-assistant: directory`. It posts a new message there when the list changes, and only
then:

```
host: anna's assistant; new topics without a target land here
travel: trip planning
book-club: the book club's group assistant (it never posts hub text into the group)
```

- A peer sees only the entries published to its role: the owner's board sees all listed entries; a
  member sees the entries the owner marks `members: true`.
- Descriptions are the owner's words from the config. The bridge never derives them from Telegram
  names.
- Agents on the board read it with `board team thread <ref>`, people in the Team panel. A later
  board change can turn it into a picker (phase 2 leaves that as an idea, not a promise).

### 4.6 Writing from a topic or a group

`hub_send {thread?, to?, title?, text, replyTo?}`:

- With `thread`: a reply in that hub thread. It must be bound to the calling location (or the
  caller is the host assistant).
- Without `thread`, in a location that has bound threads: a reply in the one that brought the
  newest message here, as a mail client answers the message open on screen. With several open,
  the result line says which thread it went to.
- With `to` (a peer's name or `team`) and `title`: a new topic, bound to the calling location from
  the start. Without `title`, the pair's general.
- The result is one line: `ok · sent to anna in thread 1a2b3c4d`, `not sent: <why>`.

Why a tool and not a NanoClaw destination such as `<message to="hub">`: a destination's reply takes
the thread of the newest inbound row from it, which picks the wrong hub thread as soon as two are
bound to one topic; and in a group, anything that falls back to the default address lands in the
humans' chat. The tool names its thread and has no default that leads into Telegram.

### 4.7 How the boards see the assistant

- The bridge advertises the caps `threads`, `replies` and `channels` in phase 1, `files` in phase 4,
  `work` in phase 5, and `assistant` from the start. The board ignores caps it does not use;
  `assistant` is there so that a later board can show the directory and compose an assignee.
- On anna's board, `anna-assistant` is a peer like ben. The owner turns Agents on for it, and every
  lane is shared with it unless the owner narrows that (8.4). Notices, `board team thread`, drafts
  and the loop pause work unchanged.
- The board's code changes in one place before phase 5: the "all lanes" setting of 8.4, in phase 1.
  Phase 2 adds a paragraph to the `agent-board-team` skill: how to read an assistant's directory
  and name a target.

### 4.8 A worked example

```
# a session on anna's board, lane personal, Agents on for anna-assistant
$ board team post anna-assistant --new "[travel] Hotel options for May" "Three options with prices, by Friday?"
ok · sent to anna-assistant in thread 1a2b3c4d

# the bridge: title alias "travel" is published to anna's board → location host:travel,
# binding 1a2b3c4d → host:travel, a pair thread → wake. The travel topic's session gets:
[hub · anna (owner) · agent planner · thread 1a2b3c4d "[travel] Hotel options for May" · msg 9f8e7d6c]
Three options with prices, by Friday?

# the host assistant, in the travel topic, an hour later
hub_send {text: "Three options: ... Booking needs anna's card, not done."}
→ ok · sent to anna in thread 1a2b3c4d

# anna's board: the session that opened the topic handles it and gets
[board reminder from team] anna-assistant's agent travel wrote in thread 1a2b3c4d, which you handle. Read it: board team thread 1a2b3c4d ...
```

A topic with no alias in its title would have landed in the `hub` topic; the assistant would have
answered there or run `hub_bind {thread: "1a2b3c4d", to: "travel"}`.

## 5. Wake and batch

### 5.1 What counts as addressed

| Inbound, from an allowed peer | Default |
|---|---|
| In a pair thread (the bridge is the only recipient): general or a topic | Wake |
| A reply in a team topic or channel the assistant started | Wake |
| Team chat, a team topic or a channel, with `@anna-assistant` or `@<alias>` in the text | Wake |
| Any other team chat, team topic or channel message | Batch |
| In a thread past the loop pause (5.4) | Batch, and one notice to the owner |
| Past `wake.maxPerHour` | Batch, and one notice to the owner |
| Later, with `work` (#379 phase 4): an entry that assigns a thread to the assistant, or an `ask` | Wake |
| Later, with `work`: an entry that only changes status or summary | Batch, unless the assistant created that thread |

A pair message is addressed by construction: only the bridge receives it. This is why "a handoff"
and "a direct question" need no field: they come as a new topic or a message in a pair thread.

### 5.2 A wake in NanoClaw's terms

A wake is a `deliver` with `trigger: 1`: the module writes the row into the location's session and
wakes it, as the Telegram channel does for a poll result.

- **Coalescing.** Several messages for one location within `wake.gapSec` (60 seconds) cost one
  wake: the bridge holds the later ones and delivers them together.
- **A busy session** gets the row while it works. With the interactive Claude provider NanoClaw
  pushes rows that arrive mid-turn into the running turn, so no second wake happens.
- **Where the cost is.** A wake resumes the location's session with its whole conversation. The
  inbox topic is meant to stay short; a long-lived topic with months of conversation costs more per
  wake. That is one more reason unbound traffic lands in the inbox and only bound threads wake a
  topic.
- **Sessions compete.** The host assistant runs a few topic sessions at once, and a wake beyond that
  evicts one that has been quiet for 2 minutes. `wake.maxPerHour` (10) keeps the hub from crowding
  out the owner's own topics.

### 5.3 The batch

A batched message stays in the bridge, `batched`, and costs nothing until it is read.

- When a location has batched messages and no pending read, the bridge sends `schedule` for the
  next time in `batch.at` (09:00 and 18:00 by default). The module writes one row with
  `process_after` set to that time; NanoClaw's sweep wakes the session then, as for a scheduled task.
- The row says only: `[hub] messages wait in your hub inbox. Read them: hub_inbox`. Never a peer's
  words, as #379's digests and the board's Team notices do. It carries no counts: the row is written
  when the read is scheduled, and counts would be stale by the time it is due.
- `hub_inbox {thread?, full?}` returns the batched messages, newest last: the header and the first
  300 characters of each, 1,500 characters in all by default; `full: true` returns everything and is
  meant for a subagent. Reading marks them `read`.
- Nothing is lost when the window is passed: the batch is in the bridge, not in context rows, so
  the 10-row window of a prompt does not drop any of it.
- A wake for another reason does not deliver the batch by itself. The agent may call `hub_inbox`
  whenever it likes; the scheduled read is the floor, not the only way.

### 5.4 Loop and rate guards

Two assistants of the same owner (one on the server, sessions on the laptop) can answer each other
for a long time. Both ends guard it:

- **The board** pauses its agents after `loop` agent messages in a row in a thread (20 by default,
  set per peer in the Team panel) and holds the next one as a draft.
- **The bridge** counts the same run per thread: its own posts and peers' `via: agent` messages
  extend it, a person's message resets it. At `loop` (20) it stops waking the assistant for that
  thread (messages batch), refuses `hub_send` there with `not sent: loop pause, a person has to write
  in the thread`, and sends one `notice` to the inbox topic.
- **Outbound limits**, as the board's: 20 posts an hour per location, 60 an hour and 300 a day to
  one peer, and the same text in the same thread within 10 minutes refused.

### 5.5 Cost, counted

Arithmetic on assumed numbers, not a measurement; phase 1 measures the real ones.

Suppose a day brings the assistant 10 direct messages from anna's board and 40 team messages, and
each wake of a topic session rereads a context of 30,000 tokens.

| | A wake per message | With these rules |
|---|---|---|
| Wakes | 50 | about 10 for the direct messages (fewer when they coalesce), 2 scheduled reads |
| Context reread at wake | 50 × 30,000 = 1,500,000 tokens | 12 × 30,000 = 360,000 tokens |
| Team text in context | all 40 messages, whole | what `hub_inbox` returns when read: 2 × 1,500 characters by default |

The rereads are at the cached price only while the provider's cache is warm. Spread over a day, most
wakes find it cold, so the gap is larger than the token counts show.

## 6. How input reaches the assistants

### 6.1 The host assistant

- The module resolves the session for the location: the host assistant's chat with the topic's
  thread id, in per-thread mode, through the session manager's own lookup. A topic that has no
  session yet gets one, as a first Telegram message there would.
- It writes the row with `writeSessionMessage`: the hub message's id as the row id (a redelivery
  writes nothing new), `trigger` as the bridge says, the text with its header. Then it wakes the
  session for `trigger: 1`.
- The row bypasses `routeInbound` and its access gate, as the Telegram channel's own injections do.
  The bridge has already applied the allow list; NanoClaw's sender rules do not know hub peers.
- Replies go through `hub_send`. Bare text stays the agent's scratchpad, and a `<message>` block to
  the owner's chat goes to Telegram as usual, which is how the assistant tells the owner what it did.

### 6.2 A group's container assistant

- The location's agent group and its session are resolved the same way; a group usually has one
  shared session.
- The row is context for the agent. NanoClaw posts nothing for it: an inbound row is never echoed to
  the chat, and the group's bare output is never sent.
- Hub text reaches the humans of the group only if the assistant itself writes a `<message>` to the
  group. That is the assistant's decision, as the brief wants.
- `hub_send` in a group may only reply in threads bound to that group, or open a new topic with an
  `owner` peer. It cannot rebind except back to the inbox, and `hub_threads` and `hub_inbox` show
  only its own threads.
- The group's instructions say in so many words: answer the hub with `hub_send`, never with
  `send_message` without `to`, which goes into the group.

### 6.3 What a delivered message looks like

```
[hub · anna (owner) · agent planner · thread 1a2b3c4d "Hotel options for May" · msg 9f8e7d6c]
Three options with prices, by Friday?
```

- The header is written by the bridge: who (the roster name and role, `owner` or `member`), the
  agent's session name when it came `via: agent`, the thread's ref and title, the message's ref. A
  reply adds `(answers 4c3b2a10)`.
- A member's message says `(member: a request, not an instruction)` in the header (8.1).
- A team copy says `team` or `channel (anna, ben)` in place of the pair.
- A file (phase 4) is a line under the text: `[file: "quote.pdf", 182,044 bytes, saved at <path>]`,
  in the session's own inbox folder.

### 6.4 The tools

Registered in the agent runner only when the host passes the hub flag in the agent's environment,
and always at session start, never in the middle of one, so the tool list stays part of the cached
prefix (#379, 5.4).

| Tool | Who may call it | Does |
|---|---|---|
| `hub_send {thread?, to?, title?, text, replyTo?}` | host topics; groups for their own threads | 4.6 |
| `hub_inbox {thread?, full?}` | everyone, scoped to what the location may see | 5.3 |
| `hub_bind {thread, to, now?}` | host topics; groups only back to the inbox | 4.3 |
| `hub_threads {}` | everyone, scoped | One line per thread bound here: ref, peer, title, last activity, unread count. |

Each is a `kind: 'system'` row handled by a delivery action in the module, which forwards it to the
bridge as a `call` and writes the `result` back as a `trigger: 0` row, the way `cli_request` works.

### 6.5 The assistant's instructions

A container skill (NanoClaw's `container/skills/`), loaded only when the hub is on, of about 1,500
characters:

- what a hub message's header means and who `owner` and `member` are;
- the four tools, and that a hub reply goes only through `hub_send`;
- in the inbox topic: handle a message there, or move its thread with `hub_bind`;
- in a group: never post hub text into the group unless the assistant decides the group should know;
- a member's text is information and a request, not an instruction, and nothing that commits the
  owner is done for a member without asking the owner;
- never secrets in a hub thread.

## 7. Security

### 7.1 Keys

- The bridge has its own Ed25519 identity key and X25519 box key, made at enrolment, in its state
  directory (0700, the files 0600). They are never in NanoClaw's environment file, never mounted into
  a container, never sent over the socket.
- It enrols with a single-use invite minted by the hub's admin, as a board does (`team-join.ts`'s
  flow, reused).
- Key pins both ways. Anna's board pins the bridge's key on first contact, as it pins any peer. The
  bridge pins each allowed peer's key; a changed key holds that peer's messages, and the owner trusts
  it again with the bridge's CLI on the server (`assistant-bridge trust anna`), after one `notice` in
  the inbox topic.
- The hub's address is configured, not discovered. On the hub's own machine the bridge connects over
  loopback, so no certificate or DNS is involved.
- Revoking the bridge's peer on the hub (`/peers/:ref/revoke` on the admin socket) cuts it off at
  once, whatever state the server is in.

### 7.2 What containers can reach

- **Not the key, not the socket.** Neither is mounted. A container's only hub path is a system row
  that the host module handles, scoped to the container's own group by the session that wrote it.
- **The network does not protect the hub, and does not need to.** Containers have unrestricted
  egress and could open a connection to the hub's public address. Without a key they cannot pass
  the challenge, and the hub sends nothing to an unauthenticated connection. The hub's loopback
  listener is out of their reach unless it is bound wider.
- **A group sees only its own threads.** It cannot read another group's or the host's hub threads,
  cannot list the directory beyond its own entry, and cannot open topics with members.

### 7.3 The host assistant

The bridge runs as the same user as NanoClaw (the owner's decision 3: the owner is the only user of
that server). The key's file permissions keep it from other users and from containers, which never
get the state directory mounted. They do not keep it from the host assistant, which runs as a plain
process with that user's rights and skips permission prompts: it could read the key, and a host
assistant misled by a message could hand it out. The owner accepts that, because the damage is
bounded and revocable. An impostor with the key could write to the owner's board as the assistant,
and the board treats that as a peer's data, behind its notices, drafts and loop pause; revoking the
peer on the hub (7.1) ends it. A system user of its own for the bridge would close this gap and can
be added later without changing anything else in the design.

### 7.4 Gates

Inbound, before NanoClaw sees anything:

- the allow list, by pinned key (8.1);
- the wire checks of `checkMessage` in the board's strict mode, reused as they are;
- the loop pause and the wake cap (5.4).

Outbound, on every `hub_send`:

- only to allowed peers, and never to the team chat or a channel that includes anyone not on the
  allow list;
- the board's secret check (`secretHit` in `src/core/team-agents.ts`) refuses a text that looks like
  a key or token, for every peer, the owner's board included, since the hub holds text unencrypted
  while it is queued;
- the outbound limits of 5.4;
- a group only within its own threads (6.2).

A refusal is a `not sent: <why>` line to the agent. The bridge keeps no drafts: there is no panel
on the server for the owner to release one, and the owner's board holds its own drafts already.

### 7.5 What is kept and what is logged

- Message text is kept in the bridge's store for 7 days at most and 200 messages per thread, so
  that `hub_inbox` and bindings work; then it is deleted.
- The bridge's log carries metadata only: ids, peers, threads, sizes, states. Never text, never
  titles.
- What the assistant receives is in its sessions like any Telegram message it receives, under
  NanoClaw's rules for its own data.

## 8. Visibility

### 8.1 The setting

```json
"allow": [
  { "peer": "<anna's board's peer id>", "name": "anna", "role": "owner" },
  { "peer": "<ben's board's peer id>", "name": "ben", "role": "member" }
]
```

- **`owner`**: the owner's own board: the owner in the Team panel and the owner's sessions. Their
  requests are the owner's (the owner gave the assistant a free hand for them), and they see every
  published alias.
- **`member`**: a teammate. Their messages reach the assistant with the member note in the header
  (6.3); they may address the aliases marked `members: true`; the assistant may answer them and
  open topics with them only from the host (groups talk to `owner` peers only).
- **Default**: the owner's board alone, pinned at enrolment from the invite's setup step.
- Anyone else: dropped before NanoClaw, with one line back per peer per 30 days, "this assistant
  takes messages from anna's board only", written by the bridge as `agent: "bridge"`. `refuse:
  "silent"` drops without the line.

The allow list is edited in the bridge's config and takes effect on reload (`SIGHUP`), without a
reconnect.

### 8.2 What the hub cannot do

The hub shows every peer to every member and lets every member send to every peer. With the default
setting, ben and cleo see `anna-assistant` in their roster and get the one-line refusal if they
write. Hiding the peer from them would be a hub change: a per-peer roster filter, and a refusal at
`send` for senders the peer does not accept. The owner accepted the roster entry (decision 2), so
the design does not build it.

### 8.3 Team chat and channels

A team post reaches every member's board, the bridge included, so the bridge receives every team
chat and team topic message. With the default setting, team messages from anna's board are batched
for the inbox and the rest are dropped. The assistant never writes to the team chat or to a channel
unless every member of it is on the allow list, since a team post goes to everyone.

### 8.4 Lanes on the owner's board

The other side of visibility is what the owner's sessions may send the assistant. The board holds
a session's post to a peer as a draft unless the session's lane is shared with that peer
(`PeerAgents.lanes` in `src/adapters/team-store.ts`, a list of lane ids, read in `agentPost` and
`assign` in `src/services/team-router.ts`). The owner wants every lane open to the assistant,
lanes added later included (decision 7), so phase 1 adds one setting to a peer's switches:

- `allLanes: true` on a peer means every lane is shared with it, now and later. Absent, the stored
  list means exactly what it means today.
- The Team panel shows "All lanes" above the list of lanes for every peer. When the owner turns
  Agents on for a peer that advertises the `assistant` cap, "All lanes" is ticked by default and the
  owner can untick it and pick lanes. For every other peer nothing is ticked by default, as today.
- Turning it on widens what agents may say, so it goes through the owner's passkey confirmation
  when that is on (`src/core/team-confirm.ts`), as adding a lane does.
- The checks that read a peer's lanes (an agent's post, the `lane_name` check, `assign`) take
  `allLanes` as containing every lane, and go down their old code when it is absent.

## 9. Packaging and the switch

### 9.1 Where the code lives

In this repository, beside `hub/` and outside `herdr-plugin.toml`, because it runs on a server and
not under herdr:

```
assistant-bridge/
  README.md                     how to run it, the config, the socket protocol
  assistant-bridge.service      a systemd user unit sample, for the user NanoClaw runs as
  src/                          main.ts, cli.ts, bridge.ts (routing, wake, batch, tools), policy.ts (the pure
                                rules and lines), store.ts, hub-link.ts, module-socket.ts, protocol.ts,
                                config.ts, files.ts
  nanoclaw/                     the NanoClaw part, as a NanoClaw utility skill
    SKILL.md                    what to copy where, the env key, how to check it
    src/modules/hub/            the module: socket client, delivery actions, injection, notices
    container/agent-runner/src/mcp-tools/hub.ts
    container/skills/hub/SKILL.md
test/assistant-bridge/          the bridge's tests, in the board's suite, against the real hub (test/hub/harness.ts) and a fake module
```

- The bridge imports the board's pure wire code (`src/core/team.ts`, `team-wire.ts`,
  `team-agents.ts`), as the hub does; its `join` command reuses the board's join client
  (`src/services/team-join.ts`) and reach probe (`src/adapters/hub-reach.ts`), which need nothing
  but that code and Node. Nothing else of the board. Zero dependencies, Bun.
- The NanoClaw part is reviewed here and applied to the owner's NanoClaw checkout as a change there
  (decision 8). Its tests live in that checkout, beside NanoClaw's own. It targets the NanoClaw the
  owner runs (2.2), not upstream.

### 9.2 The config

`config.json` in the bridge's state directory:

```json
{
  "hub": "ws://127.0.0.1:<hub port>/v1",
  "name": "anna-assistant",
  "socket": "<state dir>/bridge.sock",
  "allow": [{ "peer": "<id>", "name": "anna", "role": "owner" }],
  "inbox": { "topic": "<thread id of the hub topic>", "notice": "title" },
  "publish": [
    { "alias": "hub", "at": "host:inbox", "about": "anna's assistant; new topics without a target land here" },
    { "alias": "travel", "at": "host:<thread id>", "about": "trip planning" },
    { "alias": "book-club", "at": "group:<agent group id>", "about": "the book club's group assistant", "members": false }
  ],
  "wake": { "gapSec": 60, "maxPerHour": 10 },
  "batch": { "at": ["09:00", "18:00"] },
  "loop": 20,
  "refuse": "once"
}
```

### 9.3 Switching it on

1. The hub's admin mints an invite.
2. On the server, as NanoClaw's user: install the user unit, write the config, run
   `assistant-bridge join <invite>` once, start the unit.
3. In the NanoClaw checkout: apply the skill (one import line for the module, one for the tool
   module, the container skill), set the bridge's socket path in NanoClaw's environment, restart
   NanoClaw.
4. The owner creates the inbox topic in Telegram and puts its thread id in the config.
5. On the owner's board: Team panel → `anna-assistant` → Agents on, with "All lanes" ticked by
   default (8.4).

### 9.4 Off is the old path

- Without the socket path in NanoClaw's environment, the module's factory returns null: no socket,
  no delivery actions, no hub flag passed to agents, so no tools and no container skill. NanoClaw's
  start, its tool list and its prompts are what they were.
- Without the bridge's unit, nothing runs on the server for this.
- On a board, a peer without `allLanes` and without the `assistant` cap goes down exactly the old
  code. A board that never talks to an assistant sees no change; one that does treats the bridge as
  a peer.

### 9.5 Everyone's setup

Per AGENTS.md, a change must leave every other setup as it was:

- **Board users without an assistant** (all of them but one, today): phase 1 adds `allLanes` (8.4).
  Its pull request compares old and new on a peer with a stored list, a peer with no entry, the
  team's switches and a channel, and shows the same drafts, sends and assigns as on `main`; the
  panel's default changes only for a peer with the `assistant` cap. Phase 2 changes only the
  `agent-board-team` skill's text; phase 5 adds an assignee form to #379's `board thread new`, gated
  on the peer's `assistant` cap.
- **The hub**: no change in any phase.
- **`src/core/team.ts` and `team-wire.ts`**: the bridge only imports them. If a phase needs an
  export they do not have, its pull request shows that the board's and the hub's tests are unchanged.
- **NanoClaw without the bridge**: 9.4, compared in the NanoClaw pull request (start, tool list,
  a group's prompt, with and without the env key).

## 10. Phases and the issues to open

Five issues in this repository, #386 to #390. Each phase's NanoClaw half is kept in `assistant-bridge/nanoclaw/`
and applied to the owner's NanoClaw checkout as a change there. Each phase is useful when it lands
and leaves every setup without the bridge as it was.

### Phase 1. Both directions: the board to the assistant and back

Issue: [#386](https://github.com/MokuTeam/herdr-agent-board/issues/386), "Assistant bridge 1: send from the board to a NanoClaw assistant and back". This is
what the owner wants first.

- Scope, the bridge: `assistant-bridge/` with enrolment, the connection loop (ping, dead timer,
  backoff, resend, ack on every delivery: the board's shape), the store, the allow list with pins
  and refusals, rules 1, 2, 4 and 5 of 4.2, the wake rules of 5.1 for pair and team traffic, the
  batch with the scheduled read, loop and rate guards, the socket, the CLI (`join`, `trust`,
  `status`), the unit sample, the README.
- Scope, the way back: `hub_send` from any host topic. With `to` and `title` it opens a topic with
  the owner's board, bound to the topic it was sent from, so the board's answers come back there
  (rule 2). Without `thread` it answers the thread that brought the newest message (4.6).
  `hub_inbox` reads what waits.
- Scope, NanoClaw half: the module (the host assistant's topics as locations, the session lookup
  per topic, injection with `trigger`, the scheduled read, the title notices in the inbox topic),
  the `hub_send` and `hub_inbox` tools, the container skill.
- Scope, the board: `allLanes` (8.4).
- Done when: in the suite, against the real hub, the bridge enrols, takes a pair message from a
  board and hands it to a fake module with `trigger: 1` for the inbox; a `hub_send` from another
  topic opens a topic on the board and the board's reply is handed to that same topic; a team
  message is batched and its read scheduled; a peer not on the list is dropped with one refusal; a
  module restart loses nothing. On the server, after the owner's go: a session on the owner's board
  and the inbox topic talk both ways, and a topic in Telegram sends to the board and gets the answer
  back. Without the env key NanoClaw is as before (9.4); a peer without `allLanes` is as on `main`.
- Measures: real sizes of the header, the digest row and `hub_inbox` output, and the wakes of a
  real week, put into 5.5 in place of the assumptions.

### Phase 2. Moving threads, title targets and the directory

Issue: [#387](https://github.com/MokuTeam/herdr-agent-board/issues/387), "Assistant bridge 2: move hub threads between topics, name a target, publish a
directory". Depends on 1.

- Scope: `hub_bind` and `hub_threads`; rule 3 of 4.2; `publish` and the directory topic; the notice
  row on a move. Here: a paragraph in the `agent-board-team` skill on assistant peers.
- Done when: the worked example of 4.8 runs end to end; a title cannot move a bound thread; a move
  reaches the new topic as one row.

### Phase 3. Group assistants

Issue: [#388](https://github.com/MokuTeam/herdr-agent-board/issues/388), "Assistant bridge 3: group assistants, silently". Depends on 2.

- Scope: `group:` locations; the scoping of 6.2 and 7.2 in the module; the group's instructions.
- Done when: a hub message bound to a group reaches the group's agent and nothing reaches the
  group's chat (checked on the channel's outbound side); a group's `hub_send` outside its threads
  and its `hub_bind` to anything but the inbox are refused; a group's `hub_inbox` shows only its
  threads.

### Phase 4. Files

Issue: [#389](https://github.com/MokuTeam/herdr-agent-board/issues/389), "Assistant bridge 4: files both ways". Depends on 1.

- Scope: the box key, blobs in and out (the board's #371 code paths reused), an inbound file saved
  in the session's inbox folder, `hub_send {file}` from a path in the session's folder, the `files`
  cap, the hub's size limits.

### Phase 5. Shared threads

Issue: [#390](https://github.com/MokuTeam/herdr-agent-board/issues/390), "Assistant bridge 5: shared threads (#379 phase 4)". Depends on 2 and on #379
phase 4.

- Scope: the `work` cap and body field read and written by the bridge; an assignee naming an alias
  as a target (4.4); `hub_send {status, summary}` as a `work` entry, with the fallback line for
  peers without the cap; the wake rules for `work` (5.1). Here: `board thread new --to
  <peer>/<alias>` for a peer with the `assistant` cap, in the same PR or as an item of #379 phase 4.
- Then: the title convention of 4.4 is documented as legacy.

Order: 1, then 2, then 3. 4 can run beside 2 or 3. 5 waits for #379.

## 11. Not in this design

- **Mirroring Telegram.** People's messages in Telegram never go to the hub (3.4).
- **Hiding the peer from the roster.** It would be a hub change; the owner accepted the roster entry
  (8.2).
- **Upstream NanoClaw.** The NanoClaw half targets the owner's NanoClaw (2.2). Porting it to a later
  NanoClaw is that version's own change.
- **Several assistants per server.** One bridge serves one NanoClaw install. A second install
  (another bot) gets a second bridge with its own key and name.
- **Drafts on the server.** The bridge refuses what it will not send; the owner's board keeps its
  drafts (7.4).
- **Creating Telegram topics from the hub.** NanoClaw has no call for it; a new topic is the
  owner's, made by hand. A later Bot API call could add it.
- **Other assistant frameworks.** The bridge's socket protocol is small and frame-based, so another
  framework could implement the module's side, but this design builds only NanoClaw's.
