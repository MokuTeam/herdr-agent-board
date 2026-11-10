# agent-board hub

The small server that peer boards (#231) connect to. It does three things: it knows who the members
are (an ed25519 key and a name each), it keeps a queue of questions for members who are away, and it
tells members who is online. It is not part of the board and not in `herdr-plugin.toml`; run it
yourself, on one machine the members can reach.

It never reads the boards, the sessions or the herdr of anyone. A board that joins sends it signed
frames and gets signed frames back; everything else stays on the board.

## Run it

```
bun hub/src/main.ts [--dir D] [--listen host:port] [--allow-public] [--trust-proxy] [--keep-days N]
```

- `--dir` (default `~/.local/state/hab-hub`): the store (`hub.db`, SQLite in WAL mode) and the admin
  socket (`hub.sock`). The directory is made mode 0700. On Windows, 0600/0700 protect nothing; keep
  the directory where only you can read it.
- `--listen` (default `127.0.0.1:7443`): loopback and Tailscale addresses (100.64.0.0/10,
  fd7a:115c:a1e0::/48) are taken as they are. Any other address, the wildcard `0.0.0.0` included,
  needs `--allow-public`. The hub speaks plain `ws://`; on anything but loopback or a tailnet put
  TLS in front of it and use `wss://` in the boards' `team.hub`. Behind a reverse proxy on the
  same machine keep the default: the proxy reaches it on loopback (see "Behind a reverse proxy").
- `--trust-proxy`: a reverse proxy on this machine forwards to the hub. A connection from a
  loopback address is then taken to be the proxy's, and the log shows the rightmost entry of its
  `X-Forwarded-For` (the address the proxy saw) instead of 127.0.0.1. Only an IP literal counts,
  and only from loopback; the address goes to the log and nowhere else.
- `--keep-days` (default 90, at least 8): how long finished rows are kept, see "What it keeps". Below
  8 the hub refuses to start: a message lives up to 7 days, and its id must stay known for as long
  as the sender may send it again.
- SIGINT and SIGTERM stop it cleanly. Two systemd units are here: `hab-hub.service`, a user unit
  for a tailnet, and `hab-hub.system.service`, a system unit for a server behind nginx. There is
  no launchd one.

No hub identity is pinned in this version: a board trusts the address it was given. Keep the hub on
loopback or a tailnet, or behind TLS with a certificate for its name: over `wss://` the board
checks the certificate as a browser does, and refuses one it cannot verify.

## Behind a reverse proxy

On a server of your own with a domain, the hub stays on loopback and a reverse proxy brings TLS:
the boards' hub is `wss://hub.example.com`, and no tailnet is needed. Two samples:

- `hab-hub.nginx.conf`: an nginx server block for `hub.example.com`. It passes `/v1` to
  `127.0.0.1:7443` with the WebSocket upgrade, sets `X-Forwarded-For`, keeps a connection for 300 s
  without a frame (a board pings every 30 s), redirects port 80 to https and serves nothing else.
- `hab-hub.system.service`: a system unit that runs the hub as a user of its own
  (`--listen 127.0.0.1:7443 --trust-proxy`), with its store in `/var/lib/hab-hub` and the rest of
  the system read-only to it.

The hub needs no `bun install`: it uses only Bun's and Node's own modules. Step by step, with the
certificate and the invites: "The hub's admin on your own server with a domain" in
[docs/team-quickstart.md](../docs/team-quickstart.md). Another proxy works the same way if it
upgrades WebSocket on `/v1` and puts the client's address last in `X-Forwarded-For` (Caddy does both
by default). Behind a second proxy (a CDN in front of nginx) the rightmost entry is that proxy's
address, not the member's.

## Invites and members

The admin commands talk to the running hub over the unix socket in `--dir` (mode 0600; whoever can
open it is the admin). They are never on the network.

```
bun hub/src/cli.ts [--dir D] invite create [--ttl 24h] [--note ".."]
bun hub/src/cli.ts [--dir D] invite list
bun hub/src/cli.ts [--dir D] invite revoke <id>
bun hub/src/cli.ts [--dir D] peers
bun hub/src/cli.ts [--dir D] revoke <peer-id|name>
bun hub/src/cli.ts [--dir D] prune
```

