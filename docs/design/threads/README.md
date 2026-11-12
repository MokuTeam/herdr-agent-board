# Threads: one store for tasks and reports

Design for [#379](https://github.com/MokuTeam/herdr-agent-board/issues/379). Phases 1 to 4 (the
store, `board thread` and events, #391; the board's view, #392; what MokuPilot needs, #393; shared
threads over the hub, #394) are built; phases 5 and 6 are not yet. The document is written so that an
agent who was not part of the discussion can build each phase from it. Mockups are in [mockups/](mockups/): open `mockups/index.html` in a browser. The page
has switches for the app (board, MokuPilot), the width (desktop, phone) and the theme, and
`index.html?theme=dark&width=phone#mokupilot` opens it in a given state.

Names in the examples are made up: the owner's board, a teammate called ben, a project lane called
`atlas`.

## Contents

1. [The problem and the answer in short](#1-the-problem-and-the-answer-in-short)
2. [What is there today and what each piece becomes](#2-what-is-there-today-and-what-each-piece-becomes)
3. [Concepts and data model](#3-concepts-and-data-model)
4. [Storage and sync](#4-storage-and-sync)
5. [The agents' surface: CLI, HTTP, MCP](#5-the-agents-surface-cli-http-mcp)
6. [Events](#6-events)
7. [Token economy](#7-token-economy)
8. [Links](#8-links)
9. [MokuPilot's view](#9-mokupilots-view)
10. [The board's card and thread view](#10-the-boards-card-and-thread-view)
11. [Sharing over the hub and permissions](#11-sharing-over-the-hub-and-permissions)
12. [Chats](#12-chats)
13. [Migration](#13-migration)
14. [The switch](#14-the-switch)
15. [Phases and the issues to open](#15-phases-and-the-issues-to-open)
16. [Open questions for the owner](#16-open-questions-for-the-owner)

## 1. The problem and the answer in short

A long-lived orchestrator (a day orchestrator beside a meeting, a master that runs for days)
receives every worker's full report as text in its own conversation. Its context grows past 500k
tokens, and after a meeting nobody can tell what happened where. The same task is also written
down in places that do not know about each other: the board's to-do points, MokuPilot's task board,
and free-text status replies in Team threads.

The answer is one object, the thread, kept by the board:

- A thread is a task with a memory. It has a short key (`atlas-12`), a title, a one-line summary
  of where it stands, a status, an assignee and a feed of entries. An entry has an author, a time,
  text, links and files, and may change the status.
- Workers write to the thread. `board thread post atlas-12 --status done --summary "217 rows
  mapped, 3 flagged in the report" --file report.md` replaces the report they would have sent to
  their master.
- The master gets one line: `atlas-12 done: 217 rows mapped, 3 flagged in the report`. It reads more
  only when it asks, and it sends a fork or a subagent to read a long feed and bring back a few
  lines.
- MokuPilot shows the same threads in a tab and writes to the same store through the board. Its
  own task file is no longer a second list.
- A thread can be shared with teammates' boards over the hub. A shared thread is a Team topic that
  carries a status, so both sides' agents write status into one place.

Decisions this document takes, each argued where it comes up:

| Question | Decision |
|---|---|
| An item is a thread, or links to one? | An item is a thread. A thread without entries costs one row and reads as a plain item. (3.1) |
| Where do threads live? | In the board's SQLite file, with the journal the board already keeps. (4.1) |
| How does a master hear about a change? | A one-line digest typed by the board's scheduler, the path Team notices already use. No polling, no hook on every prompt. (6) |
| CLI or MCP? | The CLI first: it costs a session nothing until it is used. MCP only where a session cannot run a command, as two small tools. (5) |
| How is a thread shared? | As a Team topic with the same id. The status travels in a new signed body field behind a new capability, so the hub needs no change. (11) |
| What about the to-do points? | They stay as they are until threads have proved themselves, then become threads behind the same `board todo` commands. (13.2) |
| What about task offers and statuses planned for Team (#212, #213)? | They become shared threads: an offer is a shared thread assigned to a peer's board, a status is an entry. (11.6) |

## 2. What is there today and what each piece becomes

Read from the code at `main` 11205a9e and from MokuPilot's repository.

| Piece | What it is today | In this design |
|---|---|---|
| To-do points (#202, #319) | `card.todos[]` on one session's card file. Key `<lane>-<session>-<n>`, derived when shown, so it moves when the session is renamed. Open, proposed or done. No feed, no files. Gone from view when the session is archived. | Unchanged in phases 1 to 4. Phase 5 stores them as threads; `board todo` keeps working. |
| Cards | One per session. `board doing / ask / wait / done` and five columns: working, needs the user, waiting, done, idle. | Unchanged. A card shows the threads its session works on, and a thread's statuses use the same five colours. |
| `board ask` | Sets `card.ask`; cleared by the owner's next prompt. | Unchanged. `board thread ask` sets it too and records the question in the thread. |
| Reminders and the scheduler | One file per entry; the scheduler in the board's process types `[board reminder ...]` into a session, queues into a working one, waits out dialogs, routes a MokuPilot day session to its inbox file. Team notices are one-off entries with `by: 'team'`. | Thread events are one-off entries with `by: 'threads'`. One new flag, so that an event does not wake a sleeping session. |
| Team threads (#216, #355, #370, #371, #373) | A topic is a `ThreadRef {id, title, link, group, members}` inside signed messages. The hub is a relay with a queue: no thread table, no history, no order. Statuses are a convention in the skill: replies that start `done:`, `blocked on:`, `next:`. | A shared thread is a topic with the same id. The convention becomes a field. Notices, drafts held for the owner, the loop pause, E2E files and the listener are reused as they are. |
| Session sheet | Head, conversation, composer. | Gains one fold in its head: the session's threads. |
| MokuPilot's task board | One JSON file per agent session, replaced whole by the `board` tool on every change. Items: `id`, `text`, `status` (doing, next, done), `owner`, `owner_id`, `parent_id`, `note` (120 characters, overwritten). The owner chip is painted and has no click target. | Each item is a thread. The file is imported once and MokuPilot reads and writes threads through the board. |
| MokuPilot issues #271 and #273 | One board per session instead of per day; a reset guard that exists in one of two writers. | Both stop mattering: threads are not keyed by session and have one writer. |
| Auto-compact per card (#378) | In progress. | Referenced only. After a compaction a session gets its state back with `board thread list --mine`. |

Three words already mean something else in the code, and the new code avoids them:
`web/src/components/sheet/Thread.tsx` is a session's conversation, `TeamThread.tsx` is a Team
thread, and "owner" in MokuPilot's item means the session an item was handed to. New modules are
named `work-thread` in code and "thread" on screen, and the session a thread is handed to is its
assignee. "The owner" always means the person who owns the board.

## 3. Concepts and data model

### 3.1 An item is a thread

The brief asks to decide between one entity (an item is a thread) and two (an item links to a
thread). One entity is the right choice for four reasons:

1. Two entities need a rule for when an item gets its thread, and a sync between the item's status
   and the thread's. That sync is the problem this issue starts from.
2. A thread with no entries is a single row: key, title, status. It lists and costs like an item,
   so nothing is lost by making every item one.
3. The feed is where a status change is recorded anyway. An item that changed from doing to done
   has a history whether or not it is shown.
4. One key names the thing everywhere: in MokuPilot, on the card, in chat and on a teammate's
   board.

### 3.2 A thread

| Field | Type | Notes |
|---|---|---|
| `id` | UUID v4 | The same id space as a Team topic. When a thread is shared, this id is the topic's id. |
| `key` | `<lane>-<n>` | Minted once from the lane id at creation and a per-lane counter. Stored, never derived, never changed, also when the thread moves to another lane. This is what people and agents say. |
| `lane` | lane id | The board's category. Decides who a thread may be shared with (11.2). |
| `title` | one line, 80 characters at most | Team's title limit, so a shared thread needs no cutting. |
| `summary` | one line, 160 characters at most | Where the thread stands now. Each change replaces it; the old lines stay in the feed. |
| `status` | `next`, `doing`, `waiting`, `owner`, `done`, `dropped` | See 3.4. |
| `waitingOn` | one line, 160 characters at most | What `waiting` or `owner` waits for. |
| `proposed` | `{by, at, why}` or none | An agent said done on a thread that waits on the owner; the owner confirms or keeps it open. The to-do points' rule, kept. |
| `assignee` | party or none | Who holds it now. |
| `parent` | thread id or none | One level only (3.6). |
| `scope` | `local`, a peer, `team`, or a channel's members | Where its entries go (11). |
| `createdBy`, `createdAt`, `updatedAt`, `doneAt` | | |
| `rev` | integer | The highest entry counter applied (4.3). |
| `origin` | optional | Where an imported thread came from: a to-do point, a MokuPilot item. Makes imports repeatable. |

A party is one of:

- `{kind: 'owner'}`: the person at this board.
- `{kind: 'session', key, name}`: a session on this board, by its card key (a Claude session id or
  `pane-<id>`), with the name it had when it wrote.
- `{kind: 'peer', peer, name, agent?}`: a teammate's board by its hub id and roster name, with the
  session name when one of their agents wrote.

The board sets the party from the path a write came in on, never from what the write says. A write
through the `board` command is the session's, a write through the page is the owner's, a write from
the hub is the peer's. This is the rule #220 asked for.

Participants are not stored. They are the assignee, everyone who wrote an entry, and everyone who
watches (6.2).

### 3.3 An entry

| Field | Type | Notes |
|---|---|---|
| `id` | UUID v4 | On a shared thread, the id of the Team message that carries it. |
| `thread` | thread id | |
| `n` | integer | A counter per thread: one more than the highest this board has seen (4.3). |
| `at` | time | |
| `author` | party | |
| `type` | `note`, `ask`, `answer`, `system` | `ask` is a question for the owner. `answer` replies to one. `system` is written by the board: created, imported, shared. |
| `text` | 4000 characters at most | Team's limit. May be empty when the entry only changes fields. A longer report goes as a file. |
| `set` | optional object | The fields this entry changes: `status`, `summary`, `title`, `waitingOn`, `assignee`, `parent`, `lane`. |
| `links` | up to 5 of `{url, title?}` | http or https, a thread key, or a local path on a local thread. |
| `files` | up to 5 of `{name, size, ref}` | Copied into the board's state folder, so a deleted worktree does not take the report with it. 5 MB each on a local thread; Team's 25 MB when shared. |
| `replyTo` | entry id | As in Team (#370). |
| `private` | flag | Stays on this board, also when the thread is shared. |

Entries are never edited or removed. A correction is a new entry. The head of a thread (title,
summary, status, assignee and the rest) is what you get by applying every entry's `set` in order.
The store keeps the head in the thread's row so that a list never reads a feed.

### 3.4 Statuses

| Status | Means | Card column it matches | Colour |
|---|---|---|---|
| `next` | Not started. | idle | gray |
| `doing` | Someone is on it. | working | green |
| `waiting` | Waits on something outside: a client, CI, a date. `waitingOn` says what. | waiting on someone else | purple |
| `owner` | Waits on the owner: an answer, a decision, a step that is theirs. | needs the user | orange |
| `done` | Finished. | done | blue |
| `dropped` | Will not be done. Hidden with the done ones. | | gray |

The five visible statuses are the card's five columns, with the same colours from
`COLUMN_COLORS` in `web/src/models/toolbar.ts`. A person who reads the board already reads these.
MokuPilot's fourth section, "Handed off", is not a status: it is `doing` with an assignee that is
not the session looking at the list.

### 3.5 Who may change what

- Any session may create a thread, write entries on a thread it can see, and set `doing`,
  `waiting`, `owner` and `next`.
- Any session may set `done`. If the thread is in `owner` at that moment, the change is stored as
  `proposed` and the thread stays under "needs you" with the agent's reason, until the owner
  confirms or keeps it open.
- Only the owner shares a thread, unshares it, or drops one that is shared (11.2).
- Agents can be switched off as writers altogether, as with to-do points (14).

### 3.6 Sub-threads

A thread may name one parent, and a parent may not have a parent. This is MokuPilot's rule today
(one level, 20 children at most) and it keeps every list flat enough to read. A parent shows a
count of its children, "3 of 5 done". The board does not derive the parent's status from its
children; when the last child closes, it writes a `system` entry on the parent and its watchers
get an event.

### 3.7 A worked example

```
$ board thread new --lane atlas "Import mapping for the order feed"
ok · atlas-12 · next

$ board thread new --parent atlas-12 --to atlas-mapper "Map the 2019 price columns"
ok · atlas-13 · doing · atlas-mapper

# in the session atlas-mapper, an hour later
$ board thread post atlas-13 --status done \
    --summary "217 rows mapped, 3 flagged in the report" --file out/mapping-report.md
ok · atlas-13 · done · 1 file

# typed into the master by the board, once, when it is next free
[board reminder from threads] atlas-13 done: 217 rows mapped, 3 flagged in the report. More: board thread changes
```

The report file is 2,000 tokens long. It went from the worker to the board. The master's context
grew by the last line.

## 4. Storage and sync

### 4.1 On this board

Threads go into `board.db`, the SQLite file that already holds time entries and calendar events
(`src/adapters/db.ts`, `db-schema.ts`). The to-do points' way, a list on one session's card file,
cannot hold a thread: a thread outlives its sessions and belongs to several. Team's JSON files keep
the last 500 messages per peer and are not a history either.

One new migration (version 5, appended to `MIGRATIONS`) adds:

| Table | Columns | Purpose |
|---|---|---|
| `threads` | the fields of 3.2, JSON for parties, scope and origin; `key` unique | One row per thread: the head. |
| `thread_entries` | the fields of 3.3 (`set` in a column named `fields`); `seq`, the journal row it was written with; `closed` on the board's entry for a parent whose last sub-thread closed; index on `(thread, n)` and on `seq`; `out` for a shared entry's state: `queued`, `sent`, `held`, `refused` | The feed. |
| `thread_seq` | `lane`, `n` | The per-lane counter for keys. |
| `thread_watch` | `session`, `target`, `what`, `idle`, `wake`, `since` (the threads revision when it began), and the session's `name` for its schedule entry | Subscriptions (6.2). |
| `thread_cursor` | `session`, `seq`, `at`, `asked` | What a session has been told and has read (6.3). |

Every entry also writes a row in the existing `journal` table, as time and calendar do (store
`threads`, op `new` or `post`, the head before and after). Watches and cursors are bookkeeping of who
was told what and write no journal row, as a time entry's billing mark is no change of the entry.
The journal's seq of the last entry is the threads revision, `threadsRev`. It rides in the
board's payload when threads are on, and a page that shows threads fetches its own routes when it
moves. This is the pattern `time` and `calendar` follow in `src/core/payload.ts`; the feed never
rides in the payload.

Files of entries live in `thread-files/<thread id>/` in the state folder and are served the way
uploads are.

The layering follows the repository's:

- `src/core/work-threads.ts`: the types, the limits, `applyEntry` (fold an entry into a head),
  the digest text, the key rule. Pure.
- `src/adapters/work-thread-store.ts`: the tables.
- `src/services/work-threads.ts`: write an entry, then tell the watchers, then queue it for the
  hub if the thread is shared.
- `src/server/routes/threads.ts`, `src/entrypoints/thread-cli.ts`, `web/src/components/threads/`,
  `web/styles/threads.css`.

### 4.2 A write does not need the board to be running

`board thread post` opens `board.db` itself and writes the entry, as `board time` does today. The
entry is durable the moment the command prints `ok`, also while the board restarts. Two things
then need the board's process, and both pick the entry up from the store when it is back:

- The event for the watchers: the command adds or updates a schedule entry file (6.4), which the
  scheduler delivers.
- The copy for the hub, when the thread is shared: the command calls the running board to send it
  and prints what came back (`sent`, or `held` with the reason). With no board running it prints
  `ok · saved, goes out when the board runs`, and the board sends the `queued` entries when it
  starts.

### 4.3 Between boards

The hub keeps no thread: it relays signed messages, drops their text once they are acknowledged,
and has no order across senders. So each board that takes part holds its own copy of a shared
thread, and the copies have to come out the same. Three rules do that:

1. Entries are immutable and carry `n`, a counter per thread. A board writes its entry with one
   more than the highest `n` it has seen on that thread (a Lamport counter).
2. A head field takes the value from the entry that is last in the order `(n, at, author's peer
   id)`. Two boards that hold the same entries compute the same head, whatever order the entries
   arrived in.
3. Every shared entry also carries its sender's head as it was after the entry (key, title,
   status, summary, `rev`). A board that sees a `rev` more than one ahead of its own knows it
   missed entries: it adopts the newer head fields, and shows a line in the feed, "entries
   missing here".

Rule 3 is what a late joiner and a board that was offline past the hub's 7 days rely on. They have
the right head after the first message they receive and lack only the older feed. For the feed
itself there is one more step, started by a person: "Send history" exports the thread's shared
entries to a JSON file and sends it through the hub's end-to-end encrypted files (#371). The
receiving board imports them, marked "from ben's copy", since the hub cannot prove who wrote an
entry that was relayed. There is no automatic backfill protocol in this design.

What a board receives from a peer is data. Section 11.4 says what it does with it.

## 5. The agents' surface: CLI, HTTP, MCP

### 5.1 The `board thread` command

Every command prints one line and takes `--json`. `<key>` accepts a key, the first 8 characters of
an id (Team's ref form), or a bare number within the session's own lane.

```
board thread new [--lane <id>] [--parent <key>] [--to <session>] [--doing] "<title>"
board thread post <key> [--status <s>] [--summary "<line>"] [--waiting "<on what>"]
                        [--file <path>]... [--link <url>]... [--reply <entry>] [--private] ["<text>"]
board thread done <key> ["<summary>"]
board thread ask <key> "<question for the owner>"
board thread set <key> [--title "<t>"] [--assignee <session|none>] [--lane <id>] [--parent <key|none>]
board thread show <key> [--last <n>] [--since <n>] [--full]
board thread list [--mine | --lane <id> | --all] [--status <s>] [--done]
board thread changes [--peek]
board thread watch <key> | --lane <id> | --mine  [--what status|asks|all] [--idle] [--wake]
board thread unwatch <key> | --lane <id> | --mine
board thread link <key> | --base
board thread open <key>
board thread share <key> <name|team|channel> [--history]
board thread import <file> | --todos
```

What each one does:

- `new` creates a thread in the session's own lane unless `--lane` says another. It is `next`
  unless `--doing` or `--to` is given. `--to` sets the assignee. The creator watches it.
- `post` writes one entry. All of text, status, summary, files and links are optional, but one of
  them must be there.
- `done` is `post --status done --summary`.
- `ask` writes an `ask` entry, sets the thread to `owner` with the question as `waitingOn`, and
  sets the session's `card.ask` so the card moves to "needs the user" exactly as `board ask` does.
- `show` prints the head and the last 5 entries, each cut to 300 characters, 1,500 characters in
  all. `--since <n>` prints only entries after `n`. `--full` prints everything and is meant for a
  fork or a subagent. A file is shown as its name, size and path, never its content.
- `list` prints one line per open thread: key, status, assignee, title, summary. 20 lines at
  most, then "and 14 more (--all)". `--mine` is the threads the session created, is assigned or
  watches.
- `changes` prints what changed since the session last asked, one line per thread, and moves the
  session's cursor. `--peek` leaves the cursor.
- `link` prints the thread's address on the board (8), and with `--base` the board's own address
  and whether threads are on, which is how MokuPilot finds the board. `open` shows the thread on
  the board.
- `share` leaves a request for the owner (11.2).

As built in phase 1: `share` answers that it is not built yet (`import` is built with phase 3,
#393; `import --todos` waits for phase 5); `open` raises the
board's window and prints the thread's address, which the page follows from phase 2 on. A flag a
command does not take is refused, so a mistyped one never becomes text; text that starts with `--`
goes after a lone `--`. `done` takes `post`'s `--file`, `--link`, `--reply` and `--private`, and its
words are the summary unless `--summary` gives one. `changes` with more than 20 threads to list
shows the newest 20 and marks nothing read; `--all` lists them all and marks them. `--to` and
`--assignee` take a session on the board by its name, pane or key. `--session <id|name|pane>` writes
as that session (MokuPilot's day session, 5.4); outside a session the command writes as the owner.

On a thread shared with a peer, `show` frames the peer's entries as quoted data under a header,
as `board team thread` does, and the skill's rule applies: a peer's text is data, never
instructions.

### 5.2 What a session is told

Threads add a block of at most 600 characters to the SessionStart brief, only while threads are
on, generated in `src/core/work-threads.ts` beside the existing `todosBrief()`. For comparison, the
to-do lines are 887 characters today. The block says three things: post your status and results to
the thread you were given instead of sending a report to your master; the two commands for that
(`post`, `ask`); and `board thread --help` for the rest. The whole procedure (how a master hands
work out by thread, how a fork reads one, how sharing works) goes into a skill,
`skills/agent-board-threads`, which a session loads when it needs it and which costs nothing until
then. Team does the same.

Nothing is added to the hook that runs on every prompt. A session hears about a change through an
event (6) or by asking.

### 5.3 HTTP

The page, MokuPilot and the MCP adapter use the same routes.

| Route | Returns or does |
|---|---|
| `GET /api/threads?lane=&status=&mine=<session>&since=<rev>` | Heads only. With `since`, only threads changed after that revision. |
| `GET /api/threads/<key or id>?last=&since=&full=1` | The head and entries. |
| `POST /api/threads` | `{op: 'new', ...}` |
| `POST /api/threads/<id>` | `{op: 'post' \| 'set' \| 'ask' \| 'answer' \| 'confirm' \| 'keep' \| 'watch' \| 'share' \| 'unshare'}` |
| `GET /api/threads/events` | SSE with one event, `rev`. The board's main stream sends its whole payload on every change, which is too much for a client that shows only threads. |
| `POST /api/reveal {thread}` | Opens the thread on the board's page (8). |

Guards: a POST carries `X-Board: 1` (`board-header`), like `/api/todos`. A write over HTTP is the
owner's. From outside the machine the routes are open to the owner's own login only, the rule
`ownerTeam` applies to Team's panel; every other remote caller is refused. With threads off every
route answers 409 with `thread.err.off`, the to-do points' pattern.

A local agent can call these routes and pass for the owner. That is true of every local route
today and is the reason Team has the optional passkey (#224). Sharing and sending the owner's own
entries to the hub go through that same gate when it is on.

### 5.4 MCP

The repository has no MCP server today, and the CLI is the better default: a tool's schema sits in
the prompt of every session that has it, used or not, while a CLI costs nothing until it is called.
An MCP surface is still needed where a session cannot run a command, and MokuPilot's day session
is that case: it already gets its tools from MokuPilot's loopback MCP server.

The surface is two tools, so that the schema stays small:

- `threads` (read): `{op: 'list' | 'show' | 'changes', key?, mine?, lane?, last?, since?}`
- `thread` (write): `{op: 'new' | 'post' | 'ask' | 'set' | 'watch', key?, title?, text?, status?,
  summary?, to?, parent?, files?}`

Both return the same single lines the CLI prints. MokuPilot's MCP server exposes them in place of
its whole-board `board` tool when threads are on, and passes them to the `board` command with
`--session <day session>`, so that the entries are the day session's and not the owner's. For
other harnesses the board gets `board mcp`, a stdio server with the same two tools (phase 4).

A tool list is part of a session's cached prefix. The two tools are registered when a session
starts and never added in the middle of one.

## 6. Events

### 6.1 What an event is

An event is a change to a thread that some other session should know about: a status change, a
question for the owner answered, a new entry, the last sub-thread closing. The session that made
the change never gets an event for it.

### 6.2 Who watches

A row in `thread_watch` says which session wants to hear about which threads:

- `target`: one thread, a lane, or `mine`.
- `what`: `status` (status changes and answers, the default), `asks` (also questions raised for the
  owner), `all` (also plain entries).
- `idle`: deliver only when the session is free. Without it an event is queued into a working
  session's turn, as a reminder is.
- `wake`: wake a sleeping session for it. Off by default.
- A watch hears only what is written after it began (`since`), also when the session watched other
  threads before. When several watches of a session match one line, one with `idle` or `wake` has
  its way: waiting only delays the line, and waking is what that watch asked for.

Two watches are set without asking: the session that creates a thread watches its status, and a
thread's assignee watches for answers to its questions. A master that hands out ten threads
therefore hears when each one closes and needs to do nothing for it.

### 6.3 A cursor, so nothing is told twice and nothing is lost

Each watching session has a cursor. An event is not a stored message. When a change concerns a
session, the board computes its digest from the cursor to now: every watched thread that changed in
between, one clause each, never the session's own changes. Ten changes while the session was busy
are one line, and a session that was asleep for a day gets one line when it wakes.

The cursor holds two marks. `seq` is the last change an event was queued for: the next event starts
after it, so nothing is told twice. `asked` is the last change `board thread changes` showed:
`changes` prints everything after it, so the "More: board thread changes" at the end of a line shows
the detail of what that line said. `changes` moves both marks and takes back a pending event, which
would say nothing new; `--peek` moves neither. A session's first watch starts both at the threads
revision, so what came before is not news to it.

### 6.4 Delivery

Delivery is the path Team notices use, `noticeSchedule` in `src/services/team-router.ts`:

1. The write adds a one-off schedule entry for each watching session: `by: 'threads'`,
   `from: {key: 'threads', name: 'threads'}`, due now. If the session already has a pending one,
   its text is replaced with the new digest and no second entry is added. It is replaced by removing
   the pending entry and adding the new one, never by changing its text in place: the scheduler reads
   an entry before it claims it, and a text changed in between would be lost as the old one went
   out. A removed entry's claim fails and the scheduler sends the new one; one the scheduler has
   claimed already goes as it is, and the new entry follows it.
2. The scheduler types it as `[board reminder from threads] ...`. Everything it already does
   applies: it queues into a working session, waits out a dialog or the owner's unsent text, and
   follows a session to its new pane.
3. A MokuPilot day session has no pane to type into. `send()` already routes it to the day's inbox
   file, and MokuPilot types the line in as `[report] threads: ...`. No new code on either side.
4. A gap of 60 seconds per session (`threads.events.gapSec`) keeps a burst from turning into a
   turn per change. The first event after a quiet spell is due at once; the next one is due no
   sooner than the gap after it, and everything that changes meanwhile joins it. A watch with
   `--idle` waits for the end of the turn instead, so a busy turn's changes are one line however
   long the turn is.

One thing is new in the scheduler: a schedule entry may carry `noWake`. For such an entry a
sleeping session is not woken; the entry waits, without the 240-minute limit, and goes out when
the session is next awake. Waking means a full resume of the session, which costs more than any
status line is worth. A watch with `--wake` leaves the flag off. Only entries that carry the flag
take the new branch, so every existing reminder goes down the code it went down before. The branch
sits before the scheduler takes the session's turn, so a waiting event never holds back another
entry of the same session: a reminder that wakes it goes as it would, and the event follows once
the session is awake.

### 6.5 The line

```
[board reminder from threads] atlas-13 done: 217 rows mapped, 3 flagged in the report · atlas-14 needs the owner: which price list wins · atlas-9 +2. More: board thread changes
```

- At most three threads are spelled out, then "and 4 more". Status changes come first, in the
  order they happened, then questions, then threads with only new entries.
- A parent whose only news is that its last sub-thread closed gets no clause of its own when every
  one of its sub-threads is spelled out closed in the same line: one handed-out child that finished
  (3.7) is one clause, not two. `board thread changes` still shows the parent.
- A clause is the key, the new status and the summary. With `what: all` and no status change it is
  the key and the count of new entries.
- The summary is included only when the entry's author is a session on this board or the owner.
  For an entry that came from a peer's board the clause is the key and the status, both of which
  the board validates, and never the peer's words. This is Team's rule for notices: a peer's text
  is never typed into a session.
- The line is 400 characters at most.

### 6.6 When the owner answers

A thread in `owner` shows under "needs you" on the board and in MokuPilot. The owner answers in the
thread view. The board writes an `answer` entry, puts the status back to what it was before the
question, clears `card.ask` on the asking session, and types the answer into that session as
`[board thread atlas-14] <the owner's words>`. That text is the owner's own instruction, so it is
typed in full, through the same `send()` the sheet's composer uses. If the owner answers in the
session's terminal instead, `card.ask` clears as it does today, and the agent records the answer
with `board thread post`.

## 7. Token economy

The lines in this section were measured on the phase 1 build (#391), with the worked example of 3.7
and a lane of 25 threads; the day in 7.2 is still arithmetic on its stated assumptions. A token is
counted as four characters.

| Line | Measured |
|---|---|
| The brief's block (5.2) | 470 characters, against 886 for the to-do points' lines |
| The worked example's event, with its `[board reminder from threads]` tag | 113 characters |
| An event that bundles 24 changed threads (three spelled out, "and 21 more") | 264 characters |
| A write's answer, `ok · atlas-13 · done · 1 file` | 29 characters |
| `show` of the worked example's thread: head, link and its last five entries, one with a file path | 892 characters |
| One `list` line (key, status, title, summary) | 117 characters |
| `list` at its limit: 20 lines and "and 4 more (--all)" | 2,374 characters |

### 7.1 What enters a master's context

| | Today | With threads |
|---|---|---|
| A worker finishes | Its report, in full: 2,000 tokens for a report of 8,000 characters. | One line of 113 characters: 28 tokens. |
| The master wants the detail | It is already in context, wanted or not. | A fork or subagent runs `board thread show --full` and returns 100 to 200 tokens. |
| The master looks at the list | MokuPilot's `board` tool sends the whole board and gets the whole board back. | `board thread list --mine`: one line per open thread, about 30 tokens each. |
| A status changes | The whole board again. | `ok · atlas-13 · done · 1 file`: 7 tokens. |

### 7.2 A day, counted

Assume a day orchestrator with 10 workers that send 40 reports of 2,000 tokens, of which the owner
asks about 8 in detail.

| | Today | With threads |
|---|---|---|
| Report text added to the master's context | 40 × 2,000 = 80,000 | 40 × 28 = 1,120 |
| Detail the owner asked for | 0 (already there) | 8 × 150 = 1,200 |
| Total added | 80,000 | 2,320 |

That is the growth. The larger cost is rereading. Every turn a session takes reads its whole
context again, at the cached price while the cache is warm (a tenth of the input price at
Anthropic's published rates) and at more than the full price when it has expired. Suppose the 40
reports arrive evenly over a day of 100 turns. On average half of them are in context, so the
report text alone is reread as 100 × 40,000 = 4,000,000 cached tokens, the price of 400,000
uncached ones. With threads the same sum is 100 × 1,160 = 116,000 cached tokens, the price of
11,600. Lines that arrive together while the master is busy are one line, so the real figure is
lower still.

MokuPilot's task tool adds to today's side. Its contract is whole-board: the model sends every
item and gets every item back with ids. A board of 40 items at 100 characters each is 1,000
tokens each way, and 60 changes in a day are 120,000 tokens. With threads a change is one short
command and one short line.

### 7.3 Why the cache stays intact

- Events are appended. A digest arrives as a new prompt at the end of the conversation, as a
  reminder does. Nothing earlier is rewritten or removed.
- No hook context changes per prompt. The to-do points add a line to a prompt when they change;
  threads add nothing there.
- The brief is fixed when a session starts. Turning threads on reaches new sessions; a running
  session's earlier text does not change.
- Tools do not change in the middle of a session (5.4).
- The feed is never in the context to begin with, so there is nothing to cut. This is the owner's
  constraint: an agent's history is never cut or rewritten. Compaction (#378) stays the only thing
  that shortens a conversation, and it has less to shorten.

### 7.4 Forks get cheaper too

A fork inherits its parent's context and reads it at the cached price on every turn it takes. A
fork of a 500,000-token master pays for 50,000 uncached tokens per turn before it has done
anything. A fork of a 40,000-token master pays for 4,000. Keeping reports out of the master is
what makes "send a fork to read the thread" cheap enough to be the normal move.

### 7.5 Limits that hold the numbers

| Output | Limit | Measured (7) |
|---|---|---|
| Event line | 400 characters, three threads spelled out | 113 for one thread, 264 for 24 |
| `show` by default | 1,500 characters: the head and 5 entries of 300 | 892 |
| `list` by default | 20 lines | 117 a line, 2,374 at the limit |
| `changes` | one line per thread, 20 lines | about 120 a line |
| Any write | one line back | 29 |
| Brief block | 600 characters | 470 |

## 8. Links

Everything that names a thread, a card or a session opens it.

| Target | Link | Exists today |
|---|---|---|
| A session's card and sheet | `http://127.0.0.1:<port>/#session=<card key>`; `POST /api/reveal {key}` for a page that is already open | Yes (`web/src/models/reveal.ts`). This is the link to a specific card that was asked for. |
| A thread | `http://127.0.0.1:<port>/#thread=<key>`; `POST /api/reveal {thread}` sends the SSE event `thread-open {key}` | New, modelled on `team-open`. |
| An entry | `#thread=<key>&entry=<n>` | New. |
| A Team thread | the `team-open` event | Yes. |
| A file | `herdr-reveal:`, `file:` and plain paths | Yes (`src/adapters/files.ts`). |

- `board thread link <key>` prints the address, and `show` prints it in the head. An agent that
  mentions a thread to the owner writes it as a markdown link to that address, so it opens from
  any terminal and from MokuPilot's chat. No custom URL scheme has to be registered on any system.
- `board thread open <key>` raises the board's window on the thread, through the existing
  `web-open.ts`, which gains `--thread` beside the `--pane` that opens a card today.
- On the page and in MokuPilot, a thread key in any text (an entry, a card's doing line, a chat
  bubble) is turned into a link when it matches a known key. An assignee chip opens the session's
  sheet; its menu has "Go to the terminal" (the board's existing jump to a pane). A peer's chip
  opens the peer in the Team panel.
- A session that is gone (archived, or another board's) still has a chip. It opens the archive
  entry when there is one and is plain text otherwise.

## 9. MokuPilot's view

MokuPilot is a PyQt6 desktop app. Its day view is a chat on the left and an inspector on the right
with a segmented control, "Board" and "Transcript". The mockup is `mockups/index.html#mokupilot`.
It is drawn in MokuPilot's own palette and row anatomy (`ui_theme.py`, `agent_board_view.py`),
because this view is painted in MokuPilot's window and not on the board's page.

### 9.1 Where it sits

When the board answers and threads are on, the first segment reads "Threads" and shows the
threads view; otherwise MokuPilot shows its own board as today. MokuPilot finds the board through
the `board` command it already locates for call reports (`call_report.find_board()`):
`board thread link --base --json` prints the board's address and whether threads are on.

### 9.2 The list

Sections, in this order: Needs you, Now, Handed off, Waiting, Next, Done. "Needs you" and
"Waiting" are new; the other four are the sections MokuPilot has. Next folds after 5 rows and Done
after 3, as today.

A row keeps today's anatomy (a status glyph, the title, a time on the right) and adds:

- the key, in the mono face, before the title;
- the summary as a second line, where today's note is;
- the assignee chip, now a button: a click opens that session's sheet on the board, and the dot
  on it is the session's column colour, read from the board instead of pi-web;
- a count of new entries since the owner last opened the thread;
- for a parent, the count of its children, "1 of 3";
- for a sub-thread, "in atlas-12".

A sub-thread is listed in the section of its own status, not under its parent, so that a child
which needs the owner is under "Needs you" where it will be seen. The parent's own view lists its
children together.

The list shows the day's threads by default: those created or changed today, and every open one
the day session watches. A filter widens it to a lane or to everything open. This is what
MokuPilot #271 asked for (one board for a day) without keying anything by session.

### 9.3 The drill-down

A click on a row opens the thread in the same panel: the list slides out to the left and the
thread comes in from the right, with a back chevron that returns to the list at the scroll
position it had. A thread opened from a link in chat arrives the same way.

The thread view has, from the top:

- the head: key, title, status (a menu), assignee chip, summary, the parent as a crumb, the shared
  mark with the teammates' names when it is shared, and "Open on the board";
- the sub-threads, as rows;
- the feed: status changes as quiet single lines, notes as text with the author's chip and a
  time, files as chips that open the file, links as links, a question for the owner as a
  highlighted block with an answer box;
- a composer: a note from the owner, with a status picker.

The existing context menu stays (Discuss, Done, Move to doing, Move to next, Remove becomes Drop),
and "Discuss" keeps its meaning: the thread goes into the composer of the day chat as a chip, and
the next message carries `[selected] thread atlas-12`.

### 9.4 Reading and writing

- Read: `GET /api/threads` and `GET /api/threads/<key>`, refetched when `GET /api/threads/events`
  sends a new `rev`.
- The owner's clicks: `POST /api/threads/<id>` (they are the owner's writes).
- The day session's own writes: the `thread` and `threads` MCP tools, passed to the `board`
  command with `--session` (5.4).
- With the board not running, the tab says so and offers to start it. MokuPilot keeps no copy.

### 9.5 The day's prompt

MokuPilot's day briefing (`defaults/prompts/day.yaml`) changes in two places when threads are on:
the task-board block describes the two tools instead of the whole-board one, and the delegation
block tells the orchestrator to create a thread for each piece of work it hands out, to put the
key in the brief ("work in thread atlas-13, post your result there, send me nothing else"), and to
answer the owner from `threads` rather than from memory.

## 10. The board's card and thread view

The mockup is `mockups/index.html#board`.

### 10.1 The card

A card shows the threads its session is assigned, as chips under the doing line: a status dot and
the key. Two chips at most, then "+3". A chip opens the thread. A card whose session has no thread
looks exactly as it does today, and with threads off no card changes.

### 10.2 The toolbar

One pill, "Threads", beside "Tasks", with the count of threads that need the owner. It opens the
threads panel. The count is in the payload (`threads: {rev, needsOwner}`); the list is not.

### 10.3 The panel

A side panel in the board's glass sheet, built like the Team panel: two columns when it is wide
(`@container sheet (min-width: 720px)`), one when it is narrow.

- Left, the list: a lane filter and a search field, then the sections Needs you, Doing, Waiting,
  Next, Done (folded). A row is the key, the title, the summary, the assignee chip and the time of
  the last change. A sub-thread is listed by its own status and names its parent (9.2).
- Right, the thread: the same parts as in 9.3. The head has the status menu, the assignee, the
  lane, "Share" and the link. A proposed close shows "ben's agent says this is done: <why>" with
  Confirm and Keep open.
- The components for an entry's text, files, reply quote and composer are Team's
  (`TeamMessage`, `TeamFile`, the composer with attachments and paste), not copies of them.

For a shared thread the Team panel and the threads panel show the same feed: in Team it is the
topic with a status pill on its row, and "Open as a thread" jumps across.

### 10.4 The session sheet

The sheet's head gets one fold, "Threads", listing the session's threads as rows with their
status. A row opens the thread.

### 10.5 The phone

One column. The list is a screen, a thread is a screen pushed over it from the right, and it
leaves the same way. The composer stays at the bottom above the keyboard. Touch targets are 44
points. The panel is the board's full-height sheet, inset 12px, as every panel is on the phone.

### 10.6 Styles and motion

- A new sheet, `web/styles/threads.css`. Six sheets are pinned to upstream by
  `test/web/styles.test.ts` and are not touched; where a rule must spare the session sheet it uses
  `:where(.sheet:not(#sheet))`.
- Colours and type come from the board's tokens. The Terminal look
  (`:root[data-look="terminal"]`) gets its rules in the same pull request as the Classic ones.
- Motion uses the springs the panels have (`web/src/models/spring.ts`): the push between list and
  thread at damping 1, response 0.34, interruptible and reversible mid-flight, following the
  finger on the phone. A status change moves a row between sections with the card re-flow spring.
  With reduced motion both become a cross-fade.
- The mockups show layout, hierarchy and states. They do not prove the motion; the build does that
  with the real springs.

## 11. Sharing over the hub and permissions

### 11.1 A shared thread is a Team topic

Sharing a thread with ben starts a Team topic with ben whose `ThreadRef.id` is the thread's id and
whose title is the thread's title. Sharing with the team or a channel starts a team topic
(`group: true`, with `members` for a channel). From then on:

- An entry that is not `private` is a Team message in that topic. Its id is the entry's id.
- The fields a plain message lacks travel in one new signed body field, `work`:

```json
"work": {
  "n": 14,
  "type": "note",
  "set": { "status": "done", "summary": "217 rows mapped, 3 flagged in the report" },
  "head": { "key": "atlas-13", "title": "Map the 2019 price columns", "status": "done",
            "summary": "217 rows mapped, 3 flagged in the report", "rev": 14 },
  "auto": false
}
```

- The hub forwards body fields it does not know, as signed, so the hub needs no change and no new
  message kind. Boards reject unknown body fields, so `work` goes only to peers that advertise a
  new capability, `work`, in their `hello`.
- A peer without the capability gets the same message without the field. A message must have
  text, so an entry that only changes fields is sent with a line the board writes, `done: 217 rows
  mapped, 3 flagged in the report`, and `work.auto` tells a board that understands the field not to show
  that line twice. This is the convention the Team skill teaches today (`done:`, `blocked on:`,
  `next:`), so a teammate on an older board reads a shared thread as an ordinary topic with status
  replies and loses nothing they have now.

Because a shared thread is a topic, the Team panel shows it from the first day, before the board
has any thread view of its own.

### 11.2 Who shares, and what is sent

- Only the owner shares. `board thread share` from an agent leaves a request the owner confirms on
  the board, with the passkey when that gate is on. Unsharing and dropping a shared thread are the
  owner's too.
- A thread can be shared with a peer only if its lane is shared with that peer (the per-peer
  `lanes` switch that Team has). With the team or a channel, every member must have it. Otherwise
  the request is refused with the reason.
- At the moment of sharing the peers get the head. The entries written before stay local unless
  the owner ticks "with history", which sends them as a file (4.3). This is the safe default: a
  feed that was private when written does not become shared by one click.
- After that, entries go out as they are written, except `private` ones.

### 11.3 What holds an agent's entry back

An agent's entry on a shared thread is an agent's Team post, and goes through `agentPost` in
`src/services/team-router.ts` unchanged: held as a draft for the owner when agents are off for
that peer, when the lane is not shared, when the text looks like a secret or names an unshared
lane, when the loop pause is reached, and always when it carries a file; refused past the rate
limits (20 an hour per session, 60 an hour per peer, 300 a day). A held entry is in the feed
locally at once, marked "waits for you to send", and the command prints `held` with the reason.

These limits were set for conversation. Status entries are fewer than chat lines, so the pilot
starts with them as they are. If files held every time prove too slow for reports between two
people who work together daily, a per-peer switch "agents may send files in shared threads" is the
change to make, and it is the owner's to decide (16).

### 11.4 What a board does with a peer's entry

- It accepts `work` only on a thread it knows as shared with that peer, from a member of the
  thread's scope. Anything else is dropped as a bad frame, like any unknown field today.
- It validates every field against the limits of 3.2 and 3.3 and stores the entry with the peer
  as its author.
- A peer may write entries and change the status and the summary. A peer may not assign one of
  this board's sessions: an `assignee` set from outside can name the peer's own agent, the peer's
  board, this board (which is an offer, 11.6) or nobody.
- A peer's text never goes into a session. Watchers get the key and the validated status (6.5).
  An agent reads the entry itself with `board thread show`, framed as quoted data.
- Thread text is not end-to-end encrypted, exactly as Team's text is not: the hub holds it while
  it is queued. Files are encrypted end to end.

### 11.5 Keys across boards

The key travels with the thread, in `work.head.key`, so `atlas-13` is `atlas-13` for everyone it
is shared with. A board mints a number one above the highest it has seen for that lane, from its
own threads and from shared ones, which keeps two boards apart in ordinary use. When two boards
still mint the same key at the same time, each shows the other's thread with the peer's name
after it (`atlas-13@ben`), and commands that are given the bare key say it is ambiguous and list
both with their 8-character refs. No board renumbers a thread, because a key that changed would be
wrong in every conversation that already holds it.

### 11.6 Offers and statuses (#212, #213, #220)

The plan for Team had two more stages: task offers with accept and decline (#212) and statuses on
accepted tasks (#213), with #220 naming the risk of an agent leaking through a status. Shared
threads cover the same ground:

- An offer is a shared thread whose assignee is the peer's board. The peer's owner sees it under
  "needs you" with Take and Decline, and only a person presses those. Taking sets the assignee to
  that board, and from there to whichever session the owner or the listener gives it.
- A status is an entry. `board team status` is `board thread post`.
- The outbound risk is handled by the gates of 11.3, which were built after #220 was written.

The recommendation is to close #212 and #213 in favour of the hub phase here, once the owner has
agreed to this design.

### 11.7 As built in phase 4 (#394)

- The wire: `work` is said in `hello` after the other caps only while `threads` (with `share`) and
  `team` are on; off, the hello, the payload and the inbound event are what they were. `readWork`
  (`core/team.ts`) holds the field to its keys and limits, and only in a topic. A message with
  `work` on a board that does not keep shared threads, or one that does not fit a thread it shares
  with the sender, is dropped and acked, as a bad frame is.
- The rules are in `core/work-share.ts` (the order, the fold, what goes on the wire, what a peer may
  set, the board's line for a peer without `work`), the database side in `services/work-share.ts`,
  the side that holds the Team service in `services/work-hub.ts`.
- A shared entry starts `queued`. `board thread` asks the running board to send it and prints
  `sent`, `held for the owner: <reason>`, `waits for the owner's passkey on the board`, or `saved,
  goes out when the board runs`; the board sends what waits once it is online. A session's entry
  goes through `agentPost` (a held one is a Team draft that carries the entry, and its state follows
  the draft: `sent` when the owner sends it, `discarded` when the owner drops it); the owner's goes
  behind the passkey when that gate is on (`thread-send`, which unlocks sending as a Send does).
- `board thread share` is a request on the thread from any caller of the command: only the page
  shares (`thread-share`, gated). The owner's own entry written by the command outside a session
  waits as `held` for the owner's Send on the page, since any program can run the command as the
  owner; an agent's entry is checked by `agentPost` with its `work` fields (summary, what it waits
  on, title) as well as its text. Sharing writes one system entry that carries the head; its text
  for a board without `work` is `shared as a thread: atlas-13 · doing: <summary>`. "Send history"
  (`thread-history`) sends the shared entries as a JSON file through the end-to-end encrypted files;
  the receiving board reads it in once the file is there, each entry it lacks marked as a copy, never
  one the file says it wrote itself. Unsharing sends `stopped sharing` and keeps the feed.
- The entry that adopts a sender's head (rule 3) is a private system entry in the sender's name,
  ordered right after the sender's entry. A local session's close that only proposed (3.5) goes out
  without its status and summary, so no copy closes what the owner has not confirmed.
- An assignee from a peer that names this board is an offer (`scope.offer`), counted under "needs
  you" until the owner's Take or Decline; one that names a session of this board is refused (the
  rest of the entry is kept). Any other peer, or nobody, is taken.
- A bare key that names a local thread and a peer's `key@name` is refused as ambiguous by the
  command; the page asks by the exact key.
- One file per entry on a shared thread; only the owner drops a shared thread.
- What one peer can make this board hold is bounded: 500 threads it started (closed ones count),
  2,000 of its entries in one thread, a counter that moves by 100,000 at most per entry. A peer's
  thread sits in the lane its key names only when that lane is one of this board's and shared with
  the peer, else in `shared`; a peer's key far above this board's own numbers in a lane does not
  move them. A peer's system entry keeps no words (only this board's own lines do), its time is held
  to a day ahead, and a history file's entries are held to the same checks as the wire's (`readWork`),
  never offer anything, and are folded once.
- A topic's message that is a shared thread's entry tells the thread's watchers only; the Team
  router's notice for the topic is not sent as well. A message held because its sender's key
  changed is not taken into the thread.
- `board mcp` is a stdio MCP server with the two tools of 5.4.

## 12. Chats

How threads relate to the hub's chats and to chats outside it. Three options, cheapest first:

| Option | What it is | Cost | Recommendation |
|---|---|---|---|
| A. A thread is a topic | A shared thread is already a topic in the team chat, a channel or a pair's chat (11.1). People answer in the Team panel; their replies are entries. A status change shows in the chat as its one line. | None beyond the hub phase. | Build. It is the hub phase. |
| B. A digest going out | Status changes of chosen lanes are posted to one outside chat (a Telegram topic, a Slack channel) as one line each. One way: nothing comes back. Built as a small notifier beside the board's existing toasts, reading the journal. | One adapter per chat system, each optional. | Later, when someone asks for a specific chat. |
| C. A two-way bridge | An outside chat's thread and a board thread mirror each other. | A second identity model, a second place for text to leak, and a new way for outside text to reach agents. | Do not build. |

One more link costs nothing: a message in any Team chat can be turned into a thread ("Make this a
thread"), which starts a thread whose first entry quotes the message and whose topic is where the
message was.

A shared project memory came up with the same wish. A shared thread's feed is that memory for
status: what was decided, by whom and when, readable by both people's agents. Tools that index
project knowledge can read it through `board thread show --json`. This design adds no memory store
of its own.

## 13. Migration

### 13.1 MokuPilot's task board

- `board thread import <file>` reads a file in the "agent-board" format, version 1
  (`~/.agent-boards/<harness>/<session>.json`). For each item it creates a thread:

| Item field | Thread field |
|---|---|
| `text` | `title` (cut at 80; the full text becomes the first entry when it was longer) |
| `note` | `summary` |
| `status` doing, next, done | the same |
| `owner`, `owner_id` | `assignee`: the session on the board whose key is `owner_id` when there is one, else the name alone |
| `parent_id` | `parent` |
| `created_at`, `started_at`, `done_at`, `updated_at` | kept; `started_at` and `done_at` become status entries at those times |
| `id` | kept in `origin: {agentBoard: {harness, session, id}}` |

- The import can be repeated: an item whose origin is already there is updated, not added again.
- MokuPilot runs the import for the current day's files the first time it finds threads on, and
  then stops writing its own file.
- pi days are different: there the task tool belongs to the separate pi-task-board package and
  writes the file itself. Until that package can write threads, the board keeps reading its file
  (as it already does for call agents) and mirrors it one way into threads marked "mirrored", which
  cannot be edited on the board. This keeps one list on screen without changing a tool the board
  does not own.

- The other viewers of those files keep working for as long as the files are written, which for
  Claude days ends with the import. If one of them is still needed, MokuPilot can write a snapshot
  in the old format from the threads list (16).

As built in phase 3 (#393):

- An item's owner that is no session on the board is kept by its name, with its `owner_id` (or the
  name) as the key.
- A thread keeps what the import last read of its item, in `origin.agentBoard.seen` (text, note,
  status, owner, parent, `updated_at`). An import run again applies only the fields that changed in
  the file since then, in one `system` entry at the item's time for its new status (`done_at`,
  `started_at`) or its `updated_at`. A status, summary, title or assignee set on the board stays
  until the file changes that field, and an item that did not change writes nothing. `owner` and
  `waiting` count as the file's `doing`. A system entry's text (the whole text of a cut title, why a
  thread was dropped) shows in `show`.
- The mirror reads the running pi day (`state.json` with `provider: "pi"`, its `fork_session`, `cwd`
  and `name`), `~/.agent-boards/pi/<fork_session>.json`, before each of the board's refreshes, and
  imports it again when its time or size changed (a file over 1 MB, or one it cannot read, is tried
  again once it changes). Its threads go into the lane of the day's folder (`day` when no lane has
  that folder), written as the pi session; an open one whose item left the file is dropped. With
  `"threads": { "agents": false }` there is no mirror, since pi's tool is an agent writing.
- Any write on a mirrored thread, or a new sub-thread under one, is refused with `mirrored`, except
  the owner's close (status `done` or `dropped`), so that no copy is stuck open. A plain `import`
  leaves a mirrored thread alone. When the copied day is over (no pi day runs, or another one does),
  its threads lose the mark and become the board's own.
- With threads on, a board looks once a minute whether MokuPilot has run on the computer, as its
  call agents' gate does; without MokuPilot nothing more is read.
- `--session <id>` of the running day session looks its card up on the board, so a day session with
  no pane writes in the lane of its own folder. Any other session is found as before.

### 13.2 The to-do points

Phases 1 to 4 leave the to-do points alone. They work, people use them, and their switch is
separate. Phase 5 makes them threads:

- A point is a thread with a title and no feed. A point for the owner is in `owner`; a promise of
  the agent's (`--mine`) is in `next`, or `waiting` when it has a `--why`. `--ref` becomes a link.
- `board todo add / done / list` stay and write threads. The proposed close is the rule of 3.5.
- Open points are imported once, with `origin: {todo: {card, id}}`. A point's old key stays valid
  as an alias.
- The Tasks panel becomes the threads panel filtered to "needs you" and "mine".
- With threads off, to-do points stay on the cards exactly as today.

Until phase 5 the two lists are separate on the board, and MokuPilot shows threads only. The
mismatch between the board's list and MokuPilot's that was reported goes away in phase 3, when
MokuPilot stops keeping its own list. The remaining overlap, a point and a thread about the same
thing, goes away in phase 5.

### 13.3 Team's status replies

Nothing to migrate. Existing topics stay topics. The owner can turn one into a thread ("Track as a
thread" in its head), which gives it a key and a head; the earlier messages stay where they are.
The skill's section "Work between boards" is rewritten to use `board thread` where the peer has
the `work` capability and keeps the reply convention for peers that do not.

## 14. The switch

Threads are off unless `config.json` says otherwise, following the pattern of `todos`, `team` and
`time`:

```json
"threads": true
```

or

```json
"threads": { "agents": true, "events": { "gapSec": 60 }, "share": true }
```

- `threadsConfig(raw)` in `src/core/work-threads.ts` returns null when the key is absent or false.
- `agents: false` leaves threads to the owner: sessions cannot write, and get no brief block.
- `share: false` keeps threads local also when Team is on. Sharing needs `team` as well.

With threads off:

- `board thread ...` prints `threads are off` and exits with an error.
- `/api/threads*` answer 409.
- The payload has no `threads` field, the page shows no pill, no panel, no chips.
- The brief has no thread block and no hook reads anything for threads.
- The tables exist, empty, and are never read. The scheduler takes no new branch.
- The board does not advertise `work` to the hub, so no peer sends the field.
- MokuPilot shows its own task board.

Turning threads off later keeps the stored threads; turning them on again shows them. Settings
gets a row for the switch beside the to-do points', written through `editConfig`. Built in #410:
Off, Only me, Me and agents, and with Team on, shared or kept on this board; on copies the skill
into the shown profiles as the install does, off leaves it there.

## 15. Phases and the issues to open

Five issues are open in this repository (#391 to #395) and three in MokuPilot's (#274 to #276
there); the sixth is opened when someone asks for it. Each phase is useful when it lands and
leaves every setup that has threads off exactly as it was. Per AGENTS.md, every pull request says
which setups it is for, shows the comparison with `main` for the ones it must not touch, and
carries tests that fail on `main`.

### Phase 1. The store, the command and events

Issue: #391, "Threads 1: the store, `board thread` and events".

- Scope: migration 5; `work-threads.ts`, the store, the service; every `board thread` command
  except `share` and `import`; the brief block; the skill `agent-board-threads`; watches, the
  cursor, the digest, delivery through the scheduler with `noWake`; the day session through its
  inbox; the `threads` config key; `--json` everywhere.
- Not in it: any page, the hub, MokuPilot.
- Done when: the worked example of 3.7 runs end to end against the fake herdr; a sleeping watcher
  is not woken; ten changes during a busy turn arrive as one line; with the key absent the brief,
  the payload, the hook's output and the scheduler's runs are byte for byte what `main` gives
  (compared in the pull request for a Claude session id, a `pane-<id>` key, a name with spaces and
  a non-Latin name).
- Measures: the real character counts of the brief block, an event line, `show` and `list`, put
  into this document's section 7 in place of the estimates.

### Phase 2. The board's view

Issue: #392, "Threads 2: the panel, card chips and links". Depends on 1.

- Scope: the routes of 5.3 and the SSE `rev`; `threads.css`; the toolbar pill; the panel (list and
  thread, both looks, phone); card chips; the sheet's fold; `#thread=`, `thread-open`,
  `web-open.ts --thread`, `board thread open`; keys as links in text; the owner's answer (6.6) and
  the proposed close.
- Done when: every board screen of the mockups (`mockups/index.html#board`) exists in the light and
  dark Classic look and the Terminal look, at desktop and phone width; a card without threads renders as on `main`.

### Phase 3. MokuPilot

Issues in MokuPilot's repository: MokuTeam/MokuPilot#274, "Threads tab reads the board's threads";
MokuTeam/MokuPilot#275, "Thread tools for the day session in place of the whole-board tool";
MokuTeam/MokuPilot#276, "Import the day's task files into threads". One here: #393, "Threads 3:
what MokuPilot needs from the board" (`board thread link --base`, `import`, the one-way mirror for
pi days). Depends on 1; can run beside 2.

- Done when: a day runs with no task file written; every owner chip opens its session; MokuPilot
  #271 and #273 can be closed as no longer needed; with the board absent or threads off MokuPilot
  behaves as today.

### Phase 4. The hub

Issue: #394, "Threads 4: shared threads over the hub". Depends on 1; the Team panel shows shared
threads without phase 2. #390 (the assistant bridge) builds on this phase.

- Scope: the `work` capability and body field in `team-wire.ts` and `team.ts`; share, unshare and
  the owner's confirmation; outbound through `agentPost`; inbound validation and the merge rules
  of 4.3; `head` and the missing-entries line; keys across boards; the fallback line for peers
  without the capability; "Send history"; the status pill in the Team list; offers (11.6); the
  rewritten skill section; `board mcp`.
- No hub release is needed. The pull request shows that a board without `work` and a board with
  it exchange a shared thread's entries as plain topic replies, in both directions.
- Pilot: the existing shared project topic between the owner and a teammate becomes the first
  shared thread.
- Then: close #212 and #213 with a pointer here.

### Phase 5. To-do points as threads

Issue: #395, "Threads 5: to-do points become threads". Depends on 2. As in 13.2.

### Phase 6. A digest to an outside chat

Issue: "Threads 6: status digest to an outside chat". Not opened yet: it is opened when someone
asks for a specific chat (12, option B).

Order: 1 first. Then 2, 3 and 4 by different agents at once, since they touch different files (the
page, MokuPilot, Team's wire). 5 after 2. Phase 1 with phase 3 is what takes the reports out of the
day orchestrator's context, so if only two things can be built soon, those are the two.

## 16. Open questions for the owner

1. **One entity, all the way.** The design makes MokuPilot's items, shared Team tasks and, in
   phase 5, the to-do points all threads, and proposes closing #212 and #213. Is phase 5 wanted,
   or should the to-do points stay a separate, simpler list for good?
2. **Events never wake a sleeping session unless asked.** A master that sleeps hears about ten
   finished threads when it next wakes, in one line. The alternative is to wake it for `done` and
   `owner`. Recommendation: no wake by default, `--wake` per watch.
3. **Sharing is the owner's act, and the earlier feed stays local.** Agents can only ask for a
   share. Is that the right default, also between two people who share a project lane already?
4. **Files in shared threads.** An agent's file is always held for the owner today. Keep it for
   the pilot, or add the per-peer switch at once (11.3)?
5. **Thread text on the hub is not end-to-end encrypted**, as Team's text is not. Start the pilot
   that way, or wait for text encryption first?
6. **Keys.** `<lane>-<n>` with `@name` only on a clash (11.5), against Team's 8-character refs
   everywhere. Recommendation: the lane key.
7. **The build order after phase 1**: the board's view, MokuPilot and the hub in parallel, as
   proposed, or one of them first?
8. **Old viewers of MokuPilot's task files.** Does anything still need those files once threads
   are on (13.1)? If so MokuPilot writes a read-only snapshot in the old format.
9. **The name.** "Thread" already means a session's conversation and a Team thread in the code.
   On screen this design says "Threads". If the pill should read differently ("Work", "Tasks"),
   this is the moment.
