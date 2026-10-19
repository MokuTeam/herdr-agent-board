// The "new session" window both ways in a fake DOM (support/fake-dom.ts), for parity: the old
// page's launch.js — initLaunch as it was at the parity baseline, with its own launch-model.js,
// launch-drafts.js and modal-focus.js — and the React port: components/launch/launch-window.ts on
// the window <LaunchDialogView> draws, drawn again after every event and frame the way React would
// (support/react-commit.ts), its handlers React's own (support/react-events.ts). Both sides take
// the same steps against the same fake server; snapshot() prints what a viewer could tell apart.
import { createRef } from 'react'
import type { BoardCategory, BoardProfile } from '../../../src/core/payload.ts'
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import { launchApi } from '../../../web/src/api/launch.ts'
import { LaunchDialogView, type LaunchRefs, launchHandlers } from '../../../web/src/components/launch/LaunchDialog.tsx'
import { launchWindow } from '../../../web/src/components/launch/launch-window.ts'
import { localStore, windowKeys } from '../../../web/src/hooks/useLaunch.ts'
import { scopeOfElements } from '../../../web/src/hooks/useModalFocus.ts'
import { type MenuOrigin, type PointRect, pointRect } from '../../../web/src/models/board-menus.ts'
import type { LaunchContext } from '../../../web/src/models/launch-form.ts'
import { modalFocusManager } from '../../../web/src/models/modal-focus.ts'
import { reducedMotion, Spring } from '../../../web/src/models/spring.ts'
import { box, type FakeElement, FakeWorld, type RectBox } from './fake-dom.ts'
import { canonical, type Element, parseHtml, reactMarkup } from './markup.ts'
import { oldCode, oldFunction, oldModule } from './old-app.ts'
import { asDom, clone, commit, first } from './react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './react-events.ts'

export const VIEWPORT = { w: 1000, h: 700 }

/** What the page knows when the window opens; tests change it between steps (fresh data going stale). */
export interface LaunchScene {
  t: Translator
  categories: BoardCategory[]
  items: Item[]
  launches: LaunchView[]
  filter: string
  canMutate: boolean
  /** The Claude profiles (the old page had none; a board before them sends none). */
  profiles?: BoardProfile[]
}

// ---------------------------------------------------------------- the server

/** A folder of the fake machine: its folders, and its checkout. */
interface FakeDir {
  entries: string[]
  git?: { root: string; branch: string }
  error?: string
}

/** Windows and POSIX folders, a file, an offline share and a folder the board may not read. */
const MACHINE: Record<string, FakeDir> = {
  'C:\\': { entries: ['Users', 'Work'] },
  'C:\\Users': { entries: ['me'] },
  'C:\\Users\\me': { entries: ['private', 'notes'] },
  'C:\\Users\\me\\private': { entries: [], error: 'denied' },
  'C:\\Users\\me\\notes': { entries: [] },
  'C:\\Work': { entries: ['.cache', 'acme', 'acme-web', 'beta'] },
  'C:\\Work\\acme': { entries: ['src', 'docs'], git: { root: 'C:\\Work\\acme', branch: 'main' } },
  'C:\\Work\\acme\\src': { entries: [], git: { root: 'C:\\Work\\acme', branch: 'main' } },
  'C:\\Work\\acme\\docs': { entries: [], git: { root: 'C:\\Work\\acme', branch: 'main' } },
  'C:\\Work\\acme-web': { entries: [] },
  'C:\\Work\\beta': { entries: [] },
  'D:\\': { entries: ['data'] },
  'D:\\data': { entries: [] },
  '/': { entries: ['home', 'srv'] },
  '/home': { entries: ['me'] },
  '/home/me': { entries: [] },
  '/srv': { entries: ['web'] },
  '/srv/web': { entries: ['app'], git: { root: '/srv/web', branch: 'trunk' } },
  '/srv/web/app': { entries: [], git: { root: '/srv/web', branch: 'trunk' } },
}
const FILES = new Set(['C:\\Work\\notes.txt', '/srv/readme.md'])
const HOME = 'C:\\Users\\me'
const ROOTS = [
  { name: '~', path: HOME },
  { name: 'C:', path: 'C:\\' },
  { name: 'D:', path: 'D:\\' },
]

