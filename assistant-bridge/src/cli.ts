// `bun assistant-bridge/src/cli.ts <command> [--dir D]` (#384, issue #386):
//   join <invite>   make the bridge's key (once) and join the hub named in config.json
//   trust <name>    trust the key an allowed peer's name has now (after "key changed"); then SIGHUP the bridge
//   status          what the running bridge wrote last: the hub link, the module, counts
import { existsSync, readFileSync } from 'node:fs'
import { probeHub } from '../../src/adapters/hub-reach.ts'
import { joinHub, TRIES, TRY_MS } from '../../src/services/team-join.ts'
import { DEFAULT_DIR, ensureDir, ensureKey, paths, readConfig } from './files.ts'
import { openStore } from './store.ts'

const USAGE = 'usage: bun assistant-bridge/src/cli.ts join <invite> | trust <name> | status  [--dir D]'

function fail(msg: string): never {
  console.error(`assistant-bridge: ${msg}`)
  process.exit(2)
}

let dir = DEFAULT_DIR
const rest: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string
  if (a === '--dir' && argv[i + 1]) dir = argv[++i] as string
  else rest.push(a)
}
const [cmd, arg] = rest

if (cmd === 'join') {
  if (!arg) fail(USAGE)
  ensureDir(dir)
  const cfg = readConfig(dir)
  if (!cfg.ok) fail(cfg.errors.join('\n'))
  const { key, fresh } = await ensureKey(dir)
  const out = await joinHub(
    { hub: cfg.cfg.hub, invite: arg, name: cfg.cfg.name, key, keyWasSaved: !fresh },
    {
      tryMs: TRY_MS,
      tries: TRIES,
      probe: probeHub,
      say: line => console.log(line),
      pause: ms => new Promise(r => setTimeout(r, ms)),
    },
  )
  if (!out.ok) fail(out.error)
  console.log(`ok · joined ${cfg.cfg.hub} as ${cfg.cfg.name} (${key.pub.slice(0, 10)}); start the bridge now`)
} else if (cmd === 'trust') {
  if (!arg) fail(USAGE)
  const store = openStore(paths(dir).db)
  const pin = store.pins().find(p => p.name === arg)
  if (!pin) fail(`${arg} is not pinned; is it on the allow list?`)
  if (pin.status !== 'changed' || !pin.seen) {
    console.log(`ok · ${arg} is trusted already`)
  } else {
    store.pin(arg, pin.seen, Date.now())
    console.log(
      `ok · ${arg} trusted with key ${pin.seen.slice(0, 10)}; send the bridge SIGHUP to deliver what was held`,
    )
  }
  store.close()
} else if (cmd === 'status') {
  const file = paths(dir).status
  if (!existsSync(file)) fail(`no status in ${dir}; is the bridge running?`)
  console.log(readFileSync(file, 'utf8').trim())
} else fail(USAGE)
