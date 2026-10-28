// The hub: `bun hub/src/main.ts [--dir D] [--listen host:port] [--allow-public] [--keep-days N]`. It keeps its
// store, its admin socket and its key-less identity (a random hub id) in --dir, by default
// ~/.local/state/hab-hub, and listens on 127.0.0.1:7443. Anything but loopback and Tailscale
// addresses needs --allow-public.
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DIR, startAdmin } from './admin.ts'
import { DEFAULT_KEEP_DAYS, MIN_KEEP_DAYS, openDb } from './db.ts'
import { createHub, realClock } from './hub.ts'
import { DEFAULT_LISTEN, isPrivateHost, parseListen } from './listen.ts'
import { startServer } from './server.ts'

const USAGE = 'usage: bun hub/src/main.ts [--dir D] [--listen host:port] [--allow-public] [--keep-days N]'

function fail(msg: string): never {
  console.error(`agent-board hub: ${msg}`)
  process.exit(2)
}

let dir = DEFAULT_DIR
let listen = DEFAULT_LISTEN
let allowPublic = false
let keepDays = DEFAULT_KEEP_DAYS
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--dir' || a === '--listen' || a === '--keep-days') {
    const v = argv[++i]
    if (v === undefined) fail(`${a} needs a value\n${USAGE}`)
    if (a === '--dir') dir = v
    else if (a === '--listen') listen = v
    else {
      keepDays = /^\d+$/.test(v) ? Number(v) : Number.NaN
      if (!(keepDays >= MIN_KEEP_DAYS))
        fail(`--keep-days is a whole number of ${MIN_KEEP_DAYS} or more (messages live up to 7 days), not ${v}`)
    }
  } else if (a === '--allow-public') allowPublic = true
  else fail(USAGE)
}

const where = parseListen(listen)
if (!where) fail(`--listen is host:port, not ${listen}`)
if (!allowPublic && !isPrivateHost(where.hostname))
  fail(`${where.hostname} is neither loopback nor a Tailscale address; add --allow-public to listen there`)

mkdirSync(dir, { recursive: true, mode: 0o700 })
if (process.platform !== 'win32') chmodSync(dir, 0o700)
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`)
const db = openDb(join(dir, 'hub.db'))
const hub = createHub({ db, clock: realClock, log, keepDays })
// Once at start too: a hub restarted more often than hourly would otherwise never prune.
try {
  hub.prune()
} catch (e) {
  log(`prune failed: ${e instanceof Error ? e.message : e}`)
}
const server = startServer({ hub, hostname: where.hostname, port: where.port })
let admin: ReturnType<typeof startAdmin> | undefined
try {
  admin = startAdmin({ dir, db, hub, clock: realClock })
} catch (e) {
  log(`no admin socket: ${e instanceof Error ? e.message : e}`)
}
db.audit(Date.now(), null, 'start', { listen: `${server.hostname}:${server.port}` })
log(`hub ${db.hubId()} listening on ws://${server.hostname}:${server.port}/v1, dir ${dir}`)
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
