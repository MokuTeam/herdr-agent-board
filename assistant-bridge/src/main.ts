// The assistant bridge: `bun assistant-bridge/src/main.ts [--dir D]` (#384, issue #386).
// Reads config.json and key.json from the state directory (default ~/.local/state/assistant-bridge),
// keeps its store there, listens on the module's socket and holds one connection to the hub.
// SIGHUP reads the config again; SIGINT and SIGTERM stop it. `assistant-bridge/src/cli.ts join`
// makes the key and joins the hub first.

import { createBridge } from './bridge.ts'
import { DEFAULT_DIR, ensureDir, paths, readConfig, readKey, writePrivate } from './files.ts'
import { openStore } from './store.ts'

const USAGE = 'usage: bun assistant-bridge/src/main.ts [--dir D]'

function fail(msg: string): never {
  console.error(`assistant-bridge: ${msg}`)
  process.exit(2)
}

let dir = DEFAULT_DIR
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--dir' && args[i + 1]) dir = args[++i] as string
  else if (a === '--help' || a === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else fail(`${a}?\n${USAGE}`)
}

ensureDir(dir)
const first = readConfig(dir)
if (!first.ok) fail(first.errors.join('\n'))
const key = readKey(dir)
if (!key) fail(`no key in ${dir}; run: bun assistant-bridge/src/cli.ts join <invite> --dir ${dir}`)

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`)
const store = openStore(paths(dir).db)
let lastStatus = 0
const bridge = createBridge({
  cfg: first.cfg,
  store,
  key,
  log,
  version: '1',
  onStatus: s => {
    // At most once a second: it is for `status`, not a log.
    const now = Date.now()
    if (now - lastStatus < 1000) return
    lastStatus = now
    try {
      writePrivate(paths(dir).status, `${JSON.stringify({ ...s, at: new Date(now).toISOString() }, null, 2)}\n`)
    } catch {}
  },
})

process.on('SIGHUP', () => {
  const next = readConfig(dir)
  if (!next.ok) {
    log(`config: not reloaded: ${next.errors.join('; ')}`)
    return
  }
  bridge.reload(next.cfg)
  log('config: reloaded')
})
const stop = (): void => {
  void bridge.stop().finally(() => {
    store.close()
    process.exit(0)
  })
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

await bridge.start()
log(`assistant-bridge: up; hub ${first.cfg.hub}, socket ${first.cfg.socket}`)
