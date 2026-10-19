// The board: a full-screen terminal UI in a herdr plugin pane. No model in the loop: it polls
// herdr, the Claude registry, transcript tails and the card files, and redraws.
//   lanes = categories, columns = Working / Needs me / Waiting on others / Done / Idle
//   Enter or double click: go to the session (waking it if it sleeps); m: send it a message;
//   w: set what it waits for; x: clear its card; c: change its category; 1-9 / 0: filter lanes;
//   q / Esc: back to where you were (an overlay board closes instead); Ctrl+C: close the board.
// This module owns stdin, stdout and the process; render.ts only turns state into text.
import { mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeCard } from '../adapters/cards.ts'
import { liveConfig } from '../adapters/config-file.ts'
import { boardFile, cardsDir, stateDir } from '../adapters/paths.ts'
import { listEntries } from '../adapters/schedule-store.ts'
import { t } from '../core/lang.ts'
import type { Item } from '../core/types.ts'
import { type BoardServer, startServer } from '../server/app.ts'
import * as actions from '../services/actions.ts'
import { collect } from '../services/board.ts'
import { defaultDeps } from '../services/deps.ts'
import { goBack } from '../services/nav.ts'
import { startScheduler } from '../services/scheduler.ts'
import { openWeb } from '../services/web-open.ts'
import { ACTION, hitAt, parseMouse, tokens } from './input.ts'
import { HEADER_ROWS, isWide, render, type Size } from './render.ts'
import { build, byKey, createState, type Dir, move, selected } from './state.ts'
import { charWidth } from './terminal.ts'

const PANE = process.env.HERDR_PANE_ID ?? null
// An overlay closes once you leave it; the workspace and tab boards stay open.
const OVERLAY = !!PANE && process.env.AGENT_BOARD_PLACEMENT === 'overlay'
const out = process.stdout

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const codeOf = (err: unknown): unknown =>
  typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined

// The web board's server runs here, alongside; its log and everything else share one deps.
const webLog = (msg: string): void => {
  try {
    writeFileSync(join(stateDir(), 'web.log'), `${new Date().toISOString()} ${msg}\n`, { flag: 'a' })
  } catch {}
}

let web: BoardServer | null = null // the web board's server, once it listens
// Updated in place when config.json changes (by hand or from the web board).
const cfg = liveConfig(() => {
  void refresh()
  void web?.refresh()
})
const deps = defaultDeps(cfg, webLog)
const state = createState(cfg, OVERLAY || !PANE)

const size = (): Size => ({ columns: out.columns || 80, rows: out.rows || 24 })

function draw(): void {
  state.now = Date.now()
  out.write(render(state, size()))
}

/** writeCard, with a failure (the card locked by another writer) shown instead of ending the board. */
function save(key: string, patch: Parameters<typeof writeCard>[1]): boolean {
  try {
    writeCard(key, patch)
    return true
  } catch (err) {
    say(messageOf(err), true)
    return false
  }
}

function say(text: string, error = false): void {
  state.flash = { text, error, until: Date.now() + (error ? 8000 : 4000) }
  draw()
}

// ---------------------------------------------------------------- data
let refreshing = false
let again = false
async function refresh(): Promise<void> {
  if (refreshing) {
    again = true
    return
  }
  refreshing = true
  try {
    state.items = await collect(deps)
    state.profiles = deps.profiles().list
    const entries = listEntries()
    state.alarms = new Map()
    for (const e of entries) if (!state.alarms.has(e.key)) state.alarms.set(e.key, e)
    state.scheduled = entries.length
    state.loadError = null
  } catch (err) {
    state.loadError = messageOf(err)
  } finally {
    state.loading = false
    refreshing = false
  }
  build(state)
  draw()
  if (again) {
    again = false
    void refresh()
  }
}

// ---------------------------------------------------------------- actions
function setBusy(key: string, text: string | null): void {
  if (text) state.busy.set(key, text)
  else state.busy.delete(key)
  draw()
}

