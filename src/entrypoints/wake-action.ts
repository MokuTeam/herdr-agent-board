// herdr's actions for a pane (#119), as herdr-wake's action.mjs was: `bun src/entrypoints/wake-action.ts
// sleep|wake [pane id]` puts the Claude session in the pane to sleep, or wakes it, through the
// wake's local API on 127.0.0.1:<wake.port>. The pane: the one given, else the focused pane of
// herdr's plugin context, else the pane it runs in. Wake off in config.json (or a config.json that
// does not parse): it says so and sends nothing.
import { existsSync } from 'node:fs'
import { configFile, readConfigFile } from '../adapters/config-file.ts'
import { isRecord } from '../adapters/json-store.ts'
import { wakeConfig, wakeSwitch } from '../core/wake/config.ts'

/** A wake may take wakeTimeoutSec and more: how long the answer is waited for. */
const ANSWER_MS = 180_000
const USAGE = 'usage: bun src/entrypoints/wake-action.ts sleep|wake [pane id]'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** herdr's plugin context's focused pane, when it names one. */
function focusedPane(): string | undefined {
  try {
    const ctx: unknown = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}')
    return isRecord(ctx) && typeof ctx.focused_pane_id === 'string' && ctx.focused_pane_id
      ? ctx.focused_pane_id
      : undefined
  } catch {
    return undefined
  }
}

const mode = process.argv[2]
const pane = process.argv[3] || focusedPane() || process.env.HERDR_PANE_ID
if ((mode !== 'sleep' && mode !== 'wake') || !pane) {
  console.error(USAGE)
  process.exit(2)
}

if (!wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })) {
  console.log('wake is off')
  process.exit(1)
}

const { port } = wakeConfig(readConfigFile()?.wake)
let out: unknown
try {
  const res = await fetch(`http://127.0.0.1:${port}/${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: pane }),
    signal: AbortSignal.timeout(ANSWER_MS),
  })
  out = await res.json()
} catch (err) {
  console.log(`wake does not answer on 127.0.0.1:${port}: ${messageOf(err)}`)
  process.exit(1)
}
const answer = isRecord(out) ? out : {}
if (answer.ok === true) {
  console.log(`${mode === 'sleep' ? 'asleep' : 'awake'}: ${answer.name} (${answer.pane})`)
  process.exit(0)
}
console.log(typeof answer.error === 'string' ? answer.error : `wake answered: ${JSON.stringify(out)}`)
process.exit(1)
