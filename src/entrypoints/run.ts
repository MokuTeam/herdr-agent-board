// What the board pane runs: keeps the terminal board (tui.ts) going and restarts it when the
// plugin's code changes, so an update reaches the open board (and the web board it serves)
// without anyone touching herdr. Quitting the board (Ctrl+C) ends the pane as before. A crash
// starts it again after a pause (afterCrash in core/crash-policy.ts); one that keeps crashing
// leaves its error on screen and waits for the next code change. web.log in the state folder
// keeps what happened, since the pane's screen goes with the next start.
import { type ChildProcess, spawn } from 'node:child_process'
import { appendFileSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { ROOT, stateDir } from '../adapters/paths.ts'
import { afterCrash } from '../core/crash-policy.ts'

const RESTART = 75
const SRC = join(ROOT, 'src')
let child: ChildProcess | null = null
let wanted = false // a restart was asked for, so the exit that follows is not a quit
let crashes: number[] = [] // when the board crashed lately
let retry: ReturnType<typeof setTimeout> | undefined // the start after a crash, while it waits

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const stackOf = (err: unknown): string => (err instanceof Error && err.stack) || String(err)

const log = (msg: string): void => {
  try {
    appendFileSync(join(stateDir(), 'web.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// This process only watches over the board: whatever goes wrong in it is logged, never the end
// of the pane (and of the web board with it).
process.on('uncaughtException', err => log(`run.ts: ${stackOf(err)}`))

function start(): void {
  clearTimeout(retry)
  retry = undefined
  wanted = false
  const board = spawn(process.execPath, [join(SRC, 'entrypoints', 'tui.ts')], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: process.env,
  })
  child = board
  board.on('exit', (code, signal) => {
    if (code === RESTART || wanted) return void setTimeout(start, 150)
    if (code === 0) process.exit(0)
    child = null
    const next = afterCrash(crashes, Date.now())
    crashes = next.crashes
    const how = code ?? signal
    log(
      `board stopped (${how}), ${next.wait ? `starts again in ${next.wait / 1000} s` : `${crashes.length} times lately: waits for a code change`}`,
    )
    if (!next.wait)
      return console.error(
        `\nagent-board stopped (exit ${how}) ${crashes.length} times lately. It starts again on the next code change.`,
      )
    console.error(`\nagent-board stopped (exit ${how}). It starts again in ${next.wait / 1000} s.`)
    retry = setTimeout(start, next.wait)
  })
}

// The plugin's code: every .ts file under src/, its folders included.
const isCode = (name: string): boolean => name.endsWith('.ts')

// On Windows a plain read fires the watcher too (it updates the access time), and the hooks read
// these files on every prompt of every session: restart only when a file really changed.
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

function changed(): void {
  let now: string
  try {
    now = stamp()
  } catch {
    return // a file being written: its own change event comes next
  }
  if (now === code) return
  code = now
  crashes = [] // new code may well be the fix
  if (!child) {
    start()
    return
  }
  const old = child
  // It exited already: the start that follows is on its way.
  if (old.exitCode !== null || old.signalCode !== null) return
  wanted = true
  try {
    old.send('restart')
  } catch {
    old.kill()
  }
  // A board that does not answer is stopped the hard way.
  setTimeout(() => old.exitCode === null && old.kill(), 3000)
}

let timer: ReturnType<typeof setTimeout> | undefined
// Windows drops a watcher now and then (EPERM and the like): a new one takes its place.
function watchSrc(): void {
  try {
    const watcher = watch(SRC, { recursive: true }, (_, name) => {
      if (name && !isCode(name)) return
      clearTimeout(timer)
      timer = setTimeout(changed, 400)
    })
    watcher.on('error', err => {
      log(`run.ts: watching src: ${messageOf(err)}`)
      watcher.close()
      setTimeout(watchSrc, 5000)
    })
  } catch (err) {
    log(`run.ts: watching src: ${messageOf(err)}`)
    setTimeout(watchSrc, 5000)
  }
}

watchSrc()
start()