async function jump(it: Item | undefined): Promise<void> {
  if (!it?.pane) return
  setBusy(it.key, t(it.sleeping ? 'tui.waking' : 'tui.going'))
  const r = await actions.focus(deps, it)
  setBusy(it.key, null)
  if (!r.ok) return say(r.error, true)
  if (OVERLAY) quit()
  void refresh()
}

async function send(it: Item, text: string): Promise<void> {
  setBusy(it.key, t(it.sleeping ? 'tui.waking' : 'tui.sending'))
  const r = await actions.send(deps, it, text)
  setBusy(it.key, null)
  say(r.ok ? t('sent.to', { name: it.name }) : r.error, !r.ok)
  void refresh()
}

function ask(label: string, initial: string | undefined, submit: (text: string) => void): void {
  state.mode = 'input'
  state.input = { label, text: initial ?? '', submit }
  draw()
}

function clearCard(it: Item): void {
  const cleared = {
    doing: '',
    wait: '',
    waitSince: '',
    ask: '',
    askSince: '',
    result: '',
    pin: '',
    pinAt: '',
    pinBusy: '',
    dismissed: it.attention === 'question' ? (it.question ?? '') : '',
  } as const
  if (save(it.key, cleared)) say(t('tui.cleared', { name: it.name }))
  void refresh()
}

async function sleepIt(it: Item): Promise<void> {
  setBusy(it.key, t('tui.sleeping'))
  const r = await actions.sleepSession(deps, it)
  setBusy(it.key, null)
  say(r.ok ? t('asleep', { name: it.name }) : r.error, !r.ok)
  deps.wake.forget()
  void refresh()
}

function setFilter(n: number): void {
  state.filter = n === 0 ? null : (state.allCats[n - 1] ?? state.filter)
  state.scroll = 0
  state.follow = true
  build(state)
  draw()
}

const DIRS: readonly string[] = ['up', 'down', 'left', 'right', 'home']

function onAction(name: string): void {
  const it = selected(state)
  switch (name) {
    case 'quit':
      if (OVERLAY || !PANE) quit()
      else void goBack()
      return
    case 'exit':
      quit()
      return
    case 'refresh':
      return void refresh()
    case 'web':
      say(t('tui.openingWeb'))
      return void openWeb(cfg).then(r => !r.ok && say(r.error, true))
    case 'enter':
      return void jump(it)
    case 'message':
      if (it) ask(t('tui.messageFor', { name: it.name }), '', text => text && void send(it, text))
      return
    case 'wait':
      if (it)
        ask(t('tui.waitsFor', { name: it.name }), it.wait, text => {
          save(it.key, text ? { wait: text, waitSince: Date.now(), by: 'user' } : { wait: '', waitSince: '' })
          void refresh()
        })
      return
    case 'clear':
      if (it) clearCard(it)
      return
    case 'sleep':
      if (it && !it.sleeping) void sleepIt(it)
      return
    case 'category':
      if (it) {
        state.mode = 'category'
        draw()
      }
      return
    default:
      if (name.startsWith('filter:')) setFilter(Number(name.slice(7)))
      else if (DIRS.includes(name) && move(state, name as Dir, isWide(size().columns))) draw()
  }
}

// ---------------------------------------------------------------- input
function onData(data: string): void {
  for (const tok of tokens(data)) {
    if (tok === '\x1b[200~') state.pasting = true
    else if (tok === '\x1b[201~') state.pasting = false
    else if (tok.startsWith('\x1b[<')) onMouse(tok)
    else if (tok === '\x1b[I')
      void refresh() // focus in
    else if (state.mode === 'input') onInputKey(tok)
    else if (state.mode === 'category') onCategoryKey(tok)
    else if (/^[0-9]$/.test(tok)) onAction(`filter:${tok}`)
    else {
      const action = ACTION.get(tok)
      if (action) onAction(action)
    }
  }
}

function onInputKey(tok: string): void {
  const input = state.input
  if (!input) return
  if (state.pasting && (tok === '\r' || tok === '\n')) tok = ' '
  if (tok === '\r' || tok === '\n') {
    state.mode = 'board'
    state.input = null
    input.submit(input.text.trim())
    draw()
    return
  }
  if (tok === '\x1b' || tok === '\x03') {
    state.mode = 'board'
    state.input = null
  } else if (tok === '\x7f' || tok === '\b') input.text = [...input.text].slice(0, -1).join('')
  else if (tok === '\x15') input.text = ''
  else if (tok === '\x17') input.text = input.text.replace(/\S*\s*$/, '')
  else if (!tok.startsWith('\x1b') && charWidth(tok.codePointAt(0) ?? 0) > 0) input.text += tok
  draw()
}

