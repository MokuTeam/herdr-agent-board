// What wake's pane runs (#119): the supervisor (services/wake/supervisor.ts) with the wake process
// (wake.ts) under it. It starts it again after a crash, ends one whose API stops answering, and
// restarts it when the plugin's code changes, so an update reaches wake without anyone touching
// herdr. The wake process's errors show on the pane's screen; the last one is kept for the status
// file. config.json's kill switch is read first: wake off, it ends with 0 and starts nothing.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { configFile, readConfigFile } from '../adapters/config-file.ts'
import { ROOT } from '../adapters/paths.ts'
import { wakeLog, writeWakeStatus } from '../adapters/wake-files.ts'
import { wakeConfig, wakeSwitch } from '../core/wake/config.ts'
import { isWakeStatus } from '../core/wake/status.ts'
import { createSupervisor, type WakeChild } from '../services/wake/supervisor.ts'

const SRC = join(ROOT, 'src')
/** How long a health check waits for /status. */
const HEALTH_TIMEOUT_MS = 5000
/** After the wake process's exit, how long its last stderr may take to come in. */
const LAST_WORDS_MS = 1000

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const stackOf = (err: unknown): string => (err instanceof Error && err.stack) || String(err)

// The kill switch first: off (or a config.json that does not parse), nothing starts.
if (!wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })) process.exit(0)

// This process only watches over wake: whatever goes wrong in it is logged, never the end of the pane.
process.on('uncaughtException', err => wakeLog(`wake-run.ts: ${stackOf(err)}`))

/** The port the wake process said it listens on; config.json's until it says. */
let port = wakeConfig(readConfigFile()?.wake).port

/** `bun src/entrypoints/wake.ts`, its stderr shown on this screen and read line by line. */
function spawnWake(): WakeChild {
  const proc: ChildProcess = spawn(process.execPath, [join(SRC, 'entrypoints', 'wake.ts')], {
    stdio: ['inherit', 'inherit', 'pipe', 'ipc'],
    env: process.env,
  })
  const lineSinks: ((line: string) => void)[] = []
  let partial = ''
  const lines = (text: string): void => {
    const all = (partial + text).split(/\r?\n/)
    partial = all.pop() ?? ''
    for (const line of all) for (const sink of lineSinks) sink(line)
  }
  proc.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    lines(chunk.toString('utf8'))
  })
  proc.on('message', m => {
    if (m && typeof m === 'object' && typeof (m as { up?: unknown }).up === 'number') port = (m as { up: number }).up
  })
  return {
    onExit: cb =>
      proc.on('exit', code => {
        // Its last words may come in after it ended: the end is told once they did, or a moment later.
        let told = false
        const tell = (): void => {
          if (told) return
          told = true
          lines('\n')
          cb(code)
        }
        proc.once('close', tell)
        setTimeout(tell, LAST_WORDS_MS)
      }),
    onMessage: cb => proc.on('message', cb),
    onErrorLine: cb => lineSinks.push(cb),
    send: m => {
      proc.send(m as Parameters<ChildProcess['send']>[0])
    },
    kill: () => proc.kill(),
  }
}

/** Whether a wake answers GET /status on its port within 5 s. */
async function health(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    return res.ok && isWakeStatus(await res.json())
  } catch {
    return false
  }
}

const supervisor = createSupervisor({
  spawn: spawnWake,
  health,
  writeStatus: s => writeWakeStatus(s),
  print: text => console.error(`\n${new Date().toLocaleTimeString()} ${text}`),
  log: text => wakeLog(`supervisor: ${text}`),
  now: Date.now,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  exit: code => process.exit(code),
  ...(process.env.HERDR_PANE_ID && { pane: process.env.HERDR_PANE_ID }),
  pid: process.pid,
})

// A copy of run.ts's watcher, which stays as it is: every .ts file under src/, stamped by its mtime
// and size (on Windows a plain read fires the watcher too), the watcher made again on an error.
const isCode = (name: string): boolean => name.endsWith('.ts')
const stamp = (): string =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(isCode)
    .sort()
    .map(n => {
      const s = statSync(join(SRC, n), { throwIfNoEntry: false })
      return `${n}:${s?.mtimeMs}:${s?.size}`
    })
    .join('|')
let code = stamp()
let timer: ReturnType<typeof setTimeout> | undefined

function changed(): void {
  let now: string
  try {
    now = stamp()
  } catch {
    return // a file being written: its own change event comes next
  }
  if (now === code) return
  code = now
  supervisor.codeChanged()
}

function watchSrc(): void {
  try {
    const watcher = watch(SRC, { recursive: true }, (_, name) => {
      if (name && !isCode(name)) return
      clearTimeout(timer)
      timer = setTimeout(changed, 400)
    })
    watcher.on('error', err => {
      wakeLog(`wake-run.ts: watching src: ${messageOf(err)}`)
      watcher.close()
      setTimeout(watchSrc, 5000)
    })
  } catch (err) {
    wakeLog(`wake-run.ts: watching src: ${messageOf(err)}`)
    setTimeout(watchSrc, 5000)
  }
}

watchSrc()
supervisor.start()