/** A typed path as the server resolves it: `~` at home, either separator, case folded on Windows. */
function resolve(raw: string): string {
  let p = raw.trim().replace(/^["']|["']$/g, '')
  if (p === '~' || /^~[\\/]/.test(p)) p = HOME + p.slice(1)
  const windows = /^[A-Za-z]:/.test(p) || p.startsWith('\\\\')
  if (windows) p = p.replace(/\//g, '\\')
  p = p.replace(windows ? /\\+$/ : /\/+$/, '') || (windows ? p : '/')
  if (/^[A-Za-z]:$/.test(p)) p += '\\'
  const known = [...Object.keys(MACHINE), ...FILES].find(k => (windows ? k.toLowerCase() === p.toLowerCase() : k === p))
  return known ?? p
}

/** POST /api/fs/dirs as src/adapters/folders.ts answers it. */
export function listing(raw: string, git: boolean): Record<string, unknown> {
  if (!raw.trim()) return { path: '', exists: true, dir: true, roots: ROOTS, entries: [] }
  const path = resolve(raw)
  if (path.startsWith('\\\\offline')) return { path, exists: false, slow: true }
  if (FILES.has(path)) return { path, exists: true, dir: false }
  const dir = MACHINE[path]
  if (!dir) return { path, exists: false }
  const windows = /^[A-Za-z]:/.test(path)
  return {
    path,
    exists: true,
    dir: true,
    entries: dir.entries,
    truncated: false,
    parent: '',
    sep: windows ? '\\' : '/',
    error: dir.error ?? null,
    ...(git ? { git: dir.git ?? null } : {}),
  }
}

export const OPTIONS = {
  launcher: { kind: 'herdr', agent: 'claude' },
  workspaces: [
    { id: 'w1', label: 'Board' },
    { id: 'w2', label: 'Acme' },
    { id: 'w3', label: 'Ops' },
  ],
  focused: 'w3',
  board: 'Board',
  recent: ['/srv/web', 'C:\\Users\\me\\AppData\\Local\\Temp\\scratch', 'C:\\Work\\beta'],
  error: '',
}

export interface Reply {
  status: number
  body: unknown
}

/** The board's routes as the window uses them; a route can be held until the test lets it answer. */
export class FakeServer {
  options: unknown = OPTIONS
  start: Reply = { status: 200, body: { ok: true, id: 'L7' } }
  acts: Record<string, Reply> = {}
  private holding = new Set<string>()
  private held: { route: string; go: () => void }[] = []

  constructor(private readonly log: string[]) {}

  hold(route: string): void {
    this.holding.add(route)
  }
  release(route: string): void {
    this.holding.delete(route)
    for (const h of this.held.filter(x => x.route === route)) h.go()
    this.held = this.held.filter(x => x.route !== route)
  }

  private answer(method: string, url: string, body: string): { route: string; reply: Reply } {
    if (method === 'GET' && url === '/api/launch/options')
      return { route: 'options', reply: { status: 200, body: this.options } }
    const asked: unknown = body ? JSON.parse(body) : {}
    const field = (name: string) =>
      typeof asked === 'object' && asked !== null && name in asked ? Reflect.get(asked, name) : undefined
    if (url === '/api/fs/dirs')
      return { route: 'dirs', reply: { status: 200, body: listing(String(field('path') ?? ''), !!field('git')) } }
    if (url === '/api/launch') return { route: 'launch', reply: this.start }
    const act = /^\/api\/launch\/([^/]+)\/(\w+)$/.exec(url)
    if (act) return { route: act[2] ?? '', reply: this.acts[act[2] ?? ''] ?? { status: 200, body: { ok: true } } }
    return { route: 'other', reply: { status: 404, body: { error: 'not found' } } }
  }

  fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ?? ''
    const header = init.headers?.['x-board'] === '1' ? '' : ' (no X-Board)'
    this.log.push(`${method} ${url}${body ? ` ${body}` : ''}${header}`)
    const { route, reply } = this.answer(method, url, body)
    const res = { ok: reply.status < 400, status: reply.status, json: () => Promise.resolve(reply.body) }
    if (!this.holding.has(route)) return Promise.resolve(res)
    return new Promise<typeof res>(resolve => this.held.push({ route, go: () => resolve(res) }))
  }
}

// ---------------------------------------------------------------- the page

const PAGE = `<div id="page">
  <button id="new-session">New session</button>
  <section class="lane" data-cat="acme"><button class="lane-new" id="lane-new">+</button></section>
  <article class="card" data-key="s1" id="card"><span class="name">acme</span></article>
  <p id="far">off screen</p>
</div>`

function rects(el: FakeElement): RectBox | null {
  if (el.className.split(' ').includes('launch-win')) return box(210, 70, 580, 560)
  if (el.id === 'new-session') return box(840, 12, 130, 30)
  if (el.id === 'lane-new') return box(30, 120, 24, 24)
  if (el.id === 'card') return box(40, 300, 260, 90)
  if (el.id === 'new-card') return box(320, 420, 260, 96)
  if (el.id === 'far') return box(10, 900, 100, 20)
  return null
}

function newWorld(): FakeWorld {
  const world = new FakeWorld({ viewport: VIEWPORT, rects })
  world.install()
  const [page] = parseHtml(PAGE)
  if (page?.kind !== 'element') throw new Error('no page')
  world.mount(page)
  return world
}

/** Where a step opens the window from: a page element by id, a point (a lane's, the board's), or nothing. */
export type From = string | PointRect | null
export { pointRect }

const layerOf = (world: FakeWorld): FakeElement | null =>
  world.wrap(world.body).children.find(el => el.className === 'launch') ?? null

function describe(world: FakeWorld, el: FakeElement | null): string {
  if (!el) return 'none'
  if (el.node === world.body) return 'body'
  const name = el.getAttribute('name')
  const classes = el.className.split(' ').filter(Boolean).sort().join('.')
  return `${el.node.tag}${el.id ? `#${el.id}` : ''}${name ? `[name=${name}]` : ''}${classes ? `.${classes}` : ''}`
}

/** The window's markup without what only one side keeps: the old page's text keys, the fields' values (printed apart). */
function windowMarkup(layer: FakeElement): string {
  const copy = clone(layer.node)
  const tidy = (el: Element) => {
    el.attrs.delete('data-t')
    if (el.tag === 'input' || el.tag === 'option') {
      el.attrs.delete('value')
      el.attrs.delete('checked')
      el.attrs.delete('selected')
    }
    if (el.tag === 'textarea') el.children = []
    for (const child of el.children) if (child.kind === 'element') tidy(child)
  }
  tidy(copy)
  return canonical([copy])
}

function snapshotOf(world: FakeWorld, log: string[], open: boolean): string {
  const layer = layerOf(world)
  if (!layer) return 'no window'
  const field = (name: string) => layer.querySelector(`[name="${name}"]`)
  const values = ['name', 'cwd', 'workspace', 'newWorkspace', 'branch', 'message']
    .map(n => `${n}=${JSON.stringify(field(n)?.value ?? null)}`)
    .concat(`wt=${field('wt')?.checked ?? null}`)
  const options = (field('workspace')?.querySelectorAll('option') ?? []).map(o => o.getAttribute('value'))
  return [
    // Hidden, nobody sees it (the old page labels it only when it first opens).
    layer.hidden ? '<div class="launch" hidden>' : windowMarkup(layer),
    layer.hidden ? 'fields: hidden' : `fields: ${values.join(' ')} options=${JSON.stringify(options)}`,
    `open: ${open}`,
    `focus: ${describe(world, world.document.activeElement)}`,
    `selected: ${world.selected.map(el => describe(world, el)).join(', ')}`,
    // By id: a line drawn anew since is another element on the old page, the same one in React.
    `scrolled into view: ${world.intoView.map(s => `#${s.el.id} ${JSON.stringify(s.options)}`).join(', ')}`,
    `inert: ${world
      .wrap(world.body)
      .children.filter(el => Reflect.get(el, 'inert') === true)
      .map(el => describe(world, el))
      .join(', ')}`,
    `page: ${canonical([...(world.document.documentElement.querySelector('#page')?.querySelectorAll('.launch-card') ?? [])].map(el => el.node))}`,
    `storage: ${JSON.stringify([...world.storage])}`,
    `log: ${log.join(' | ')}`,
  ].join('\n')
}

export interface LaunchSide {
  world: FakeWorld
  server: FakeServer
  log: string[]
  scene: LaunchScene
  open(ctx: LaunchContext, from?: From): Promise<void>
  close(): Promise<void>
  isOpen(): boolean
  /** Fresh data came or went (syncAvailability). */
  sync(): Promise<void>
  /** An element of the window, or of the page. */
  el(selector: string): FakeElement
  snapshot(): string
  dispose(): Promise<void>
}

/** What a side needs to tell the page: toasts, a session on its way (its card drawn), going to a launch. */
function pageDeps(world: FakeWorld, log: string[]) {
  return {
    toast: (text: string, error = false) => log.push(`toast ${error ? 'error ' : ''}${text}`),
    onStarted: (l: LaunchView) => {
      log.push(
        `started ${l.id} ${JSON.stringify([l.name, l.cwd, l.category, l.workspace, l.newWorkspace, l.message, l.worktree, l.state, l.step, l.startedAt, l.pane, l.key])}`,
      )
      const [card] = parseHtml(`<article class="card launch-card" data-key="launch:${l.id}" id="new-card"></article>`)
      if (card?.kind === 'element') {
        world.index(card)
        world.document.documentElement.querySelector('#page')?.append(world.wrap(card))
      }
    },
  }
}

function elOf(world: FakeWorld) {
  return (selector: string): FakeElement => {
    const el = world.document.documentElement.querySelector(selector)
    if (!el) throw new Error(`no ${selector}`)
    return el
  }
}

const originOf = (world: FakeWorld, from: From | undefined): MenuOrigin | null =>
  typeof from === 'string' ? asDom(elOf(world)(`#${from}`)) : (from ?? null)

// ---------------------------------------------------------------- the old page

const NAMES = [
  'NAME_MAX',
  'UNSAFE_CHARS',
  'checkName',
  'TRANSLIT',
  'slugName',
  'checkBranch',
  'worktreePath',
  'isAbsolutePath',
  'normDir',
  'sameDir',
  'baseName',
  'splitPathInput',
  'completions',
  'categoryForDir',
  'folderSuggestions',
  'suggestName',
  'defaultWorkspace',
]

/** The baseline's modal-focus.js, which the old page made its dialogs' focus manager from. */
const OLD_MODAL_FOCUS = await oldModule('web/modal-focus.js')

/** What the old launch.js imported from its own launch-model.js and launch-drafts.js. */
function oldImports(clock: { now: () => number }): Record<string, unknown> {
  return {
    ...Object.fromEntries(oldCode('web/launch-model.js', NAMES, {})),
    ...Object.fromEntries(oldCode('web/launch-drafts.js', ['launchContext', 'launchDraftBook'], { Date: clock })),
  }
}

/** The old page's initLaunch in `world` (installed), its API called by name. */
export type OldLaunch = (name: string, ...args: unknown[]) => unknown

export function oldLaunch(world: FakeWorld, scene: LaunchScene, server: FakeServer, log: string[]): OldLaunch {
  const clock = { now: () => world.now }
  const code = oldCode('web/launch.js', ['esc', 'svg', 'ICON', 'initLaunch'], {
    ...oldImports(clock),
    reducedMotion,
    Spring,
    modalFocus: oldFunction(OLD_MODAL_FOCUS, 'modalFocusManager')(world.document),
    fetch: server.fetch,
    innerHeight: VIEWPORT.h,
    Date: clock,
  })
  const page = pageDeps(world, log)
  const ui: unknown = oldFunction(
    code,
    'initLaunch',
  )({
    t: () => scene.t,
    toast: page.toast,
    canMutate: () => scene.canMutate,
    data: () => ({
      categories: scene.categories,
      items: scene.items,
      launches: scene.launches,
      filter: scene.filter,
    }),
    onStarted: page.onStarted,
    // app.js's own, at the baseline.
    focusLaunch: oldFunction(
      oldCode('web/app.js', ['focusLaunch'], {
        canMutate: () => scene.canMutate,
        toast: page.toast,
        t: scene.t,
        fetch: server.fetch,
      }),
      'focusLaunch',
    ),
  })
  return (name, ...args) => {
    const fn: unknown = typeof ui === 'object' && ui !== null ? Reflect.get(ui, name) : undefined
    if (typeof fn !== 'function') throw new Error(`no ${name}`)
    return Reflect.apply(fn, ui, args)
  }
}

/** A world for the window: the page it opens from installed, nothing else yet. */
export const launchWorld = newWorld

export function oldLaunchSide(scene: LaunchScene): LaunchSide {
  const world = newWorld()
  const log: string[] = []
  const server = new FakeServer(log)
  const call = oldLaunch(world, scene, server, log)
  return {
    world,
    server,
    log,
    scene,
    async open(ctx, from) {
      void call('open', ctx, originOf(world, from))
      await world.flush()
    },
    async close() {
      call('close')
      await world.flush()
    },
    isOpen: () => !!call('isOpen'),
    async sync() {
      call('syncAvailability')
      await world.flush()
    },
    el: elOf(world),
    snapshot: () => snapshotOf(world, log, !!call('isOpen')),
    async dispose() {
      try {
        await world.settle()
      } finally {
        world.uninstall()
      }
    },
  }
}

// ---------------------------------------------------------------- the React port

const isDiv = (el: unknown): el is HTMLDivElement => typeof el === 'object' && el !== null && 'tagName' in el

export function reactLaunchSide(scene: LaunchScene): LaunchSide {
  const world = newWorld()
  const log: string[] = []
  const server = new FakeServer(log)
  const savedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  Object.defineProperty(globalThis, 'fetch', { value: server.fetch, configurable: true, writable: true })
  const refs: LaunchRefs = { layer: createRef(), win: createRef() }
  const focus = scopeOfElements(
    modalFocusManager(world.document),
    () => refs.layer.current,
    () => refs.win.current,
  )
  const page = pageDeps(world, log)
  const dialog = launchWindow({
    t: () => scene.t,
    canMutate: () => scene.canMutate,
    data: () => ({
      categories: scene.categories,
      items: scene.items,
      filter: scene.filter,
      profiles: scene.profiles ?? [],
    }),
    toast: page.toast,
    api: launchApi,
    layer: () => refs.layer.current,
    win: () => refs.win.current,
    focus: () => focus,
    store: localStore,
    onStarted: page.onStarted,
    now: () => world.now,
    viewportHeight: () => VIEWPORT.h,
  })
  const stopKeys = windowKeys(dialog)
  const on = launchHandlers(dialog)
  // React's part: the layer drawn into <body> once, then each draw commits what changed, and the
  // layout effect (afterDraw) runs after it.
  let drawn: { el: FakeElement; markup: Element; hosts: Host[] } | null = null
  const tree = () => (
    <LaunchDialogView
      view={dialog.view.get()}
      folder={dialog.folder.view.get()}
      launcher={dialog.launcher.get()}
      t={scene.t}
      on={on}
    />
  )
  const draw = () => {
    const node = tree()
    const next = first(reactMarkup(node))
    if (!drawn) {
      const el = world.mount(clone(next))
      const layer = asDom(el)
      const win = el.querySelector('.launch-win')
      if (!isDiv(layer) || !win) throw new Error('no window')
      refs.layer.current = layer
      refs.win.current = asDom(win)
      drawn = { el, markup: next, hosts: hostElements(node) }
    } else {
      commit(world, drawn.el.node, drawn.markup, next)
      drawn = { el: drawn.el, markup: next, hosts: hostElements(node) }
    }
    dialog.afterDraw()
  }
  const stores = () => [dialog.view.get(), dialog.folder.view.get(), dialog.launcher.get()]
  world.afterFlush = () => {
    for (let i = 0; i < 6; i++) {
      const before = stores()
      draw()
      if (stores().every((s, j) => s === before[j])) return
    }
  }
  draw()
  const stopReact = listenLikeReact(
    world.wrap(world.body),
    () => drawn?.el ?? null,
    () => drawn?.hosts ?? [],
  )
  return {
    world,
    server,
    log,
    scene,
    async open(ctx, from) {
      void dialog.open(ctx, originOf(world, from))
      await world.flush()
    },
    async close() {
      dialog.close()
      await world.flush()
    },
    isOpen: () => dialog.isOpen(),
    async sync() {
      dialog.sync()
      await world.flush()
    },
    el: elOf(world),
    snapshot: () => snapshotOf(world, log, dialog.isOpen()),
    async dispose() {
      try {
        await world.settle()
      } finally {
        dialog.stop()
        stopKeys()
        stopReact()
        world.uninstall()
        if (savedFetch) Object.defineProperty(globalThis, 'fetch', savedFetch)
        else Reflect.deleteProperty(globalThis, 'fetch')
      }
    },
  }
}
