// What the board pane runs: keeps the terminal board (tui.mjs) going and restarts it when the
// plugin's code changes, so an update reaches the open board (and the web board it serves)
// without anyone touching herdr. Quitting the board (Ctrl+C) ends the pane as before. A crash
// starts it again after a pause (afterCrash in crash-policy.mjs); one that keeps crashing leaves
// its error on screen and waits for the next code change. web.log in the state folder keeps
// what happened, since the pane's screen goes with the next start.
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { afterCrash } from './crash-policy.mjs'
import { ROOT, STATE_DIR } from './paths.mjs'

const RESTART = 75
let child = null
let wanted = false // a restart was asked for, so the exit that follows is not a quit
let crashes = [] // when the board crashed lately
let retry = null // the start after a crash, while it waits

const log = msg => {
  try {
    appendFileSync(join(STATE_DIR, 'web.log'), `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

// This process only watches over the board: whatever goes wrong in it is logged, never the end
// of the pane (and of the web board with it).
process.on('uncaughtException', err => log(`run.mjs: ${err?.stack || err}`))

function start() {
  clearTimeout(retry)
  retry = null
  wanted = false
  const board = spawn(process.execPath, [join(ROOT, 'src', 'tui.mjs')], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env })
  child = board
  board.on('exit', (code, signal) => {
    if (code === RESTART || wanted) return setTimeout(start, 150)
    if (code === 0) process.exit(0)
    child = null
    const next = afterCrash(crashes, Date.now())
    crashes = next.crashes
    log(`board stopped (${code ?? signal}), ${next.wait ? `starts again in ${next.wait / 1000} s` : `${crashes.length} times lately: waits for a code change`}`)
    if (!next.wait) return console.error(`\nagent-board stopped (exit ${code ?? signal}) ${crashes.length} times lately. It starts again on the next code change.`)
    console.error(`\nagent-board stopped (exit ${code ?? signal}). It starts again in ${next.wait / 1000} s.`)
    retry = setTimeout(start, next.wait)
  })
}

// On Windows a plain read fires the watcher too (it updates the access time), and the hooks read
// these files on every prompt of every session: restart only when a file really changed.
const SRC = join(ROOT, 'src')
const stamp = () =>
  readdirSync(SRC)
    .filter(n => n.endsWith('.mjs'))
    .map(n => {
      const s = statSync(join(SRC, n), { throwIfNoEntry: false })
      return `${n}:${s?.mtimeMs}:${s?.size}`
    })
    .join('|')
let code = stamp()

function changed() {
  let now
  try {
    now = stamp()
  } catch {
    return // a file being written: its own change event comes next
  }
  if (now === code) return
  code = now
  crashes = [] // new code may well be the fix
  if (!child) return start()
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

let timer = null
// Windows drops a watcher now and then (EPERM and the like): a new one takes its place.
function watchSrc() {
  try {
    const watcher = watch(SRC, (_, name) => {
      if (name && !name.endsWith('.mjs')) return
      clearTimeout(timer)
      timer = setTimeout(changed, 400)
    })
    watcher.on('error', err => {
      log(`run.mjs: watching src: ${err.message}`)
      watcher.close()
      setTimeout(watchSrc, 5000)
    })
  } catch (err) {
    log(`run.mjs: watching src: ${err.message}`)
    setTimeout(watchSrc, 5000)
  }
}

watchSrc()
start()
