# agent-board hub

The small server that peer boards (#231) connect to. It does three things: it knows who the members
are (an ed25519 key and a name each), it keeps a queue of questions for members who are away, and it
tells members who is online. It is not part of the board and not in `herdr-plugin.toml`; run it
yourself, on one machine the members can reach.

It never reads the boards, the sessions or the herdr of anyone. A board that joins sends it signed
frames and gets signed frames back; everything else stays on the board.

## Run it

```
bun hub/src/main.ts [--dir D] [--listen host:port] [--allow-public]
```

- `--dir` (default `~/.local/state/hab-hub`): the store (`hub.db`, SQLite in WAL mode) and the admin
  socket (`hub.sock`). The directory is made mode 0700. On Windows, 0600/0700 protect nothing; keep
  the directory where only you can read it.
- `--listen` (default `127.0.0.1:7443`): loopback and Tailscale addresses (100.64.0.0/10,
  fd7a:115c:a1e0::/48) are taken as they are. Any other address, the wildcard `0.0.0.0` included,
  needs `--allow-public`. The hub speaks plain `ws://`; on anything but loopback or a tailnet put
  TLS in front of it and use `wss://` in the boards' `team.hub`.
- SIGINT and SIGTERM stop it cleanly. There is no systemd/launchd unit here; write your own.

No hub identity is pinned in this version: a board trusts the address it was given. Keep the hub on
loopback or a tailnet.

## Invites and members

The admin commands talk to the running hub over the unix socket in `--dir` (mode 0600; whoever can
open it is the admin). They are never on the network.

```
bun hub/src/cli.ts [--dir D] invite create [--ttl 24h] [--note ".."]
bun hub/src/cli.ts [--dir D] invite list
bun hub/src/cli.ts [--dir D] invite revoke <id>
bun hub/src/cli.ts [--dir D] peers
bun hub/src/cli.ts [--dir D] revoke <peer-id|name>
```

An invite code (`hab-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`, 120 random bits) is printed once, works once and
expires after `--ttl` (default 24 h). Only its hash is stored. Hand it to the member out of band.
`revoke` marks the peer revoked, closes its connection with 4403 at once, and sends the others a
roster without it; its name is free again.

## What it keeps

- Peers, invites, and presence events (online/offline times).
- A queue of messages. A message body is stored only while it waits: it is dropped when the
  recipient acks it or when it expires (`ttl_s`, 24 h by default, clamped to 60 s .. 7 days; a
  sweeper runs every 60 s). The hub keeps ids, sizes and states after that, not text.
- An audit log whose rows are chained by hash (`prev_hash`, `hash`): joins, revokes, invites, sends,
  acks, expiries. Ids and counts only, never a body. There is no screen for it; read the `audit`
  table in `hub.db`.

Messages are `question` only, text up to 4000 characters, envelope up to 16 KiB; the hub drops and
logs anything else. The signatures are the boards': the hub checks the sender's, and passes the
recipient's ack back unchanged, so the sender can check it against the key it pinned.

## Protocol

JSON text frames on `ws(s)://host:port/v1`, at most 64 KiB each. A connection is hello, challenge,
then auth (a known key) or join (an invite). Nothing is sent to a connection before it is
authenticated, not even the roster. A second connection of the same peer replaces the first (close
4409). Close codes: 4400 bad request, 4401 unknown or bad signature, 4403 revoked or bad invite. The
canonical form that is signed is in `src/core/team.ts`, which the hub and the board both import.

## Tests

`bun test test/hub test/core/team.test.ts`: real sockets on port 0, an in-memory store, a clock the
test moves. The admin socket test is skipped on Windows.
