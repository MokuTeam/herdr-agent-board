# Nodes for the board: a plan ready to implement

Design for [#496](https://github.com/MokuTeam/herdr-agent-board/issues/496). It answers a spec for nodes written for the owner on 2026-11-20 ("the spec" below), checked against `main` at `ee32fc89`. It is written so that an agent who was not part of the discussion can build each task from it. Names in the examples are made up.

The owner's answers of 2026-11-21 to the six choices of 4.6 are folded in: sessions first; the master on the laptop with the roles kept symmetric; the board's existing profiles; lanes that may leave as a setting; a start by hand runs on the laptop when all is full; and a way for machines behind NAT without a VPN. Sections 20 (through the owner's server, and its cost next to Tailscale) and 21 (last man standing) are new.

## Contents

1. What the code really has
2. Where the spec is wrong or simplifies
3. Overlaps with issues and pull requests
4. The spec's open questions: closed, and left to the owner
5. Architecture
6. The node link, version 1
7. config.json and the state files
8. Placement by device order
9. Profile sync
10. Access and secrets on a node
11. Install, update, revoke
12. What the owner sees
13. Modules and files
14. Stage 1 as tasks with tests
15. The browser node is not cheaper first
16. Acceptance criteria for stage 1
17. How the change stays out of every other setup
18. What was not verified
19. Issues to open
20. Machines behind NAT without a VPN
21. Last man standing: any device can become the master (a later stage)

## 1. What the code really has

Read from the code by six read-only passes (remote, tunnel, hub, secrets and launch, board state, runtime) and spot-checked by hand where the plan leans on a seam. Line numbers are `main` at `ee32fc89`.

| Brick the spec names | What it is in the code | Where |
|---|---|---|
| Remote API for phones | No separate API. Four listeners share one route table: the local board, the Tailscale listener, the `tailscale serve` listener, the tunnel listener. A remote caller gets the web board's own routes minus a denylist (`desktopOnly`, `localOnly`). | `src/server/app.ts:307, 781-947`, `src/server/remote.ts:194-285`, `src/server/streams.ts:24-40`, `src/core/remote.ts:65-72, 110-113` |
| Roles, "orchestrator rights" | None. A device has `kind` (`app` or `browser`) and `desk`. `localOnly` refuses `/api/(remote, access, wake, backup, team, process, threads, ...)` for every remote caller. | `src/core/remote.ts:97, 110-113, 145, 169-181` |
| Pairing | As the spec says: 10 minute request, token once, SHA-256 hash kept, revoke cuts live streams. Also: pending requests live in memory only, the token works only from the Tailscale node it was given to, and approval is a local call. | `src/services/remote.ts:62, 91-162`, `src/core/remote.ts:212, 217-219` |
| A machine as a client | Works today only on the Tailscale listener: `Authorization: Bearer`, `X-Board: 1`, no `Origin`. The caller is identified by `tailscale whois`; no login name means 403. The domain path is for browsers only (cookie, exact Origin, password with TOTP or a passkey). | `src/server/remote.ts:199-259`, `src/adapters/tailscale.ts:120-134`, `src/server/tunnel.ts:163-166, 236-252` |
| `/api/hello` | Returns `api: 1` and the package version. Nothing in the repository compares `api`. | `src/server/remote.ts:57-71`, `src/core/remote.ts:7` |
| Reverse SSH tunnel | The board's computer dials the server: `ssh -R <unix socket>:127.0.0.1:<port>`. The server is a public front for the laptop's board. One tunnel per board. | `src/core/tunnel.ts:13, 198-219`, `README.md:3386-3408, 3886` |
| "Set up the server" | Changes sshd, a tunnel user that can run nothing, and a web server. The only software it installs is Docker and two pinned images. No bun, herdr, Claude Code or unit of the board's. Supported: Debian 12 and 13, Ubuntu 22.04 to 26.04. | `src/core/server-plan.ts:1327-1457`, `src/core/server-texts.ts:12, 304-321`, `src/core/server-look.ts:27-30`, `README.md:3391` |
| Its plumbing | Reusable: the admin ssh line, the sudo probe, a script sent as base64, the askpass listener that answers one password prompt from memory, host key pinning, the detached run with its log, per-step undo and a record. The backup drop already reuses it with its own scripts. | `src/core/server-admin.ts:49-159`, `src/adapters/ssh.ts:255-325, 356`, `src/core/server-script.ts:119, 345`, `src/services/backup-server.ts:26, 80-139` |
| The hub | A WebSocket relay of signed envelopes with a SQLite queue. One message kind (`question`), payload at most 16 KiB, frames at most 64 KiB, text readable by the hub. No request and response, no stream, no backpressure. Members are a flat roster with no type, role or owner. A board has one hub and cannot mint invites. | `hub/src/server.ts:8-41`, `hub/src/hub.ts:241-296, 599-618`, `hub/src/db.ts:69-153`, `src/core/team-wire.ts:8, 164, 266-288`, `hub/src/admin.ts:1-15` |
| Hub inbound | Isolated from herdr, launches, terminals and processes on purpose; a test fails if any frame reaches them. | `src/services/team-hub.ts:1-7, 789-825`, `test/services/team-inbound-isolation.test.ts:1-40` |
| Sealed files | Per-file AES-256-GCM key wrapped per recipient; 25 MB a file by default. They work, for people's boards. | `src/core/team-box.ts:159-177`, `src/core/team-wire.ts:153-162` |
| Secrets and sinks | Four sink kinds: `file` (json, env, netrc, text), `bitwarden`, `env` (Windows only), `http`. The request lives on the session's card file and the CLI polls that file. The value is written by the board process that receives the form, on its own machine. | `src/core/secrets.ts:17, 214-219, 374-375`, `src/services/secrets.ts:127-162, 281-362`, `src/entrypoints/secret-cli.ts:64-127` |
| Profiles | A profile is a local folder (`CLAUDE_CONFIG_DIR`). The only variable the board puts into a launched session is that one. | `src/core/profiles.ts:25-36, 208-210`, `src/services/launch/launcher.ts:146-165` |
| Install | Writes its own hooks, the status line, three skills and two commands. One backup file, overwritten each run. Hook commands hold this machine's absolute paths to Bun and to the plugin. A `settings.json` that does not parse stops it before any write. | `src/entrypoints/install.ts:57-61, 120-209`, `src/core/install-plan.ts:116, 194-244`, `src/adapters/hook-settings.ts:90-92` |
| Launch | `POST /api/launch`, then `launches.start`: check, new launch, run. The folder and the profile folder must exist on the board's own disk. The board picks the session id itself and passes `--session-id`. Launch state is a Map in memory. Agents: `claude` or `pi`. | `src/server/routes/launch.ts:12-24`, `src/services/launch/launches.ts:127, 138-191`, `src/services/launch/request.ts:99-104, 148-152`, `src/core/launch/agents.ts:12-15` |
| `spawn-agent` | Runs local herdr directly and never passes through `launches.start`. | `src/entrypoints/spawn-agent.ts`, `src/services/launch/spawn-agent.ts:329-455` |
| Cards | Built by `collect` from the local herdr CLI, the profile folders' transcripts, card files and wake's file. The `board` command and the hook write local JSON files; the server sees them through `fs.watch`. Keys: a Claude session id, else `pane-<id>`, for pi a file path. No device or host field anywhere. | `src/services/board.ts:296-310, 447, 505-515`, `src/entrypoints/cli.ts:968-1005`, `src/entrypoints/hook.ts:103-191` |
| Live updates | `GET /api/events` sends the whole `BoardPayload` on connect and on each change, with a ping every 20 s. No deltas. | `src/server/sse.ts:28-66`, `src/server/board-state.ts:349-358` |
| Terminal | Server-sent events and POSTs over polling of `herdr pane read`. No WebSocket. Not in `localOnly`. | `src/server/routes/terminal.ts:22, 162-165`, `src/services/terminals.ts:52-56, 402-403, 484` |
| `herdr --remote` | The board never runs it. It is a manual step for a person at a desk. | `src/adapters/herdr.ts:11`, `README.md:3361-3382` |
| Sleep and wake | A separate process on 127.0.0.1 that refuses any other Host. Sleep types `/exit`; wake runs `board resume`. All of it is local to the machine. | `src/entrypoints/wake.ts:299-313, 397-399`, `src/core/wake/rules.ts:33-59` |
| Threads, time | `board thread` and `board time` open the board's SQLite file directly. | `src/entrypoints/thread-cli.ts:247`, `src/entrypoints/time-cli.ts:315` |
| A job queue | None. `src/core/queue.ts` parses Claude Code's own prompt queue from a transcript. | `src/core/queue.ts:8-20, 71` |
| Doctor's memory | Only in the `board doctor` command, one line in four groups, counting each pane's process tree. Nothing reaches the payload. | `src/entrypoints/cli.ts:872-881`, `src/adapters/pane-facts.ts:37-131`, `src/core/pane-report.ts:62-107` |
| Workdesk topology | `{version, device_id, observed_at, masters[]}`: the masters that hold claimed Workdesk tasks. One `device_id` per board, sent to the Workdesk MCP child. An assignment has no device field. | `src/core/workdesk-topology.ts:11-23`, `src/core/workdesk.ts:72-78, 105-117`, `src/services/workdesk-watcher.ts:83-90` |
| MCP config for a session | Nothing writes one. No `--mcp-config`, no `.mcp.json` writer. | not found in `src` |
| The web board alone | `bun src/entrypoints/server.ts` runs the web board without the terminal board: scheduler, wake, listeners. This is what a node runs. | `src/entrypoints/server.ts`, `src/server/app.ts:3, 231` |

## 2. Where the spec is wrong or simplifies

1. **The hub as the default transport (spec 5 and 16.2).** It cannot carry a snapshot stream, a call with a reply, or a terminal, and a 5 to 50 MB bundle arrives as an upload attached to a question that nothing may apply. "Only a new member type" is not small: there is no type column, every member receives the roster, and team posts go to every roster peer (`hub/src/hub.ts:196-199`, `src/services/team-hub.ts:1028-1030`). Making the hub fit means a second protocol inside it and removing the isolation the Team design rests on (D2 of #208: a peer gets no HTTP access to another board at all). Nodes are a different trust class, the owner's own machines, and get their own link.
2. **"The node always dials out over WSS."** With the master on a laptop behind NAT there is nothing to dial unless the owner already runs the tunnel or Tailscale, and a WebSocket link means inventing call correlation and stream multiplexing that HTTP already has. The link in this plan is dialled by the master.
3. **"Install a node on a VPS by the same flow" (spec 2, 4.1 and 6).** The flow installs none of what a node needs and its plan, record and run types carry the tunnel's `case`, `pair` and `domain` (`src/core/server-plan.ts:163-205`). The service reads one host from `cfg.tunnel` and keeps one run (`src/services/server-setup.ts:245-247`). There is no file upload, and a script rides in argv under Windows' 32,767 character limit. The plumbing carries over; the installer is new.
4. **"After the install root is no longer needed."** True for the tunnel user, which cannot run a command. Undo, an update and a new key log in as the admin again (`README.md:3485, 3584`). The node plan keeps that honest: updates ride the link without root, Undo and OS packages need the admin.
5. **"Proven on Debian 13 and Ubuntu."** Proven in Docker containers with systemd on the owner's PC. A real VPS is listed as a manual step in the design and no recorded result was found.
6. **"The master calls the node like a phone, with orchestrator rights" (spec 2).** The phone door needs Tailscale's whois and refuses what a master needs most. A master door is new: its own listener, its own token, an allowlist.
7. **"Secrets: the agent sees only ok" and the criterion "an agent on the node cannot read secret values" (spec 7 and 15).** The value lands in a sink on the machine where the agent runs as the same user; the README says so itself (`README.md:2422-2425`). What can be promised: the board never puts a value into a transcript, a card, a log or the payload. An agent with a shell on a trusted node can read that node's sink files, as on the master today.
8. **"The bundle is applied by the same rules as install" (spec 7.1).** Install knows only its own hooks and three skills. There is no manifest, no ownership record and one overwritten backup. Those rules are a pattern to copy, with a real ownership record added.
9. **"settings.json without secrets" as something to copy.** On a Windows master the hooks and stdio MCP servers name `C:\` paths and PowerShell. A Linux node cannot run them. Sync has to classify each entry as portable, translatable or bound to the master, and say which.
10. **"board doctor --node reports zero differences" (spec 15).** Not reachable across operating systems. The reachable form: zero unexplained differences.
11. **"launch.claude/pi/Codex."** There is no `launch.codex` and Codex is not an agent a request can pick (`src/core/types.ts:105-122`). Pull request #428 (open) adds it.
12. **"A long-lived token from claude setup-token through a Secrets form."** A sink can store it. Nothing consumes it: no launch path sets any variable but `CLAUDE_CONFIG_DIR`, and a profile's start command may not set variables (`src/core/launch/spawn-args.ts:252-260`).
13. **"Workdesk topology with deviceId, one snapshot per node."** The topology is not a device inventory and `observeWorkdesk` reads the local database and local items (`src/services/workdesk-topology.ts:38-85`). Per-node topology is a stage 2 design of its own.
14. **"The terminal through herdr --remote" (spec 16.1).** The board's terminal is HTTP. It is proxied like every other route; `herdr --remote` plays no part.
15. **"board doctor already counts memory."** It prints one total per group in a command. Placement needs free memory of the whole machine, which nothing reads yet.
16. **Push and pull queues (spec 8).** With the master dialling there is nothing for a node to pull from. One queue on the master, drained when a device reports room, does both jobs.
17. **What the spec does not see at all:**
    - Working folders. A session starts in a folder, and the folder is on one machine. The spec's one line ("exchange goes through git") is the whole of what makes placement safe or not, and it needs a rule (8.4 below).
    - Briefs that name local files. Agents hand work to each other by scratchpad paths; such a session cannot leave the machine.
    - `spawn-agent`. Most sessions are started by agents, and that path bypasses the launch pipeline, so it would never be placed.
    - Threads and time live in the master's database, and their commands open that file directly. A worker on a node that cannot report into its thread breaks the way work is handed out today.
    - Card keys. `pane-<id>` keys repeat across machines and `find(key)` matches on the key alone (`src/server/board-state.ts:476`).
    - Lanes guessed from folder prefixes (`src/core/categories.ts:91-105`) mean nothing on another machine's paths.

## 3. Overlaps with issues and pull requests

Searched open and closed issues and pull requests of `MokuTeam/herdr-agent-board` for node, device, placement, queue, capacity, memory, browser, CDP, tunnel, ssh, pairing, profile sync, MCP config and worktree. No issue or pull request covers nodes, placement or a remote browser. These touch the same code or the same ground:

| Item | State | Why it matters here |
|---|---|---|
| #208, #223 Peer network design | closed, PR open | Its decision that a peer has no HTTP access to another board is why nodes must not ride the hub. The node link must not weaken it. |
| #224 Local HTTP cannot tell an agent from the UI | closed | Anything a node sends up is agent grade. The uplink never carries an owner action. |
| #384, #386, #397 Assistant bridge | merged | Precedent for a server process with its own key beside `hub/`. A node is not a hub peer, but the "own process, own identity, allow list" shape is the same. |
| #141 Pane and profile identity on cards | open | Adds an identity row to the card. The device chip belongs in that row; coordinate instead of adding a second one. |
| #126, #428 Codex sessions and Codex launch | open | Changes the agent list in `launchAgents`. The node launch passes `agent` through untouched so it needs no change when #428 lands. |
| #450 Terminal follows the current agent | open PR | Edits `services/terminals.ts`. The proxy forwards the routes and must not copy that code. |
| #296 Pin the desk refusals | open | Same file as the new door's rules. The master door ships with its pins from the first pull request. |
| #166 Tunnel and server setup follow-ups | open | The in-place write and Undo gaps in `server-plan.ts` and `server-script.ts` are inherited by anything that reuses the runner. Fix the runner's items before reusing it. |
| #167 A config.json that does not parse is replaced by defaults | open | The nodes panel adds writers. They must refuse a file that does not parse instead of adding to the damage. |
| #275 Secret sinks hardening | open | Sinks on servers raise its weight: the file write race and the audit flood. |
| #486 Watches with probes | open | Probes run in the session's folder. For a node card they must run on the node; the master's scheduler never runs a probe for a remote key. |
| #487, #312 One decision queue | open | "What waits on the owner" must include node cards. It does once items are merged; keep that in its tests. |
| #437 to #440 Workdesk routing and topology | merged | Master only in stage 1. Remote items must never enter `observeWorkdesk`. |
| #204, #243 Memory of sleepers' shells | closed | The reading in 4.4 shows 89 PowerShell processes holding 1.5 GB. Whether they are sleepers' shells was not checked. |

## 4. The spec's open questions: closed, and left to the owner

### 4.1 herdr on a node: through the node's board (closed)

The master never talks to a node's herdr. Every action goes to the node's board, which already checks state before it types into a pane (dialogs, drafts, stale data) and already does sleep, wake, the scheduler and the terminal. `herdr --remote` is not used even for the terminal, because the board's terminal is plain HTTP (`src/server/routes/terminal.ts:22`) and proxies like any other route. `herdr --remote` stays what it is today, a way for a person to attach by hand.

### 4.2 Default transport: the master dials the node over ssh, directly or through the owner's server (closed)

Not the hub, for the reasons in section 2, item 1. Not a new WebSocket protocol dialled by the node, for the reason in item 2. The link is the board's own HTTP and event streams from the master to a new door on the node, carried by one of these pipes:

- **ssh** (default for servers): the master runs `ssh -N -L <local port>:127.0.0.1:<node port>` as a fenced forward-only user. Every VPS has sshd, a Mac has Remote Login, nothing is installed for the transport and no port is opened. The laptop dials out, so its NAT does not matter. The supervisor that keeps ssh up exists (`src/services/tunnel.ts:224`: backoff, restart after sleep or an address change, pid record, pinned host key).
- **relay** (for a machine behind NAT, no VPN): the node dials the owner's server with the `ssh -R` the board already uses for its domain, and the master reaches the node's door through that server. Designed in section 20, built as slice E.
- **tailnet** (optional): the node's door listens on its Tailscale address and the master calls it directly. The owner accepts Tailscale for now and does not want to depend on it, so nothing requires it; it is one small task (T14) for the case that a machine behind NAT is wanted before slice E.

The link code is the same for all three. Only the pipe differs.

Consequence the owner should know: the master is the only side that dials. While the laptop is closed, nodes go on with their sessions, their own reminders and their own sleep and wake, and nothing new is placed.

### 4.3 Claude accounts on nodes: the board's existing profiles (decided)

Facts: a node's profile is its own folder with its own login, the board knows each profile's 5 hour and 7 day windows from the status line (`src/core/limits.ts:4-53`, `src/server/board-state.ts:128-139`), and one account on several machines is one limit. The owner's decision: the board's existing profiles and no new mechanism. A node has the same profile ids as the laptop, each logged in once there, and a launch names its profile as it does today. Placement does not look at limits.

### 4.4 What eats the memory: measured, and it is not the browser (closed, one reading)

One passive reading of the process table on the owner's laptop, 2026-11-21 01:40 local, 15 Claude sessions awake:

| What | Memory | Processes |
|---|---|---|
| Free | 2.2 GB of 32 GB | |
| `python.exe`, nearly all of it one session's pytest run | about 11 GB | 24, of them 12 under that session |
| `claude.exe` | 5.1 GB, about 340 MB each | 15 |
| `pwsh.exe` shells | 1.5 GB | 89 |
| `chrome.exe`, the owner's own browser | about 1 GB | 1 browser |
| Browsers started for automation (debugging port, headless, automation flags) | 0 | 0 |
| The board's own Edge window | 37 MB | 1 |
| The other sessions' child processes (bun, shells, tools) | about 1.0 GB | |

One reading at night is not a week's profile, and the owner knows whether Playwright days exist. But on this evidence a browser node first would have freed nothing, while moving one test run would have freed a third of the machine. Two design consequences: sessions come first (section 15), and "has room" is decided by free memory of the machine, with the session count only as a ceiling (8.2).

### 4.5 Android under Termux: not answerable from the code (deferred, no decision needed now)

The plugin declares `windows, linux, macos` (`herdr-plugin.toml`). Whether herdr and Claude Code run on arm64 under Termux needs a phone in hand. It stays in stage 3 and blocks nothing before it.

### 4.6 The owner's decisions (2026-11-21)

| # | Choice | Decision | Where it lands |
|---|---|---|---|
| 1 | Sessions first, or the browser node first | Sessions first; the browser node in stage 2. | Sections 14 and 15. |
| 2 | Where the master lives | The laptop for now. Later, ideally last man standing: any node can take over when the master is gone. Keep the roles symmetric. | Section 21; the seven things stage 1 does for it are in 21.3 and in T1 to T3. |
| 3 | Accounts on nodes | The board's existing profiles, no new mechanism. | 4.3; section 10, item 1. |
| 4 | Which lanes may leave the laptop | A setting, nothing fixed in code. | `nodes.lanes` (7.1), the panel (section 12), 8.1 step 2. Default taken here: no lane leaves until the owner ticks it, and the board asks when the first device is added. A lane an agent makes later starts unticked. |
| 5 | Everything is full | A start by hand runs on the laptop, the queue waits ("probably"). | `nodes.whenFull: "local"` as the default (8.1 step 5); `"wait"` is the other value, so the answer can change without code. |
| 6 | Machines behind NAT | Tailscale is acceptable for now and not liked: find a way without a VPN and say what it costs. | Section 20. Recommendation there: build the relay as slice E and leave the tailnet door optional. |

## 5. Architecture

```
                       master: the board on the owner's computer
        ┌───────────────────────────────────────────────────────────────┐
        │ board, cards, threads, Team, schedule, secrets forms          │
        │ AGGREGATE  each node's payload, merged at publish time        │
        │ PLACE      device order, room, portability, one queue         │
        │ SYNC       profile bundle per node and profile                │
        │ PROXY      /api/... for a card of another device              │
        └───────┬─────────────────────────┬───────────────────────┬─────┘
                │ ssh -L (master dials)   │ ssh -L                │ via the owner's server
        ┌───────▼────────────┐   ┌────────▼───────────┐   ┌───────▼────────────┐
        │ node: server-1     │   │ node: server-2     │   │ node: behind NAT   │
        │ master door :12430 │   │ master door        │   │ master door        │
        │ the web board,     │   │ (same)             │   │ (same)             │
        │ alone: scheduler,  │   │                    │   │                    │
        │ wake, terminal     │   │                    │   │                    │
        │ herdr, claude, pi  │   │                    │   │                    │
        └────────────────────┘   └────────────────────┘   └────────────────────┘
```

- **A node is a whole board with one more door.** herdr runs there as a service (`herdr server`) with the plugin linked, and the plugin's own startup entries bring up the board and sleep and wake, as on any computer, with nobody attached (tried on a server, section 18). The board's config.json has a `node` key. There is no reduced "node role" build: cards, hooks, the `board` command, sleep and wake, the scheduler and the terminal run on the node exactly as on any board today. That is what keeps the change small and keeps a node working while the master is away.
- **Roles are keys.** `nodes` makes a board a master, `node` makes it a node, and one board may hold both. Nothing in the code path says "this build is a node". That is what keeps section 21 possible.
- **The master door** is a new listener on the node, on 127.0.0.1, for its master, by a bearer token. It serves an allowlist of the board's existing routes plus a few under `/api/node/`. The phones' listener and its pairing are not touched.
- **The master aggregates at publish time.** Each node's `/api/events` stream gives its whole payload, as a page gets it. The master adds those items to its own payload, each with a `device` and a key prefixed `@<device>:`. The board's own item list stays local: the scheduler, auto-compact, Workdesk, wake and the links never see a remote item, so they cannot act on one through local herdr.
- **The master proxies by key.** A request about a key that starts with `@server-1:` is forwarded to that node with the prefix removed, after the master's own guards. Session actions, the session sheet, the terminal, files, uploads, schedule edits and secret forms all work for a node card through this one mechanism, because the node already serves them.
- **Calls from a node to the master** (a worker posting into its thread) ride the same link in reverse: the node keeps an outbox, the master holds a stream open on it, takes each call and posts the reply. The node never needs a way to reach the master.
- **Sources of truth.** On the master: the device list and order, the queue, threads, Team, time, calendar, the bundle's source. On a node: its cards, transcripts, working folders, schedule entries of its own sessions, its sinks. The master keeps each node's last payload on disk to show an offline node.
- **Nothing changes without the keys.** No `nodes` key: no link, no timer, no file, no route, no payload field. No `node` key: no door.

## 6. The node link, version 1

### 6.1 The door

| | |
|---|---|
| Listens | `127.0.0.1:<node.port>`, default 12430, and nowhere else. (With the optional `node.listen: "tailnet"` of T14 also the machine's Tailscale address.) |
| Encryption | Over direct ssh the forward is the encryption. For the relay pipe the door itself speaks HTTPS (`node.tls`) with a certificate made at install, which the master pins at claim, so the server in the middle forwards bytes it cannot read (20.1). |
| Host | Must be a loopback name (`127.0.0.1`, `localhost`, `[::1]`); the port may differ, since a forward lands on any. Else 403 `host`. |
| Caller | `Authorization: Bearer <token>`; only hello and claim answer without it. The node keeps the SHA-256 of each master's token in `<state>/node/masters.json` (0600): a list, with one entry in stage 1 (21.3). On the tailnet door also `tailscale whois`: the caller must be the Tailscale node recorded at claim. |
| Browsers | A request with an `Origin` header is refused (403 `origin`), as wake's API does (`src/entrypoints/wake.ts:299-313`). This door is for a program. |
| Writes | `X-Board: 1` on anything but GET, as everywhere. |
| Routes | An allowlist (6.2). Anything else is 404, so the door does not say what the board has. |
| Rate | `RateLimiter` (`src/core/access.ts:61`) on a wrong token: 5 a minute, then 429. |
| Revoked | A stream ends with the `unpaired` event (`endsWhenGone`, `src/server/streams.ts:47-87`); a request gets 401 `token`. |

### 6.2 What the master may call

Existing routes, served unchanged:

| Routes | For |
|---|---|
| `GET /api/hello` | Identity and versions, before the token. Adds `node: { api: 1, id, claimed, join? }`. |
| `GET /api/events`, `GET /api/board` | The node's payload. |
| `/api/session/<key>` and `/changes`, `/history`, `/meter`; `POST /api/session/<key>/(answer, permit, stop, sendnow, message, wake, sleep, restart, rename, workspace, card, archive, fork, aside)` | The card and its sheet. |
| `POST /api/sleep`, `/api/move`, `/api/archive`, `/api/todos` | The bulk actions, with the node's own keys. |
| `/api/term/<key>/(agent, shell)/(stream, open, close, input)` | The terminal. Not `shell/focus`. |
| `/api/fs/(stat, preview, raw, download, dirs)`, `/uploads/...`, the upload route | File chips, quick look, a file sent with a message. Not `/api/fs/open`, `/api/reveal`, `/api/open-url`. |
| `/api/schedule...` | Entries of the node's sessions. |
| `POST /api/secret/<id>` | The owner's answer to a secret form of a node session. |
| `GET /api/launch/options`, `POST /api/launch/<id>/...` | A launch's card: trust, dismiss. |

New routes, on this door only:

| Route | Body and answer |
|---|---|
| `POST /api/node/claim` | `{ code, master: { name } }` gives `{ token, id }` once. 403 wrong code, 410 expired, 409 already claimed. Five wrong codes end the code. Open only while a join code lives (10 minutes). |
| `GET /api/node/status` | 6.3. |
| `POST /api/node/launch` | 6.4. |
| `GET /api/node/bundle/<profile>` | `{ seq, hash, files: { <path>: <sha256> } }`: what the node has. |
| `PUT /api/node/bundle/<profile>/blob/<sha256>` | The file's bytes, at most 8 MB, stored by hash. Sending one twice changes nothing. |
| `POST /api/node/bundle/<profile>/commit` | The manifest (9.3). `{ ok, applied, kept: [{ path, why }], backup, git? }`, or 409 with `settings-parse`, `missing-blob`. `git`: what came of the owner's identity the manifest carries (`set`, `same`, `kept`, `no-git`, `failed`, #609). |
| `POST /api/node/bundle/<profile>/secrets` | `{ env: { <name>: <value> }, files: [{ path, text }], logins?: [{ host, user, token }] }`: the secrets the profile's bundle held back and the owner's GitHub logins, for a device given them (section 10). `{ ok, env, written, removed, files, filesWritten, filesRemoved, kept, refused }`, and with `logins` also `{ logins: [{ host, user, via }], loginsTaken, loginsKept, loginsRefused, gh }`: names, paths, hosts and accounts only. |
| `POST /api/node/sink/<sink id>` | `{ values, fingerprint }`: a secret the owner gives the node without an agent asking (section 10, item 3). |
| `GET /api/node/uplink` | A stream of calls the node's sessions make to the master: `event: call`, `data: { id, cmd, argv, session, lane, files: [{ n, name, size, sha256 }] }`. |
| `GET /api/node/uplink/<id>/file/<n>` | A file the call names. |
| `POST /api/node/uplink/<id>` | `{ code, out, err }`: the call's result. |
| `PUT /api/node/update/blob`, `POST /api/node/update` | The plugin at the master's commit as one archive, then `{ commit, sha256 }`: the node checks, unpacks beside the old copy, runs `bun install --production`, swaps and restarts. |
| `POST /api/node/leave` | `{ sleep: true }`: puts its sessions to sleep when asked, takes out what that master's bundles gave (11.4), forgets the master, ends the streams. `{ ok, slept, kept, takenOut: { env, files, logins, identity } }`. |

Errors are `{ error: <code> }` as elsewhere. Codes of this door: `host`, `origin`, `token`, `full`, `profile`, `repo`, `bundle`, `api`, `busy`.

### 6.3 Status

`GET /api/node/status`, asked every 30 s and right before a placement:

```json
{
  "api": 1, "id": "server-1", "version": "0.1.0", "commit": "ee32fc89",
  "platform": "linux", "arch": "x64", "cpus": 8,
  "memTotalMb": 32013, "memAvailableMb": 21480, "load": [0.42, 0.61, 0.58],
  "sessions": { "awake": 2, "working": 1, "asleep": 5 }, "launches": 0,
  "workRootFreeMb": 148000,
  "profiles": [{ "id": "default", "loggedIn": true, "bundle": { "seq": 14, "hash": "9c1e..." } }],
  "agents": ["claude"], "programs": ["python3", "bash", "git", "gh"],
  "git": { "identity": true, "logins": [{ "host": "github.com", "user": "owner" }] }, "at": 1795210000000
}
```

Facts only. The node holds no thresholds and takes no placement decision; it refuses a launch only below a hard floor of its own (`full` under 512 MB available), which makes the master try the next device. `memAvailableMb` is `MemAvailable` from `/proc/meminfo` on Linux, free plus inactive plus purgeable pages from `vm_stat` on macOS, `FreePhysicalMemory` on Windows. `load` is null on Windows. `programs`: which of a few names a hook may run (`python`, `python3`, `py`, `pwsh`, `powershell`, `node`, `bash`) are on the node's PATH, looked up once per run of its board (#603), and `git` and `gh` where they are (#609); a node of an older board leaves it out, and the bundle then says which hooks may lack their program. `git` (#609): whether a global `user.name` and `user.email` are set, and the hosts it holds a GitHub login for (gh's hosts file, and the logins the bundle put in git's own store); looked once per run and again after a secrets request, a file read and one git call. The device's row says from these what an agent there cannot do: commit (no git), commit as the owner (no identity), push (no login), open a pull request (a login and no gh).

### 6.4 Launch

```json
{
  "id": "5d0c6a1e-...", "name": "atlas-12", "category": "atlas",
  "profile": "default", "agent": "claude", "model": "", "message": "...",
  "parent": { "key": "…", "name": "Atlas Master", "device": "local" },
  "source": { "kind": "repo", "url": "github.com/example/atlas", "ref": "main",
              "subdir": "", "worktree": { "branch": "atlas-12" },
              "identity": { "name": "…", "email": "…" } }
}
```

- `id` is the session id. The board already picks it before Claude exists and passes `--session-id` (`src/services/launch/launcher.ts:362-366`). The node treats `id` as the launch's identity: the same `id` again returns the launch it already has. A retry after a lost answer therefore cannot start a second session.
- `source.kind: "repo"`: the node resolves the checkout under `node.workRoot` by the repository's address, clones it when missing, fetches, and hands its local launch pipeline a folder and the worktree request. `identity` (#611) is the author git gives in the master's checkout (`git config user.name` and `user.email` asked there, so includes and the checkout's own config count), both or neither, asked only once a start may leave; the node sets it in the clone's own config (`git config --local`, which its worktrees share) when git there gives another, never in its global one, and turns the start away as `repo` when it cannot. None sent: the node's own identity applies. One clone serves every start of its repository, so two starts with different identities on the master (possible only by hand) leave the later one there, for the earlier session too. What a start writes in a clone is the clone's, and leaving (11.4) does not take it out. `source.kind: "path"` with `cwd` is for a start pinned to a node by hand with a folder of that node.
- Answers: 202 `{ launch }`; 409 `full`, `profile` (no such profile or not logged in), `repo` (cannot clone, or a checkout with changes where a clean one is needed), `bundle` (older than the request says it needs). The master also turns a start away as `bundle` when the sync it runs right before the start (9.2) does not end well.
- After that the launch is the node's own: its card rides in the node's payload, with trust dialogs and failures as today.

### 6.5 Streams, liveness, versions

- The payload stream is today's: an unnamed `data:` line with the whole payload on connect and on change, `: ping` every 20 s.
- **Offline** is 90 s without a byte on that stream. The master then shows the node's last payload with its age, releases what it had reserved there and puts launches that had not reached the node back in the queue. A launch the node acknowledged is the node's; it is never started again elsewhere.
- **Reconnect** uses the tunnel's backoff: 1 s doubling to 60 s, plus or minus 20 percent (`src/core/tunnel.ts:264`), at once after the master wakes from sleep or changes network.
- **Versions.** `node.api` in hello is this link's version, 1. The master places work only on a node whose `node.api` equals its own and whose `commit` equals its own; a node on another commit keeps its sessions and is offered Update (and updates by itself when none of its sessions is in a turn). `REMOTE_API` for phones is not touched.

## 7. config.json and the state files

### 7.1 On the master: `nodes`

```jsonc
"nodes": {
  "id": "laptop",                              // this board's own device id, as others and the records name it
  "order": ["server-1", "server-2", "local"],  // priority, first is filled first; "local" is this computer
  "whenFull": "local",                         // or "wait": a start by hand when no device has room
  "lanes": ["atlas", "tools"],                 // lanes that may leave this computer; "all"; absent: none
  "relay": { "host": "relay.example.com", "sshPort": 22,
             "user": "agent-board-relay-m" }, // only with a relay (section 20)
  "devices": {
    "server-1": {
      "title": "Server 1",
      "link": { "kind": "ssh", "host": "203.0.113.10", "sshPort": 22,
                "user": "agent-board-link", "port": 12430 },
      "maxSessions": 4,                        // written by the board from the hardware (here 8 GB, 4 cores), editable
      "minFreeMemMb": 1200,
      "maxLoad": 0.9,                          // 5 minute load per core; ignored where there is none
      "tags": ["linux", "tests"],
      "profiles": { "work": "work" },          // master profile id to the node's; absent: the same id
      "paused": false, "drain": false,
      "sinks": { },                            // this node's secrets.sinks, sent with the bundle
      "mcp": { "some-server": false },         // per server: false, or { command, args, env }
      "accept": ["hook:notify-toast"],         // differences the owner has seen and accepts
      "giveSecrets": false                     // the secrets its profile needs are not sent with the sync; absent: they are (10)
    },
    "local": { "maxSessions": 20, "minFreeMemMb": 4800 }
  }
}
```

- Parsed by `nodesConfig(raw)` in the style of `teamConfig` (`src/core/team.ts:73-80`): no key, or `false`, gives null and the feature does not exist. Unknown keys are reported per device, as `secretsConfig` does (`src/core/secrets.ts:447-491`), and switch that device off instead of guessing.
- Device ids: `^[a-z0-9][a-z0-9-]{0,31}$`; `local` is reserved. A device missing from `order` goes after the listed ones; `local` missing from `order` goes last.
- `link.kind`: `ssh` (`host`, `sshPort`, `user`, `port`), `relay` (`socket`: the node's socket name on `nodes.relay`'s server), `tailnet` (`address`, `port`), `direct` (`url`; for tests and for a loopback forward the owner keeps up himself).
- `nodes.id` follows the device id rule and defaults to the computer's host name made to fit. `local` is only a word in this board's own `order`; what crosses a link or is written down (a launch's parent, the audit, a queue entry) names the id.
- `nodes.lanes`: the lanes whose sessions may run on another device, by lane id; `"all"` for every lane; absent or empty, none. Set in the panel (section 12).
- No secret is in config.json. Per device, in `<state>/nodes/<id>/`, 0600: `token` (the master is the client, so it holds the token itself), `link-key` and its `.pub` (ed25519, made by `generateKey`, `src/adapters/ssh.ts`), `snapshot.json` (the last payload), `bundle.json` (what was sent). The node's ssh host key is pinned in the board's own known_hosts, as the tunnel's is.
- Also in `<state>/nodes/`: `queue.json` (8.3), `audit.jsonl` (who was added, revoked, updated; which bundle, sink and launch went where; never a value).
- Default thresholds are written when a device is added, from its first status: `maxSessions = clamp(floor((memTotalMb - 1500) / 1500), 1, 4 × cpus)`, `minFreeMemMb = max(1024, 15 percent of memTotalMb)`, `maxLoad = 0.9`. The owner may change them and does not have to.

### 7.2 On a node: `node`

```jsonc
"node": { "id": "server-1", "port": 12430, "workRoot": "~/work" }
// behind NAT, also: "tls": true, "relay": { "host", "sshPort", "user", "socket" }
```

- `nodeConfig(raw)`: no key, no door.
- `<state>/node/masters.json` (0600): a list of `{ id, name, tokenHash, pairedAt, seenAt, via }`. One entry in stage 1; a list so that a second master can be added later without a migration (21.3).
- With `relay`: `<state>/node/relay-key` (the key the node dials the server with) and `<state>/node/door-cert.pem` with its key.
- `<state>/node/bundle/<profile>.json`: the manifest the node last applied, which is also the record of what the bundle owns there. `<state>/node/blobs/`, `<state>/node/bundle-backups/<profile>/<seq>/`, `<state>/node/env/<profile>.env` (section 10, item 4), `<state>/node/outbox/` (calls to the master not yet answered), `<state>/node/bundle-secrets/<profile>.json` (0600, #604: the names of the variables the bundle gave and, per secret file, the SHA-256 of what it wrote, so a file changed on the node since is left alone, and since #609 the master that gave them; never a value), `<state>/node/git-access.json` (0600, #609: the identity the node set and per host the account, how it took the login, gh or git's store, and the token's SHA-256, each with the master that gave it; never a token).
- The master owns four keys of the node's config.json and rewrites them with each bundle: `categories`, `language`, `models`, `secrets.sinks`. Everything else in that file is the node's.

## 8. Placement by device order

The owner's demand: he never thinks about where an agent runs. He orders the devices once; the board fills them in that order by what each has room for.

### 8.1 The decision is one pure function

`src/core/placement.ts`, no I/O, tested as a table:

```ts
type Verdict =
  | { on: DeviceId; why: string }        // start here
  | { wait: string }                     // queue; the string goes on the launch's card
  | { refuse: string }                   // no device could ever take it

function place(task: Task, view: View, now: number): Verdict
```

`Task`: lane, profile, agent, `pin` (a device or a tag, only when the owner set "Where"), `needs` (tags), `origin` (the device that has the folder), `portable` (8.4, with its reason), `byHand` (a person pressed the button). `View`: the order, each device's settings, its last status with its age, whether it is online, what the placer has reserved on it, and whether the memory gate is closed on it.

Steps:

1. **Candidates.** `pin` names them; otherwise the whole order.
2. **Home.** A lane that `nodes.lanes` does not list, or a task that is not portable: the only candidate is `origin`. The reason is kept for the card ("on this computer: the folder has changes that are not pushed").
3. **Fit**, per candidate, nothing to do with load: not paused, not draining, not revoked; `node.api` and commit equal to the master's; the profile exists there and is logged in; the agent kind is there; every `needs` tag is among its tags.
4. **Room**, in order: the first candidate that is online and has room wins.
5. **Nobody has room.** A start by hand with `whenFull: "local"`, when this computer fits (step 3): start here, whatever its own thresholds say. Otherwise `wait`, naming the first candidate's blocker ("server-1: 3 of 3 sessions"). No candidate passed step 3 at all: `refuse` with the reason.

Filling in order, never spreading: step 4 takes the first device with room, so server-2 gets nothing while server-1 has room, and the laptop gets nothing while a server has. Evening the load out is not built in stage 1.

### 8.2 "Has room"

All of these, from the device's status:

- `sessions.awake + reserved < maxSessions`. Sleeping sessions hold no process and do not count.
- `memAvailableMb - reserved × 800 >= minFreeMemMb`. This is the gate that matters: one session's test run held 11 GB in the reading of 4.4, and no session count sees that. Once a device fails it, it passes again only above `minFreeMemMb × 1.15`, so it does not flap.
- `load[1] / cpus <= maxLoad`, where the platform has a load average.

A status older than 45 s is asked again before deciding, with a 1.5 s limit; a device that does not answer is offline for this decision.

**Reservations.** Seven starts in ten seconds would all see the same status. The placer counts each decision against the device at once and lets go when the node's payload shows that session id, when the start fails, or after 180 s.

The spec's acceptance run, order `server-1, server-2, local`, both servers `maxSessions: 3` with memory to spare, seven starts by hand:

| Start | server-1 (awake + reserved) | server-2 | Verdict |
|---|---|---|---|
| 1, 2, 3 | 0, 1, 2 of 3 | | on server-1 |
| 4, 5, 6 | 3 of 3 | 0, 1, 2 of 3 | on server-2 |
| 7 | 3 of 3 | 3 of 3 | on local, or `wait` with `whenFull: "wait"` and local full or set to 0 |

### 8.3 One queue, on the master

A task that waits is a launch in a new state, `queued`, kept in `<state>/nodes/queue.json` so it survives a restart of the master (launches themselves are a Map in memory today, `src/services/launch/launches.ts:127`). It shows as a launch card with "waiting for room: server-1 has 3 of 3 sessions" and a Cancel. The placer tries the queue again on every status that changes room, on a node coming online, and every 15 s. An entry that cannot go does not hold back one that can. At most 50 entries.

There is no pull. A node never asks for work: the master pushes when it sees room. This is the spec's pull queue with the same result and no second protocol.

Live sessions never move. A session on the laptop stays there when a server frees up; only new work follows the order. Wake, fork and resume run where the conversation's file is.

### 8.4 What may leave the machine: the portability rule

The board can choose where a process runs. It cannot make a folder exist on another machine. So before a task may go anywhere but its origin, `portable(task)` must hold, checked on the master with a few git calls (`src/core/portable.ts` for the rule, `src/adapters/git.ts` for the facts):

1. The folder is inside a git checkout that has a remote.
2. One of:
   - the task asks for a new worktree, and the branch it starts from equals its remote branch (nothing on it is unpushed);
   - no worktree, and the checkout is clean with its HEAD equal to its upstream.
3. The first message names no absolute path that exists on this computer (a scratchpad file, another checkout). Paths are found by shape, Windows and POSIX, at most 20 of them looked at.
4. The lane is one `nodes.lanes` lets leave.

Not portable is not an error. The session starts where its folder is, as it does today, and its card says why in one line. This is the honest edge of "he never thinks about it": work whose inputs travel in git and in the brief goes wherever there is room; work tied to this computer's files stays on it without asking.

On the node, `source: repo` becomes a folder: `<workRoot>/<host>/<path>`, cloned when missing, fetched, fast-forwarded when a clean checkout is asked for, with the worktree made by the node's own launch pipeline. A node checkout with changes of its own where a clean one is needed answers `repo` and the master tries the next device.

Results come back the way the spec says, through git: the agent on the node pushes its branch. The card of a node session shows its branch and whether it is pushed (the `/changes` route, proxied), and a finished node session with unpushed commits says "the work is only on server-1".

### 8.5 Which starts are placed

- **New session on the board**: through the placer, at the one seam every board start passes, `launches.start` between `checkRequest` and `runner.run` (`src/services/launch/launches.ts:146-171`).
- **`spawn-agent` by an agent**: today it never reaches that seam. With `nodes` configured it asks the local board to start the session (the same `POST /api/launch`, in its caller's lane and not as a start by hand, so it waits in the queue when all is full), so the placer sees it; with the board not answering, or without `nodes`, it runs as today. For a start that went to a node it prints `pane=@<device>:<session> ... device=<device>`, naming the session by its prefixed key and never by a guessed herdr name. Most agent starts name a local worktree or a scratchpad brief and will stay home by 8.4. The `herdr-agents` skill gains two lines on how to make a worker placeable: push the branch, give paths inside the repository.
- **On a node**, `spawn-agent` starts on that node. A node has no `nodes` key and places nothing.
- **Resume, fork, wake, restart**: on the session's own device, proxied.
- The "Where" field (a device or a tag) is under "More" in the New session window and sets `pin`.

## 9. Profile sync

### 9.1 A bundle is a translation, with a report

Per profile, the master builds a bundle from the profile's folder and classifies every entry. The same classification is what `board doctor --node` prints.

| Part | Rule |
|---|---|
| `skills/`, `agents/`, `commands/`, `CLAUDE.md` | Copied as files. Left out, with a line in the report: a file over 5 MB, and folders named `node_modules`, `.git`, `.venv`, `__pycache__`. |
| `settings.json`: `permissions`, `model`, effort and the other plain settings, `enabledPlugins`, `extraKnownMarketplaces` | Copied as keys. |
| `settings.json`: `env` | Copied, except names that look like a secret (token, key, secret, password): their values go with the sync into the node's env file when the device is given its secrets (section 10, "The secrets with the sync"), else they are listed as "give this node a secret" (section 10, item 3). |
| `settings.json`: hooks | The board's own hooks are never sent; the node's install writes them with the node's paths (they hold absolute paths, `src/core/install-plan.ts:206`). herdr's own hook neither: the node's herdr installs its own. Another hook is portable when its command lives inside the profile folder (the folder's path is rewritten, and the files it names there travel with it; what those files read or run in turn is not followed) or is a bare command the node finds on its PATH. Any other hook, such as one that names `C:\` or PowerShell on the way to a Linux node, is not sent and is reported with its command. A hook's program goes by what the node's status says it has (`programs`, a few names asked once, #603): `python` it lacks while it has `python3` is written as `python3`, any other it lacks is not sent, and one a node of that platform may lack is said when the node did not say. A data file (JSON, env, ini, toml, yaml) beside a sent script that the script names by its base name is never sent as a file: one with a key named like a secret is reported as needs-secret with its path, one without as not sent (it may be the script's own state). |
| MCP servers of the user scope (`mcpServers` in the profile's `.claude.json`; of the rest of that file only the next row's keys) | `http` and `sse` servers: copied; a header that holds a value becomes a `${VAR}` reference, and the value goes with the sync when the device is given its secrets, else it is asked for as a secret. A reference the owner wrote with a default (`${NAME:-x}`) is the session's own environment: nothing to give, not reported. `stdio` servers: portable when the command is a launcher found on the node (`npx`, `uvx`, `bunx`, `node`, `python`, `docker`) and no argument is an absolute local path. Any other is "bound to this computer": reported, and either overridden for that node in `nodes.devices.<id>.mcp`, switched off there, or forwarded in stage 2. |
| `.claude.json`: the owner's answers to notices a setting the bundle sends turns on (`ACKNOWLEDGMENTS` in `src/core/bundle.ts`: Code Mode's two keys, bypass permissions' one) | Carried when true, a report line each. The node writes the keys its file lacks and no other key, read and written beside and renamed, again when a running session rewrote it meanwhile (#602). |
| The master's global git identity (`git config --global user.name`, `user.email`; not a repository's own, #609) | Carried as two plain values whatever the device's secrets switch says, a report line; a master with none sends none and the report says so. The node sets its own global identity from it unless its owner set another by hand (the same is taken over, one the bundle set is followed). When the master later has none, the node keeps what it has. |
| A project's own `.claude/` and `.mcp.json` | Not in the bundle. They come with the repository. |
| Credentials, `.claude.json` beyond `mcpServers` and those answers, transcripts, per-project memory | Never sent. Memory is keyed by the folder's path, which differs per machine; syncing it both ways is a design of its own and not in stage 1. |
| The board's slice | `categories`, `language`, `models`, and this node's sinks from `nodes.devices.<id>.sinks`. `launch.claude` is sent only when its program is plain `claude` (its flags then travel); a launcher of the owner's own stays on the master and the report says so. |

### 9.2 Version and when it moves

The bundle's `hash` is the SHA-256 of its sorted manifest; `seq` counts hashes the master has seen for that profile, so a node "behind by 2" means two changes. The master computes the hash right before a placement on a node and every 5 minutes while a node is online, never on a prompt. A node that is behind is synced first and the start waits for it. A sync has 20 s for each request and 15 minutes in all: only changed files travel, a few at a time, but a profile's first bundle is hundreds of them. How long a start itself waits for a sync is the placer's decision (#584). That replaces the spec's filter "nodes with a current bundle": a node is made current instead of being skipped.

### 9.3 Applying on the node

`POST .../commit` carries the manifest: each file's path, hash and mode, the settings keys, the MCP servers, the board's slice. The node:

1. Parses its `settings.json` and its config.json. Either one not parsing: 409, nothing written. Same rule as install (`src/entrypoints/install.ts:120-134`).
2. Checks that it has every blob.
3. Copies every file it is about to replace or delete into `bundle-backups/<profile>/<seq>/`. One folder per commit, kept for the last 10.
4. Touches only what it owns. Owned means: listed in the manifest it applied last time. A file that is in the new manifest, exists on the node, is not owned and differs is left alone and returned in `kept` with the reason. Files owned before and absent now are removed. In `settings.json` and in `mcpServers` it replaces only the keys and server names the bundle owns; a key the node's owner added by hand stays.
5. Writes files to a temporary name and renames them.
6. Runs the board's install for that profile (`installInto`, `src/adapters/hook-settings.ts:78-104`), which puts the board's hooks back with this node's paths.
7. Puts the owner's answers to notices the manifest carries (`acks`) into the profile's `.claude.json`, the keys it lacks only, never another key (#602); a file that does not parse, or one a running session rewrote each of three times, is left as it is and the log says so.
8. Records the new manifest.

Applying the same manifest twice changes nothing.

### 9.4 `board doctor --node <id>`

In the current doctor's manner (what is missing, what it costs, how to fix it): the commands and hooks on the node, herdr's hook, sleep and wake, each profile's login, the bundle's version, then the differences by kind: skills (n of n), hooks not sent with their commands, MCP servers bound to this computer, secrets a setting refers to that the node was never given (names only, from the audit), repositories it cannot reach. A difference the owner accepts goes into `accept` and is printed as accepted from then on.

## 10. Access and secrets on a node

The owner's second demand: access on a node works as on the master. What that means per kind:

1. **Claude's login.** The board's existing profiles, by the owner's decision (4.6): the owner logs in once per profile on the node, in the node's shell opened from the board (the terminal proxy), with Claude Code's own login by link. Nothing new is stored or carried, refresh is Claude Code's own business, and the master's credentials are never copied. The device's row shows "Log in to Claude" until the node's status says the profile is logged in. The spec's other way, a `claude setup-token` token in a sink, is not planned: it would be a new mechanism and would put a long-lived token in a file the agent can read.
2. **A secret an agent asks for.** `board secret request` on a node writes the request on its card there, as today. The card is in the node's payload, so the form appears on the master's board. The owner's answer goes to the master, which forwards the POST to the node, and the node's board writes its own sink. The value crosses the master's memory and the encrypted link; it is never in a file, a log or the payload on the master. The sinks' definitions for a node live in the master's config (`nodes.devices.<id>.sinks`) and travel with the bundle, so the fingerprint check (`src/core/secrets.ts:628-633`) holds on the node.
3. **Git and GitHub as on the master** (#609). The owner's git identity goes with every bundle (9.1), and a start sent as a repository carries the one its checkout gives (6.4, #611), so a repository with an identity of its own commits as on the master. With the device given its secrets, each sync's secrets request also carries, for each host gh on the master is logged in to (gh's hosts file; `gh auth token --hostname <h>`, the way to the token on every system, Windows's keyring too), the token and the account. Nothing when the master has no gh or no login, and the report says there was none to give. The node takes each with `gh auth login --hostname <h> --git-protocol https --with-token` (the token on stdin) and `gh auth setup-git`; a node without gh keeps it in git's own store (`git credential approve` through the `store` helper alone, the file private, `credential.https://<h>.helper store` set when nothing is set for that host) so a push works, and the report says pull requests need gh there. A token gh already holds there that is the same is taken over with no second login (the first real node was set up by hand); one the bundle gave and that changed on the master is replaced; another one of the node's owner is kept and said. The node compares by SHA-256 and keeps hosts, accounts and hashes, never a token. When the master later has no login, the node keeps what it has; leaving takes it out (11.4). Any other secret the node needs before anyone asks (a key an MCP server reads): the device's row has "Give a secret", the same form, sent to `POST /api/node/sink/<id>`.
4. **Variables for MCP servers.** A file sink in `env` format writes `<state>/node/env/<profile>.env`, and so does the sync for a device given its secrets (below). On a node, a launch and a resume add those variables to the session's environment (herdr's `--env` for a new tab, the process environment in `board resume`). On a board without a `node` key the environment stays exactly `CLAUDE_CONFIG_DIR`, as today.
5. **Threads.** `board thread` on a node forwards the command to the master over the uplink (6.2) and prints what the master answers. The master runs the same command code with the node session's identity (its prefixed key and its card's lane). A report given as `--file` is pulled by the master into its uploads. A post or a question made while the master is away is kept in the node's outbox and delivered once (each carries an id the master has seen or not); a read fails at once and says the board's computer is not reachable. Thread notices for a node session are typed by the node's board when the master's scheduler sends them through the proxy.
6. **What a node does not have in stage 1**, and what the session's home should then be: Team from a node, `board time`, `board cal`, presence, and every MCP server bound to the master (the logged-in browser, Telegram, desktop control). On a node those commands say so in one line instead of writing into a database nobody reads. Lanes that need them are left out of `nodes.lanes`. Stage 2 forwards the allowed commands and the allowed MCP servers.

**The secrets with the sync** (#604, the owner's decision of 2026-11-21). A device is given the secrets its profile needs unless `nodes.devices.<id>.giveSecrets` is `false` (the device's row: "Give it the secrets"). Then each sync, before the bundle, sends in a request of its own (`POST /api/node/bundle/<profile>/secrets`, never the manifest or a blob) the values the translation replaced by `${MCP_<SERVER>_<NAME>}`, the settings `env` values held back for their name, and the secret files a hook's script reads beside it (9.1). They go from the master's memory to the node, which writes them through the file sink's own writer: the variables into the profile's env file under those names, the other lines of that file kept (a sink filled by hand writes the same file), a file into its place in the profile folder, private to the user. A value that did not change is not written again. The node records which names and files the bundle gave, names only, so one the master no longer has is taken out at the next sync and one given by hand under another name stays; a file there that the bundle did not give and that differs is kept and said, as in 9.3; one it gave that was changed on the node since (a JSON sink filling a key, a hook refreshing its token) is left as it is too, by the SHA-256 the node kept of what it wrote, and one the master named but could not read this time is not taken out. Turning the switch off takes nothing back: what was given stays there, and the device's row says it was given. Each side has an audit line with the names. With the switch off the bundle is as before: every secret held back and reported, and `board nodes sync`, the form's first sync and the device's row name what is to be given by hand.

**Trust.** Stage 1 has one mode: a trusted node, a machine of the owner's where his secrets may live. Whoever controls it has what its agents have, and the variables a new tab gets reach herdr on the node's command line (`--env`), where another user of that machine may see them while the tab is made. The other direction is fenced: a node cannot start anything on the master, the uplink takes only the allowlisted agent commands and never an owner action (#224), the node's payload is data that is checked field by field and escaped like any transcript text, and a node sees no other node. The untrusted mode of the spec (no secrets on the node, a proxy on the master that adds keys) is stage 2.

## 11. Install, update, revoke

### 11.1 A server by its password or key

Settings, "Devices...", "Add a server". The flow is "Set up the server"'s, with a plan of its own: log in once (the password in memory only, through the askpass listener; the host key pinned at first sight and shown), Look, a plan in plain words, Apply, undo of a failed step, a record, Undo later. Steps:

1. Two users. `agent-board`: a login user with a home, lingering enabled, who owns herdr, the agents and the work, under the slice ceiling of step 9. `agent-board-link`: a system user without a shell, fenced in an sshd drop-in to one thing, a forward to `127.0.0.1:12430` (`restrict,port-forwarding,permitopen=...` on its key, `ForceCommand /bin/false`, `PermitTTY no`, `AllowTcpForwarding local`, no stream-local forwarding).
2. Packages: git, curl, unzip, ca-certificates, and gh where the system's own repositories have one this board can use (2.17 or later, for `gh auth token`: Debian 12 and 13, Ubuntu 24.04 to 26.04; Ubuntu 22.04 has 2.4; no third-party repository, #609). Behind a tick in the plan, like Docker today. Where gh is not to be had, the plan says so.
3. Bun at a pinned version, for `agent-board`.
4. herdr at a pinned version (0.9.5 or newer, for `--env`) and its user unit.
5. Claude Code by its own installer; pi when ticked.
6. The plugin, sent from the master: the master's own checkout at its commit as one archive over ssh's stdin (the way the backup drop exchanges bytes, `src/adapters/backup-ssh.ts:61`), then `bun install --production` and `herdr plugin link`. The node needs no access to the repository, and its code is the master's code.
7. config.json with `node`, and `masters.json` with the hash of a token the master made. Only the hash crosses.
8. The board's install action (commands, hooks, skills).
9. A user unit that runs `herdr server`, restarted on failure. Nothing else is needed for the board: with the plugin linked, herdr's startup opens the Board workspace, whose process serves the web board and the door, and the Wake workspace (section 18). A drop-in for the user's slice (`MemoryHigh`, `MemoryMax`, `MemorySwapMax`, `CPUWeight`) gives everything the node runs a ceiling, so a session's test run cannot starve what else lives on the server; the plan proposes figures from the server's memory and what is free of it at Look.
10. The check: through the link user, `/api/hello` answers with `node.api: 1`.

Then the master writes the device into `nodes`, starts the link, takes the first status, writes the default thresholds, sends the bundle, and shows "Log in to Claude on server-1". The record is `/etc/agent-board-node/setup.json`; Undo removes what the run made and never the work folders unless ticked. Root is needed again only for Undo and OS packages; the plugin's updates ride the link.

### 11.2 A computer behind NAT by one command

Through the owner's server, with no VPN: section 20 has the design and 20.2 the steps. In short: "Add a computer" shows one pasted line for sh with a code that lives 10 minutes; the line installs for the current user without root (Bun, herdr, Claude Code, the plugin from the public repository at the master's commit, a systemd user unit or a launchd agent) and makes the board dial the server; the master sees it there, the panel shows the machine, and Approve claims it. Linux and macOS first; PowerShell and Termux in stage 3. This is slice E, after the server install.

The optional tailnet door (T14) pairs the same way with the Tailscale address in place of the server: the master asks each online tailnet peer's door port for its hello, as `peers()` already finds boards (`src/server/remote.ts:173-192`), and takes the one that carries the code's hash.

### 11.3 Update

The master ships its commit (6.2). herdr is never restarted for it: that would end every pane's process, the agents' too. The new code is put in place and the board's own pane restarts itself when the plugin's code changes (`src/entrypoints/run.ts`), which the hand-installed node did with its session still running. A node on another commit gets no new work until it matches. After the master's own update each node updates when none of its sessions is in a turn, or at once from the button. A node's sessions survive: the board's process restarts, herdr and the agents do not.

### 11.4 Pause, drain, revoke

- **Pause**: no new work. **Drain**: no new work, and the row says when its last session is done.
- **Revoke**, from the master: placement stops at that instant. If the node is reachable the master puts its sessions to sleep (`POST /api/sleep`) and calls `leave`, then deletes the token and the link key. Leaving, the node takes out what that master's bundles gave it and is still as they gave it (#609): the variables and secret files of #604, the GitHub logins (`gh auth logout`, or the stored credential and the helper it set) and the identity it set; what the owner gave or changed by hand stays. A node with two masters takes out only what the leaving one gave, by the master each record names (a record of before #609 is the one master's). If it is not reachable, the row stays as "revoked, not told yet" with the credentials kept for that one call, and "Forget now" drops them. On the node, `board node leave` does its half alone, the taking out included. On a server, Undo also removes the link user's key.
- A node does not freeze its sessions because the master is silent. A laptop master is silent every night.

## 12. What the owner sees

- **Cards.** A small device chip on a card that is not on this computer, in the identity row of #141. Nothing on a local card. A filter by device beside the profile filter, only when there is more than one device.
- **An offline node.** Its cards grey, with "as of 8 min ago". Actions on them answer "server-1 is not reachable" the way stale data does today.
- **A node card's actions.** All of the sheet: conversation, answer, permission, Stop, Send now, sleep, wake, restart, rename, move, archive, fork, files, the terminal. Not offered, as on a phone: open in the file manager, focus the herdr pane, a MokuPilot call.
- **New session.** Nothing new by default. "Where" under "More". While the board decides or waits, the launch card says "choosing a device", "syncing the profile to server-1", "cloning on server-1", "waiting for room".
- **Settings, "Devices...".** The devices in order, dragged to reorder. Per row: name, system, online, a bar of sessions and memory against its thresholds, the plugin's and the bundle's version, and the device the next start would go to marked. Buttons: Add, Pause, Drain, Update, Doctor, Give a secret, Revoke.
- **Lanes that may leave this computer.** In the same panel, a tick per lane, the lane's own colour beside it, and "All". Nothing is ticked at first; adding the first device opens this list once. A lane an agent adds later is unticked and the panel marks it as new.
- **When everything is full.** One switch in the panel: start on this computer, or wait.
- **Phones** see the same merged board through the master. The Android app must ignore the fields it does not know; that is checked before the first release (section 18).

## 13. Modules and files

New, by layer (the repository's layering: `README.md`, Development):

| File | Holds |
|---|---|
| `src/core/nodes.ts` | `nodesConfig`, `nodeConfig`, device ids, the key prefix (`nodeKey`, `parseNodeKey`), default thresholds, the device view for the payload. |
| `src/core/node-door.ts` | The door's allowlist as data, and its refusals. |
| `src/core/placement.ts` | `place()`, room, reservations as values. |
| `src/core/portable.ts` | The portability rule and its reasons; finding paths in a brief. |
| `src/core/bundle.ts` | The manifest, the hash, classifying settings, hooks and MCP servers, what the node owns. |
| `src/core/git-access.ts`, `src/adapters/git-access.ts`, `src/services/node/git-access.ts` | The owner's git identity and GitHub login (#609): what travels and the node's steps; git and gh run; the node's side, its record and leaving. |
| `src/core/node-plan.ts`, `src/core/node-texts.ts` | The install's Look additions, steps, record, Undo; the units and the sshd block. |
| `src/core/node-oneshot.ts` | The pasted line for a computer. |
| `src/core/relay-plan.ts`, `src/core/relay-texts.ts` | Slice E: the relay's setup on the server (users, the sshd blocks, the keys command, the enrol script), its record and Undo. |
| `src/services/nodes/relay.ts`, `src/services/node/relay-dial.ts` | Slice E: the master's forward to a node's socket and the enrolment; the node's `ssh -R` kept up by the tunnel's supervisor. |
| `src/adapters/door-cert.ts` | Slice E: the door's certificate and the master's pin. |
| `src/core/i18n/node-strings.ts` | The words, English and Russian. |
| `src/adapters/node-store.ts` | `masters.json` on a node (a list); a device's token, snapshot and bundle record on the master. |
| `src/adapters/node-queue.ts` | `queue.json`. |
| `src/adapters/sysload.ts` | Memory available, load, cores, per platform. |
| `src/adapters/bundle-files.ts` | Walking a profile folder, blobs, backups. |
| `src/adapters/node-ssh.ts` | The `ssh -L` line and its pid record per device, on the tunnel's ssh adapter. |
| `src/services/nodes/link.ts` | One device's link: fetch, the payload stream, liveness, backoff. |
| `src/services/nodes/aggregate.ts` | Remote items into the payload, the offline copy. |
| `src/services/nodes/placer.ts` | Status cache, reservations, the queue, the call to `place()`. |
| `src/services/nodes/bundle-sync.ts` | Build, diff, send, commit. |
| `src/services/nodes/uplink.ts` | Calls from nodes: the allowlist, running the command, files. |
| `src/services/nodes/setup.ts` | Look, Apply, Undo for a server; join codes and claim for a computer. |
| `src/services/node/status.ts`, `launch.ts`, `bundle.ts`, `uplink.ts`, `update.ts` | The node's side of each new route. |
| `src/server/node-listener.ts` | The door. |
| `src/server/routes/node.ts` | `/api/node/...` on the door. |
| `src/server/routes/nodes.ts` | `/api/nodes` for the panel (this computer and the owner's login only). |
| `src/server/routes/node-proxy.ts` | Requests for `@<device>:` keys. |
| `web/src/components/devices/`, `web/src/models/devices.ts`, `web/styles/nodes.css` | The panel, the chip, the filter. A sheet of its own: the upstream sheets are pinned by `styles.test.ts`. |
| `test/support/node-pair.ts` | Two or three sandbox boards with fake herdrs, one as master, linked by `direct`. |

Changed, each behind its key:

| File | Change | Gate |
|---|---|---|
| `src/server/app.ts` | Start the door; start links, the placer and the proxy; put the proxy first in the route list. | `node`; `nodes` |
| `src/server/board-state.ts` | `publish` adds remote items and `devices`; `findAny(key)` beside `find`. `items()` and `find()` stay local. | `nodes` |
| `src/core/payload.ts`, `src/core/types.ts` | `BoardPayload.devices?`, `Item.device?`, launch state `queued` and the new steps. | absent without `nodes` |
| `src/services/launch/launches.ts` | Ask the placer after `checkRequest`. | `nodes` |
| `src/services/launch/launcher.ts`, `spawn-agent.ts`, `src/core/resume.ts` | An env map beside `CLAUDE_CONFIG_DIR`. | `node`, and the profile's env file exists |
| `src/entrypoints/spawn-agent.ts` | Ask the local board first. | `nodes` |
| `src/entrypoints/thread-cli.ts`, `time-cli.ts`, `cal-cli.ts` | On a node: forward (threads) or say it is not available here (time, calendar). | `node` |
| `src/services/scheduler.ts`, `src/services/actions.ts` | Delivery to a key of another device goes through the proxy. | the key's prefix, which exists only with `nodes` |
| `src/entrypoints/cli.ts` | `board nodes`, `board node`, `board doctor --node`. | new subcommands |
| `src/adapters/config-file.ts` | `editNodes`, refusing a file that does not parse (#167). | new writer |
| `web/src/components/Card.tsx`, `Toolbar.tsx`, `launch/LaunchDialog.tsx`, `LaunchCard.tsx`, `sheet/SheetHead.tsx` | The chip, the filter, "Where", the new launch steps, actions hidden for a node card. | `item.device`, `payload.devices` |
| `skills/herdr-agents/SKILL.md`, `README.md` | How a worker becomes placeable; a "Devices" section. | text |

Not changed at all: `src/entrypoints/hook.ts` and the status line (the path of every prompt of every session), the hub, Team, the phones' listener and pairing, the tunnel, wake's process.

## 14. Stage 1 as tasks with tests

Stage 1 is the session node for Linux and macOS: see, drive, place, sync, install, and reach a machine behind NAT. Five slices, each usable when it lands. Sizes: S is one pull request under about 300 changed lines with its tests, M one of 300 to 900, L more than one pull request.

Every task follows AGENTS.md: an issue first, a new test that fails on `main` and passes with the change, tests for the setups it must not touch, `bun run test` and `bun run check` before the pull request. Tests run on sandbox boards with fake herdrs and ports of their own; none touches this computer's herdr, its Claude folders, 12421 or 12422. The waits a test would sit out get knobs through `src/adapters/pacing.ts`: `BOARD_NODE_DEAD_MS`, `BOARD_NODE_STATUS_MS`, `BOARD_NODE_RESERVE_MS`, `BOARD_NODE_QUEUE_MS`.

### T0. Find out what the plan could not read from the code (no code in main)

On a throwaway Debian 13 server and a Mac, by hand, written up in the umbrella issue:

- herdr as a service with no terminal attached: its install command, the unit, `herdr api snapshot`, `tab create --env`, `plugin link`, `integration install claude`.
- Claude Code there: the login by link in a pane, `--session-id`, the trust dialog under `--trust`, whether a `${VAR}` in a user-scope MCP server is filled from the environment, whether an enabled plugin installs itself.
- From Windows: `ssh -N -L` as a user fenced with `permitopen` and `ForceCommand /bin/false`, and an event stream held through it for an hour.
- For slice E: `ssh -N -L <port>:<unix socket>` from Windows' own OpenSSH; sshd's `AuthorizedKeysCommand` on Debian 13 and Ubuntu; Bun's `fetch` and an event stream against a self-signed certificate given as its `ca`.
- The ten commands of a node installed by hand, kept in the issue: slices A to C are tried on a real server with them, before the installer exists.

Anything that turns out otherwise changes the task that depends on it before that task starts.

### Slice A: a node's cards on the board, and every action from them

**T1. The config and the keys (S).** `src/core/nodes.ts`.
Tests: `nodesConfig` and `nodeConfig` on good and bad input, unknown keys, a missing key giving null; `nodes.id` given and derived from odd host names; `nodes.lanes` absent (none), a list, `"all"`, a lane that no longer exists; the order with `local` absent; default thresholds for 2, 8 and 32 GB; the key prefix both ways for a session id, `pane-12`, a Windows path, a POSIX path, a name with spaces, Cyrillic and `%`; no local key shape parses as a prefixed one.

**T2. The door, the status, the store (M).** `node-listener.ts`, `node-door.ts`, `node-store.ts`, `sysload.ts`, `services/node/status.ts`.
Tests: every route of the board's table is classified, and the test fails when a new route is added unclassified; refusals by path as it came and decoded (`/api/fs/%6Fpen`, `/api/%72emote`); no token, a wrong token, the rate limit; a request with an Origin; a wrong Host; a stream ends within the paced limit after the master is forgotten; status from fixtures of `/proc/meminfo`, `vm_stat` and the Windows answer. The store is a list: two masters with a token each both get in, and forgetting one ends only its streams. A board with both `node` and `nodes` serves its door and holds its links at once (21.3). Without `node`: the port is not bound, and `/api/hello` on the local board is byte for byte `main`'s.

**T3. The link (M).** `services/nodes/link.ts`, `node-ssh.ts`.
Tests on `test/support/node-pair.ts`: the master receives the node's payload; silence past the limit marks it offline and the last payload stays; it comes back and resumes without a second stream; backoff grows and resets; the ssh line and its pid record against the fake ssh (`BOARD_SSH_BIN_PATH`); a wrong host key refuses. Without `nodes`: no ssh is started, no timer exists (the process's handles are counted).

**T4. The aggregate (M).** `aggregate.ts`, the seam in `board-state.ts`, `payload.ts`, `types.ts`.
Tests: items of two nodes and the local ones in one payload, each remote one with its prefix and device; `pane-1` on three devices stays three cards; the node's launches and schedules ride along; a field of a remote item that is not what the type says is dropped, not passed on; `items()` and `find()` return local items only, shown by running the scheduler, auto-compact and `observeWorkdesk` against a master with a node attached and asserting the fake herdr of the master saw no call for a remote key; the offline copy is read after a restart. Without `nodes`: the payload equals `main`'s for the same sandbox, field for field.

**T5. The proxy (L: actions and sheet; terminal and files).** `routes/node-proxy.ts`, `findAny`, the scheduler's delivery.
Tests: each session action from the master reaches the node and acts on the node's fake herdr; the sheet's reads; the bulk routes split by device; the terminal's stream carries the node's bytes with the master's file token outside and the node's inside, and ends on revoke; a file chip previews a node's file; `/api/fs/open` and `/api/reveal` for a node key answer 403 `desktop`; an upload lands in the node's uploads and the message carries the node's path; a secret form's answer writes the node's sink; an offline node answers 503 `node-offline`; a paired phone's refusals apply before the proxy; a key spelled `%40server-1%3A...` routes the same. Without `nodes`: the route list has `main`'s length and order.

**T6. The page (M).** The chip, the offline look, the filter, hidden actions, strings.
Tests: rendered fixtures with and without `device`; the existing parity tests stay green, which shows a board without nodes draws as before; the phone width.

After slice A, with a node installed by hand: its sessions are on the board and can be worked from it. That alone is worth having on server-1.

### Slice B: the board places

**T7. Placement and portability, pure (M).** `placement.ts`, `portable.ts`, the git facts.
Tests: the 3, 3, 1 run of 8.2; seven starts inside one status age; the memory gate, with its return threshold; a device with no load average; offline, paused, draining, another commit; a pin to a device and to a tag; `whenFull` both ways, by hand and not; a lane ticked, unticked, `"all"`, and no `lanes` at all (nothing leaves); `refuse` when nothing fits. Portability: no remote, changes in the tree, commits not pushed, a new worktree from a pushed and from an unpushed branch, a brief naming a scratchpad path in Windows and POSIX form, a brief naming a path that does not exist (allowed).

**T8. The placer and a start on a node (L).** `placer.ts`, `node-queue.ts`, the seam in `launches.ts`, `services/node/launch.ts`.
Tests on a master with two nodes: seven starts end 3, 3, 1 on the three fake herdrs; the same `id` posted twice is one session; a node answering `full` sends the start to the next device; a node that drops between the decision and the answer puts the start back in the queue, and one that acknowledged keeps it; the queue drains when a node's session goes to sleep; the queue is there after the master restarts; Cancel removes an entry; a repository missing on the node is cloned (a local bare repository as the remote), a checkout with changes answers `repo`. Without `nodes`: `launches.start` runs no git command and no fetch (both spied), and the tab is created with `main`'s arguments.

**T9. `spawn-agent` through the placer (S).**
Tests: with `nodes` and the board up, the start is the board's and the printed line names the device; with the board down, and without `nodes`, the line and herdr's calls are `main`'s; the board's own launcher, which runs `spawn-agent` as a child, does not come back to itself.

### Slice C: the node is equipped like the master

**T10. The bundle (L: classify and build; apply).** `bundle.ts`, `bundle-files.ts`, `bundle-sync.ts`, `services/node/bundle.ts`.
Tests: the classification table of 9.1, one case per row and per verdict, from a Windows profile to a Linux node and from Linux to Linux; the hash is the same whatever order the files are walked in; apply touches only what it owns, keeps a foreign file and says so, removes a file it owned, makes one backup folder per commit, writes nothing when `settings.json` or config.json does not parse, changes nothing the second time; the board's hooks on the node name the node's Bun and folder afterwards; a start waits for a sync and then goes.

**T11. Secrets on a node (M).** The sinks in the board's slice, `/api/node/sink`, the env map.
Tests: a canary value typed into the master's form is in the node's sink file and nowhere under the master's state folder, its log or its payload (the folders are searched for it); "Give a secret" the same; a session started and one resumed on the node have the env file's variables in the fake Claude's environment. Without `node`: a launch's and a resume's environment and arguments equal `main`'s.

**T12. Threads from a node (M).** The outbox, the uplink, the forward in `thread-cli.ts`.
Tests: a post from a node's session is in the master's database under the node session's key and lane; a `--file` report arrives in the master's uploads; with the master away the post waits and is delivered once after two reconnects; a read fails at once with the reason; a command off the allowlist is refused on the master whatever the node sends; a thread notice from the master is typed into the node's fake herdr. On a board without `node`, `board thread` opens the database as on `main`.

### Slice D: one button

**T13. A server by its password (L).** `node-plan.ts`, `node-texts.ts`, `nodes/setup.ts`, the panel's Add.
Tests: the plan's steps on the fake root (`test/support/fake-root.ts`), each with its check and undo; a failed step rolls back; Undo removes what the record lists and nothing else; a second Apply changes nothing. Behind `BOARD_SERVER_IT=1` on the existing Docker servers (Debian 13, Ubuntu 24.04 and 26.04): Apply, then hello through the link user; the link user can open nothing but the door's port; the password is in no file on either side (both file systems are searched for it). The items of #166 that concern the runner are fixed first.

**T14. The tailnet door (S, optional).** Only if a machine behind NAT is wanted before slice E; otherwise not built.
Tests: the door on the Tailscale address refuses a caller whose Tailscale node is not the master's (the fake tailscale); claim by code as in T18.

**T15. The panel whole, doctor, update, revoke, the audit (M).**
Tests: the order is saved by drag and by `board nodes order`; revoke stops placement at once, the node's sessions sleep, the token is dead and the stream ends inside the paced 5 s; revoke of an unreachable node keeps the credentials for the one call and "Forget now" drops them; an update ships, the node comes back on the new commit and its sessions' panes were never closed; doctor's text from fixtures; every audit line is free of values.

### Slice E: a machine behind NAT, with no VPN

Section 20 is its design.

**T16. The relay on the server (L).** `relay-plan.ts`, `relay-texts.ts`, Look, Apply and Undo over the admin connection.
Tests on the fake root: the two users and their sshd blocks, the sockets' folder and its rights, the keys command, the enrol script (adds a key, removes one, refuses anything else, refuses a key that is not a key); Undo; a second Apply changes nothing; the server's other sshd blocks, the tunnel's among them, are byte for byte what they were. Behind `BOARD_SERVER_IT=1`: a node user can make a socket forward and nothing else, a master user can open a socket and nothing else, neither gets a shell or a TCP forward.

**T17. The relay pipe and the pinned door (M).** `nodes/relay.ts`, `node/relay-dial.ts`, `door-cert.ts`.
Tests: the node's `ssh -R` line and the master's `ssh -L` line against the fake ssh; the link works through a stand-in relay (two sandbox boards and a socket); the door with `tls` answers only over HTTPS; a door that answers with another certificate is refused and the device's row says so; the supervisor on the node restarts its ssh as the tunnel's does. Without `relay` keys: no ssh, no certificate file.

**T18. A computer by one command (M).** The pasted line, the code, enrolment, claim.
Tests: a wrong code, a dead code, five wrong codes, a second claim; a key enrolled and not claimed in 10 minutes is removed from the server; the pasted script under dash and sh as the one-shot's end-to-end tests run theirs; the paste holds no token of the master's.

Order: T0, then A (T1 to T6), then B and C in either order or side by side, then D, then E. T13 touches none of A to C and can run beside them once T2 fixes the door's port and token file.

After stage 1: the browser node and forwarding of the master's MCP servers, tags and `needs` in the panel, Team, time and calendar from a node, Workdesk per device, the untrusted mode (stage 2); Windows and Termux installers, moving a sleeping session between devices (stage 3); a standby master, section 21 (its own stage).

## 15. The browser node is not cheaper first

The spec offers to do the browser node before the session node "because it is smaller and unloads the master at once". Neither half holds on what was found.

- **It unloads nothing today.** The reading of 4.4 found no browser started for automation; memory went to what sessions run, to the Claude processes and to shells.
- **It is not smaller.** It needs the install, the link, the door and the status of slices A and D anyway, and then three things nothing in the board does yet: starting and reaping browsers with a lease per session, a gateway for the DevTools protocol through the link (HTTP and a WebSocket; the link has no WebSocket in stage 1), and writing an MCP config into a session at launch and at resume (`--mcp-config`; no writer exists). The session node reuses the board's routes; the browser node is mostly new code.
- **It can be tried in ten minutes without the board**, which is the right way to learn whether it is worth building. On the server: `chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/b1`. On the laptop: `ssh -N -L 9222:127.0.0.1:9222 <server>`. In one project's `.mcp.json`: the DevTools MCP server pointed at `http://127.0.0.1:9222`. If a day of real work that way shows the gain, the stage 2 design is: `browser: { max }` on a device, a lease per session (`POST /api/node/browser/lease`), named browser profiles given to one session at a time, the gateway under the door, the address put into the session's MCP config by the launch.

Sessions first, then the browser on the same link.

## 16. Acceptance criteria for stage 1

The spec's list, kept where it holds and corrected where the code says otherwise (marked "changed").

1. A clean Debian 13 server becomes a node from one form: address, password, Apply. The password is in no file on the master or the node.
2. Order `server-1, server-2, local`, the servers at `maxSessions: 3` with memory to spare. Seven New session clicks with nothing chosen, in a repository that is pushed: 1 to 3 on server-1, 4 to 6 on server-2, the seventh on this computer, or waiting with `whenFull: "wait"`.
3. Changed: the same seven clicks in a folder with unpushed changes all start on this computer, and each card says why. The same in a lane that is not ticked in "Lanes that may leave this computer", whatever its folder; with no lane ticked, nothing ever leaves.
4. Changed: with server-1 below its free-memory threshold and under its session count, the next start goes to server-2.
5. A session started on a node is on the board within 5 s. From its card: answer a question, a permission, Stop, Send now, sleep and wake, the terminal, a file's quick look, a file sent with a message.
6. Changed: a session on the node has the master's skills and every portable hook and MCP server. `board doctor --node` lists every difference with its reason and fix, and none is unexplained. (The spec asked for zero differences.)
7. Changed: a secret's value is in the node's sink and nowhere in the master's files, logs or payload, and in no transcript or card on either side. (The spec asked that an agent on the node cannot read it; with a sink on the same machine and user that is not so, on the master either.)
8. A worker on a node posts to its thread with `board thread post` and its master on the laptop gets the one line. With the laptop closed the post waits and arrives once.
9. The node's network is cut: after 90 s its cards are grey with their age. The network returns: everything is live again with no hand on it and no session started twice.
10. Revoke on the master: nothing more is placed there, and within 5 s its sessions sleep and its token is dead.
11. The laptop sleeps for an hour: the node's sessions kept working, their own reminders fired, and the board shows the present state within 10 s of the lid opening.
12. Slice E: a Mac behind NAT with no Tailscale becomes a node from one pasted line and an Approve. On the owner's server nothing but sshd is involved, no service of his is changed, and a capture of the forwarded bytes there shows no request in the clear.
13. Without `nodes` and `node` in config.json the board behaves as on `main`: the whole suite is green, and the comparisons of section 17 show the same payload, route list, launch arguments and environment.

## 17. How the change stays out of every other setup

AGENTS.md asks that a change for one setup leaves every other on the code path it had. For this feature:

- **Two keys gate everything.** `nodes` on a master, `node` on a node (and `relay` inside each for slice E). Without them: no listener, no ssh, no timer, no file under the state folder, no route in the list, no field in the payload, no git call in a launch, no fetch in `spawn-agent`. Each of these is a test named in section 14 ("Without ...").
- **The path of every prompt is not touched.** `hook.ts` and the status line do not change in stage 1 and gain no call.
- **The local item list stays local**, so every consumer that acts through local herdr (the scheduler, auto-compact, wake, Workdesk, the links, the profile and model warnings) runs on the same input as before, nodes or not.
- **Comparisons to show in the pull requests**, old against new on the same sandbox: the payload for sessions keyed by a Claude id, by `pane-<id>` and by a pi file path on Windows and POSIX; the route list; the arguments and environment of a tab created for a default profile, a second profile, pi, and a profile with a start command; `board thread`, `board doing` and `spawn-agent` output; names with spaces, other alphabets and `%`.
- **Who it is for**: owners who add a device. **Who it leaves alone**: one computer with Claude Code alone, pi and Claude through pi's bridge, several profiles, herdr-wake still in place, MokuPilot, phones, the tunnel, Team.
- **Windows as a node** is stage 3, but Windows as the master is the first setup: every test of the master's side runs on Windows, with Git Bash where the suite needs it.

## 18. What was not verified

- Line numbers come from six read-only passes over `ee32fc89`. The seams the plan depends on were read again by hand: `launches.start`, the refresh and `find` in `board-state.ts`, `remoteRefusal`, the route list and the local listener in `app.ts`, `thread-cli`'s and `time-cli`'s database access, `server.ts`, `herdr-plugin.toml`, the launch request's checks. The rest are as reported.
- Tried on a server (Ubuntu 24.04, 2026-11-21), as T0 asked: herdr 0.9.5 installed for an unprivileged user by its own script, `herdr server` under a systemd user unit with lingering on, the plugin cloned and linked with `herdr plugin link`. After a restart of that unit, with no client attached, herdr ran the plugin's startup entries: the Board workspace (its process listens on 127.0.0.1:12422) and the Wake workspace (12421). The board's install action and `board doctor` passed there; doctor's one complaint, the missing herdr key, means nothing on a node and T15 leaves it out for a board with a `node` key. herdr, the board and wake together held about 150 MB. So a node needs no unit of the board's own.
- Tried against that node from a sandbox master on the owner's computer, as each task merged: the door (status, payload, the event stream, and its refusals of a wrong host, a browser's Origin, a wrong token and a route off its list); the link, both as `direct` through a forward and as `ssh` with the fenced link user, its own key and the pinned host key; the node's card in the master's payload with its prefix; the card's sheet and its terminal's real screen through the proxy; an update of the node without a herdr restart, its session surviving; `POST /api/node/launch` refusing with `profile` while Claude is not logged in there.
- Found by those checks and fixed in their tasks: the door took a Host only with its own port, so a forward on any other local port was refused (now a loopback name with any port); the default door port can be taken on a machine (it is on the owner's laptop, by another program), which the link does not mind since its local port is picked free.
- Inside the unit tests' sandbox Windows' ssh exits before it connects (the sandbox's stripped environment; the same arguments work outside it). The ssh pipe therefore needs its test on the Docker servers with T13's second part, not in the unit sandbox.
- Still not tried there: Claude Code's login by link, which needs the owner, a start that runs to a working session, and an event stream held for an hour.
- Whether Claude Code fills `${VAR}` in a user-scope MCP server and installs enabled plugins by itself. If not, 9.1's rows for those become "reported, set up by hand".
- The Android app's tolerance of a `device` field and prefixed keys (another repository).
- For slice E: a forward to a unix socket from Windows' OpenSSH, `AuthorizedKeysCommand` on the supported systems, and Bun's `fetch` with a pinned self-signed certificate over a long event stream. The repository already gives a `ca` to a `fetch` (`src/adapters/workdesk-events.ts:128`); the rest is in T0.
- The memory reading is one moment of one night.
- No test was run and no code was written for this plan.
- Read since, without a server: herdr 0.9.5 has `herdr server` (a headless server) and can forward an API command to a saved ssh machine (`herdr --machine`), which never installs or starts anything there; the design still goes through the node's board (4.1). Claude Code's documentation says `${VAR}` expands in user-scope MCP servers too (in `command` and `args` only with a default), that a marketplace named in settings is cloned and its enabled plugins fetched in the background after the start, and that a login without a browser goes by a copied address and a pasted code. Its native install updates itself; a node sets `DISABLE_AUTOUPDATER`.

## 19. The issues

The umbrella is #496. Tasks: T1 #497, T2 #498, T3 #499, T4 #500, T5 #501, T6 #502, T7 #503, T8 #504, T9 #505, T10 #506, T11 #507, T12 #508, T13 #509, T15 #510, T16 #511, T17 #512, T18 #513; T14 has none until it is wanted. Designs for later: the browser node #514, forwarding the master's MCP servers and commands #515, a standby master #516. What section 3 names meets them at #141, #166, #167, #275, #296, #428, #450 and #486.

## 20. Machines behind NAT without a VPN

The owner accepts Tailscale for now and does not like it. This is the way without it, and what it costs next to Tailscale.

### 20.1 The shape

```
 node behind NAT                    the owner's server                     master
 ┌──────────────┐   ssh -N -R       ┌────────────────────┐   ssh -N -L     ┌──────────────┐
 │ door, HTTPS  │ ────────────────▶ │ sshd               │ ◀────────────── │ link client  │
 │ 127.0.0.1    │  <socket> leads   │ /var/lib/agent-    │  <port> leads   │ pins the     │
 │ :12430       │  back to the door │ board-relay/*.sock │  to <socket>    │ door's cert  │
 └──────────────┘                   └────────────────────┘                 └──────────────┘
```

- **The node dials the server** and asks it to listen on a unix socket that leads back to the node's door. This is what the board does today for its domain (`ssh -N -R <socket>:127.0.0.1:<port>`, `src/core/tunnel.ts:198-219`), kept up by the same supervisor (`src/services/tunnel.ts:224`), now running on the node.
- **The master dials the same server** and forwards a local port to that socket (`ssh -N -L <port>:<socket>`). From there the link is the HTTP of section 6, unchanged.
- **The server needs sshd and nothing else.** No web server, no domain, no port but ssh's, no process of the board's. It can be the server that already fronts the board's domain, or any node with a public address (server-1 itself). The tunnel's user, socket and web server are not touched: the relay has its own users and its own folder.
- **On the server**, set up once through Look, Apply and Undo (T16):
  - a folder for the sockets, mode 2750, as the tunnel's is (`src/core/tunnel-snippets.ts:29`);
  - a user for nodes that may make remote socket forwards and nothing else: the tunnel user's sshd block as it is (`src/core/tunnel-snippets.ts:85-105`: `AllowStreamLocalForwarding remote`, `StreamLocalBindUnlink yes`, `StreamLocalBindMask 0117`, `ForceCommand /bin/false`, no TTY);
  - a user for masters that may make local socket forwards and nothing else (`AllowStreamLocalForwarding local`, `AllowTcpForwarding no`, `ForceCommand /bin/false`), in the folder's group, which the bind mask already lets open the sockets.
- **Adding a node needs no root.** sshd reads the node user's keys from an `AuthorizedKeysCommand` that prints the key files of one folder. The master has a second key on the server whose only command is a script that adds or removes a file there, the way the backup's key can run only its drop script (`src/core/backup-server.ts:55, 77`). Root is needed once, for the setup.
- **The server cannot read the link and cannot stand in for a node.** For this pipe the door speaks HTTPS with a certificate made on the node at install, and the master pins it (the repository already gives a `ca` to a `fetch`, `src/adapters/workdesk-events.ts:128`). sshd has no way to bind one key to one socket name, so a node that turned hostile could take another node's socket name. With the pin that makes the other node unreachable and its row say "server-2 answers with another certificate"; it does not get the master's token, a bundle or a secret.

### 20.2 Adding a computer

1. "Add a computer" on the master: it makes a key pair for the node's dial, a socket name and a code that lives 10 minutes, and enrols the public key on the server through its forced command.
2. The pasted line carries the server's address, port and host key, the node's dial key, the socket name, the code and the master's commit. It installs for the current user, writes config.json with `node` (`tls` and `relay`), makes the door's certificate and starts the board, which dials the server. The plugin comes from the public repository at that commit; a master on a commit that is not published brings the node to it afterwards through the link's update (6.2).
3. The master forwards to the socket and reads the door's hello, which carries the certificate's fingerprint and a proof made from it with the code (an HMAC). The master checks the proof with the code it holds, pins the certificate, and only then shows the machine with Approve. Whoever answers on that socket without the code cannot pass.
4. Approve: the master claims over the pinned connection and gets its token once.
5. A key enrolled and not claimed in 10 minutes is removed from the server. The dial key in the paste is good for one thing, a socket forward on that server.

### 20.3 What it costs next to Tailscale

| | Tailscale | Through the owner's server |
|---|---|---|
| On each machine | The Tailscale app, signed in to the tailnet | Nothing: the ssh client the system has |
| A third party | Tailscale's service and an account | None |
| What must exist | A tailnet | A server of the owner's with sshd. He has one |
| Code to write | One small task (T14): the door on the Tailscale address and the whois check | Three tasks (T16 to T18), one of them large: the server's setup with Undo, the two ssh lines on the tunnel's supervisor, the pinned certificate, the enrolment. In size, about the backup drop's server part plus a second user of the tunnel's supervisor |
| The bytes' way | Usually straight between the two machines | Always through the server, two ssh legs. The terminal asks at most every 120 ms and the board sends a payload on change, which a server in the same region carries; a far one adds its round trip to every action |
| When it is down | No new connections while Tailscale's service is down | Nodes behind NAT are out of reach while the server is down. They keep working, and servers reached directly are not affected |
| Who can read on the way | Nobody | Nobody, with the pinned certificate |
| Load on the server | None | The forwarded bytes: payloads, terminal text, now and then a bundle. No processor time to speak of |
| What else it gives | | The way to reach the laptop as a node from a server, which a standby master needs (section 21) |

Recommendation: build the relay as slice E, right after the server install, and do not build the tailnet door unless a machine behind NAT is needed before then. In the setup the owner named (two servers and the laptop as the master) stage 1 needs neither: the master reaches both servers by ssh directly.

## 21. Last man standing: any device can become the master (a later stage)

The owner's wish: when the master is gone, another device takes its place. Not in stage 1. This section says what the later stage has to add and what stage 1 does so that it stays possible.

### 21.1 What the master holds, by how hard it is to hand over

| What | Where it lives | To hand it over |
|---|---|---|
| Sessions, cards, their reminders, sleep and wake | Each node | Nothing: every node runs without a master from stage 1 on |
| The merged board, every card's actions, the phones' view | The master's process | A second board with links to the others does it at once: the aggregate and the proxy keep no state |
| The device list, order, thresholds, lanes | `nodes` in config.json | Small. Sent to each standby when it changes |
| The right to call a node | A token per node, on the master | Each standby gets a token of its own on each node. One is never shared |
| The queue | `queue.json` | Each entry names the master that accepted it |
| The bundle's source | The master's profile folders | A node holds the last bundle by hash and a standby can pass that one on. It cannot make a new one |
| Threads, time, calendar | The master's SQLite file | The hard part: one writer. It needs replication or a home that moves, a design of its own. Until then posts wait in the nodes' outboxes, as they do in stage 1 when the laptop is closed |
| The Team identity, the phones' pairing, the domain | The master | Stay with the home master. A hub identity cannot be on two boards: a second socket replaces the first (`hub/src/hub.ts:500-503`) |

### 21.2 The rule proposed for that stage

- `nodes.masters`: an ordered list of device ids. The first one alive is the master.
- A standby takes the role when it has not heard those above it for a set time. "Heard" does not need a direct line: every master calls every node, and a node says in its status which masters reached it in the last minute, so a standby learns through any node they share that the laptop is still there. It gives the role back when a higher one returns.
- Two masters at once, in a split network, are made harmless instead of impossible: a launch's id makes a repeated start one session, each node checks its own floor before it starts anything, and a queue entry is started only by the master that accepted it, so a standby never starts the laptop's queue a second time.
- A standby aggregates, proxies, places new work and serves the phones. It does not take threads, Team, time or the calendar until those have their own design.
- From a server, the laptop is a node behind NAT: reaching it is section 20's relay.

### 21.3 What stage 1 does for it, at no extra cost

1. Roles are keys, not builds: a board may hold `node` and `nodes` at once, and the test harness has such a board (T2, T3).
2. A node's store of masters is a list from its first version, with one entry.
3. The master has an id of its own (`nodes.id`). `local` is only a word in its own order; a launch's parent, the audit and a queue entry name real ids.
4. The master dials. A node holds no address of its master, so another caller with a token of its own is nothing new to it.
5. Launches are known by ids the placer makes, and a queue entry says who accepted it.
6. Bundles sit on the nodes by hash.
7. A call to the master waits in an outbox addressed to "the master", not to a connection.

Not sized here. The standby reuses the aggregate, the proxy and the placer as they are; what it adds is sending `nodes` to the standbys, the takeover rule, the "who reached me" field in the status, and their tests. Threads that follow the master are a separate design.
