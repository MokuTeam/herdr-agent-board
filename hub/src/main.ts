// The hub: `bun hub/src/main.ts [--dir D] [--listen host:port] [--allow-public] [--trust-proxy] [--keep-days N]
// [--max-file-mb N] [--quota-mb N]`.
// It keeps its store, its admin socket and its key-less identity (a random hub id) in --dir, by
// default ~/.local/state/hab-hub, and listens on 127.0.0.1:7443. Anything but loopback and Tailscale
// addresses needs --allow-public. --trust-proxy: a reverse proxy on this machine forwards to the
// hub, and the log shows the address it forwards (listen.ts). Files (#371): their sealed bytes are
// kept in <dir>/blobs, at most --max-file-mb (25) each and --quota-mb (200) held per peer at once.
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_QUOTA_BYTES } from '../../src/core/team-wire.ts'
import { DEFAULT_DIR, startAdmin } from './admin.ts'
import { fileBlobs } from './blobs.ts'
import { DEFAULT_KEEP_DAYS, MIN_KEEP_DAYS, openDb } from './db.ts'
import { createHub, realClock } from './hub.ts'
import { DEFAULT_LISTEN, isPrivateHost, parseListen } from './listen.ts'
import { startServer } from './server.ts'

const USAGE =
  'usage: bun hub/src/main.ts [--dir D] [--listen host:port] [--allow-public] [--trust-proxy] [--keep-days N] [--max-file-mb N] [--quota-mb N]'
const MB = 1024 * 1024

function fail(msg: string): never {
  console.error(`agent-board hub: ${msg}`)
  process.exit(2)
}

let dir = DEFAULT_DIR
let listen = DEFAULT_LISTEN
let allowPublic = false
let trustProxy = false
let keepDays = DEFAULT_KEEP_DAYS
let maxFileBytes = DEFAULT_MAX_FILE_BYTES
let quotaBytes = DEFAULT_QUOTA_BYTES
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dir' || a === '--listen' || a === '--keep-days' || a === '--max-file-mb' || a === '--quota-mb') {
    const v = argv[++i]
    if (v === undefined) fail(`${a} needs a value\n${USAGE}`)
    if (a === '--dir') dir = v
    else if (a === '--listen') listen = v
    else if (a === '--max-file-mb' || a === '--quota-mb') {
      // A file is hashed in one pass when its last chunk is in: kept to a size that pass stays short for.
      const top = a === '--max-file-mb' ? 1024 : 4096
      const n = /^\d+$/.test(v) ? Number(v) : Number.NaN
      if (!(n >= 1 && n <= top)) fail(`${a} is a whole number of megabytes from 1 to ${top}, not ${v}`)
      if (a === '--max-file-mb') maxFileBytes = n * MB
      else quotaBytes = n * MB
    } else {
      keepDays = /^\d+$/.test(v) ? Number(v) : Number.NaN
      if (!(keepDays >= MIN_KEEP_DAYS))
        fail(`--keep-days is a whole number of ${MIN_KEEP_DAYS} or more (messages live up to 7 days), not ${v}`)
    }
  } else if (a === '--allow-public') allowPublic = true
  else if (a === '--trust-proxy') trustProxy = true
  else fail(USAGE)
}

if (quotaBytes < maxFileBytes) fail('--quota-mb is at least --max-file-mb: a peer could not send one file')

const where = parseListen(listen)
if (!where) fail(`--listen is host:port, not ${listen}`)
if (!allowPublic && !isPrivateHost(where.hostname))
  fail(`${where.hostname} is neither loopback nor a Tailscale address; add --allow-public to listen there`)

mkdirSync(dir, { recursive: true, mode: 0o700 })
if (process.platform !== 'win32') chmodSync(dir, 0o700)
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`)
const db = openDb(join(dir, 'hub.db'))
const hub = createHub({
  db,
  clock: realClock,
  log,
  keepDays,
  blobs: fileBlobs(join(dir, 'blobs')),
  maxFileBytes,
  quotaBytes,
})
// Once at start too: a hub restarted more often than hourly would otherwise never prune.
try {
  hub.prune()
} catch (e) {
  log(`prune failed: ${e instanceof Error ? e.message : e}`)
}
const server = startServer({ hub, hostname: where.hostname, port: where.port, trustProxy })
let admin: ReturnType<typeof startAdmin> | undefined
try {
  admin = startAdmin({ dir, db, hub, clock: realClock })
} catch (e) {
  log(`no admin socket: ${e instanceof Error ? e.message : e}`)
}
db.audit(Date.now(), null, 'start', { listen: `${server.hostname}:${server.port}` })
log(
  `hub ${db.hubId()} listening on ws://${server.hostname}:${server.port}/v1, dir ${dir}, files up to ${maxFileBytes / MB} MB, ${quotaBytes / MB} MB a peer`,
)
if (!isPrivateHost(where.hostname))
  log('listening beyond loopback and Tailscale over plain ws://; put TLS in front of it')

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  hub.stop()
  admin?.stop()
  server.stop()
  db.audit(Date.now(), null, 'stop')
  db.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