An invite code (`hab-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`, 120 random bits) is printed once, works once and
expires after `--ttl` (default 24 h). Only its hash is stored. Hand it to the member out of band.
`revoke` marks the peer revoked, closes its connection with 4403 at once, and sends the others a
roster without it; its name is free again. `prune` runs the retention pass now (below) and prints
how many rows it deleted.

## What it keeps

- Peers (members and revoked ones) are kept for good.
- A queue of messages. A message body is stored only while it waits: it is dropped when the
  recipient acks it or when it expires (`ttl_s`, 24 h by default, clamped to 60 s .. 7 days; a
  sweeper runs every 60 s). The hub keeps ids, sizes and states after that, not text.
  When the text leaves the disk: the row's payload is cleared at the ack or the expiry, and
  `secure_delete` makes SQLite overwrite the freed space with zeros. A copy can still sit in the
  write-ahead log (`hub.db-wal`) until it is checkpointed, so every retention pass (at start, hourly,
  and on `prune`) ends with `wal_checkpoint(TRUNCATE)`. So the text is gone from `hub.db` and
  `hub.db-wal` at the next pass after the ack or expiry, at most an hour later; until then it can
  be read from the files. Backups and snapshots made before that keep it, and so does disk
  free space that was written before `secure_delete` was on (this version's first run).
- An audit log whose rows are chained by hash (`prev_hash`, `hash`): joins, revokes, invites, sends,
  acks, expiries, prunes. Ids and counts only, never a body. There is no screen for it; read the
  `audit` table in `hub.db`.

Retention: once an hour (and on `prune`) the hub deletes what is older than `--keep-days`, counted
from when it ended. Acked and expired messages (from the ack, or the expiry time), presence events,
and invites that were used, revoked or have expired. Audit rows older than that go too, from the
oldest on; the hash of the last one deleted is kept in `meta` (`audit_anchor`) so the rest of the
chain still verifies. Queued and delivered messages, and peers, are never deleted. A pass that
deleted something is itself audited (`prune`, with counts).

Messages are `question` only, text up to 4000 characters, payload up to 16 KiB; the hub drops and
logs anything else. The signatures are the boards': the hub checks the sender's, and passes the
recipient's ack back unchanged, so the sender can check it against the key it pinned.

An envelope is `{ from, payload, sig }`: `payload` is the JSON text of the message exactly as its
sender wrote it, and `sig` is the sender's signature over it (with a prefix that says what it is
for). There is no canonical JSON for it: the hub checks the signature over the string as it came,
before it reads it, and stores and forwards that string as it is. Keys in another order, or a
single byte changed, fail the signature.

## Protocol

JSON text frames on `ws(s)://host:port/v1`, at most 64 KiB each. A connection is hello, challenge,
then auth (a known key) or join (an invite). Nothing is sent to a connection before it is
authenticated, not even the roster. A second connection of the same peer replaces the first (close
4409). Close codes: 4400 bad request, 4401 unknown or bad signature, 4403 revoked or bad invite. What
is signed, and the checks on it, are in `src/core/team.ts`, which the hub and the board both import.

Since #216 a board says in its `hello` what it understands (`caps`, today `["threads"]`); the hub
keeps that per member (the `caps` column, schema 2) and passes it on in the roster and with a
member's presence, so a board sends threads only to boards that read them. The hub relays a
message's body as signed: it holds `text` to its limits (1 to 4000 characters, the envelope to
16 KiB) and passes the other fields on without reading them, so a new body field needs no new hub;
each board checks what it acts on. The kind whitelist and the refusal of `to: "*"` stay: a team
message is one signed copy per member. The audit's `send` rows name the thread and `via` (the
sender's own signed words), never the text. Updating a hub is a restart on the new code: the
schema moves on by itself, and boards reconnect. An older hub refuses a database a newer one moved
on, so copy `hub.db` aside before the update if you may want to go back.

## Tests

`bun test test/hub test/core/team.test.ts`: real sockets on port 0, an in-memory store, a clock the
test moves. The admin socket test is skipped on Windows.