function onCategoryKey(tok: string): void {
  const it = selected(state)
  state.mode = 'board'
  if (!it || tok === '\x1b' || tok === '\x03') {
    draw()
    return
  }
  if (tok === 'n' || tok === 'т') {
    ask(t('tui.newCat', { name: it.name }), '', text => {
      const id = text.toLowerCase().replace(/[^a-z0-9_-]/g, '')
      if (id) {
        save(it.key, { category: id })
        void refresh()
      }
    })
    return
  }
  const c = cfg.categories[Number(tok) - 1]
  if (/^[1-9]$/.test(tok) && c) {
    if (save(it.key, { category: c.id })) say(t('moved', { name: it.name, where: c.title ?? c.id }))
    void refresh()
  }
  draw()
}

function onMouse(tok: string): void {
  const m = parseMouse(tok)
  if (!m || state.mode !== 'board' || !m.press) return
  if (m.button === 64 || m.button === 65) {
    state.scroll = Math.max(0, state.scroll + (m.button === 64 ? -3 : 3))
    draw()
    return
  }
  if (m.button !== 0) return
  const hit = hitAt(state.hits, state.scroll + (m.y - 1 - HEADER_ROWS), m.x)
  if (!hit) return
  const now = Date.now()
  if (state.lastClick.key === hit.key && now - state.lastClick.at < 450) {
    state.lastClick = { key: null, at: 0 }
    return void jump(byKey(state, hit.key))
  }
  state.lastClick = { key: hit.key, at: now }
  state.sel = hit.key
  draw()
}

// ---------------------------------------------------------------- lifecycle
function cleanup(): void {
  out.write('\x1b[?1004l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l')
  try {
    if (JSON.parse(readFileSync(boardFile(), 'utf8')).pid === process.pid) unlinkSync(boardFile())
  } catch {}
}

function quit(code = 0): never {
  cleanup()
  process.exit(code)
}

// Right after a restart the previous process may still hold the port for a moment: retry a few times.
async function serve(tries = 8): Promise<void> {
  try {
    web = await startServer({ deps })
    webLog(`serving ${web.url}`)
  } catch (err) {
    const taken = codeOf(err) === 'EADDRINUSE'
    if (taken && tries > 1) {
      setTimeout(() => void serve(tries - 1), 500)
      return
    }
    webLog(taken ? 'port taken, another board serves the web' : `server: ${messageOf(err)}`)
  }
}

mkdirSync(cardsDir(), { recursive: true })
mkdirSync(stateDir(), { recursive: true })
writeFileSync(boardFile(), JSON.stringify({ pane: PANE, pid: process.pid, overlay: OVERLAY }))
process.on('SIGINT', () => quit())
process.on('SIGTERM', () => quit())
process.on('SIGHUP', () => quit())
// run.ts asks for a restart when the plugin's code changed: put the terminal back, then go.
process.on('message', m => m === 'restart' && quit(75))
process.on('uncaughtException', err => {
  cleanup()
  console.error(err)
  // run.ts starts the board again, and the screen goes with it: the log keeps the error.
  webLog(`crash: ${(err instanceof Error && err.stack) || String(err)}`)
  process.exit(1)
})

out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1004h')
out.on('resize', draw)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', onData)

let watchTimer: ReturnType<typeof setTimeout> | undefined
try {
  watch(cardsDir(), () => {
    clearTimeout(watchTimer)
    watchTimer = setTimeout(() => void refresh(), 150)
  })
} catch {}
setInterval(() => void refresh(), Math.max(1, cfg.refreshSec) * 1000)
draw()
void refresh()

if (cfg.web !== false) void serve()
// The web board's server runs the schedule; without it, this board does.
else startScheduler({ deps, onChange: () => void refresh() })
