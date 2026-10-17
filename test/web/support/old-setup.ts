// The setup note both ways, for parity: upstream's web/setup.js as its merge left it (the setup
// check came after the parity baseline, so its own merge is the old side) run on a fake DOM
// (support/fake-dom.ts) over the note and the list of that merge's web/index.html, the server's
// answer handed in; the React side is SetupNote and SetupPop given the same state.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Translator } from '../../../src/core/types.ts'
import { type FakeElement, FakeWorld, type RectBox } from './fake-dom.ts'
import {
  addButtonTypes,
  applyTexts,
  byId,
  canonical,
  type Element,
  type Node,
  OLD_PAGE_ONLY,
  parseHtml,
  stripAttrs,
} from './markup.ts'

/** Upstream's merge of the setup check (PR #41). */
export const SETUP_MERGE = 'a496257'
const ROOT = join(import.meta.dir, '..', '..', '..')

function upstream(file: string): string {
  const git = Bun.spawnSync(['git', 'show', `${SETUP_MERGE}:${file}`], { cwd: ROOT })
  if (git.exitCode !== 0) throw new Error(`git show ${SETUP_MERGE}:${file} failed`)
  return git.stdout.toString()
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

type OldNote = { render(summary: unknown): void; isOpen(): boolean; close(refocus?: boolean): void }
type InitSetupNote = (deps: {
  t: () => Translator
  esc: typeof esc
  store: { get(key: string, fallback: string): string; set(key: string, value: string): void }
  onDialogChange?: () => void
}) => OldNote

let module: Promise<InitSetupNote> | null = null

/** setup.js and the spring.js it imports, loaded once from a temp folder (a world installed first: spring.js asks matchMedia). */
function oldModule(): Promise<InitSetupNote> {
  module ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-board-setup-'))
    try {
      writeFileSync(join(dir, 'spring.js'), upstream('web/spring.js'))
      writeFileSync(join(dir, 'setup.js'), upstream('web/setup.js'))
      const mod: unknown = await import(pathToFileURL(join(dir, 'setup.js')).href)
      const init = (mod as { initSetupNote?: unknown }).initSetupNote
      if (typeof init !== 'function') throw new Error('no initSetupNote')
      return init as InitSetupNote
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
  return module
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** What fetch('/api/setup') does: answer with a body, never answer, or fail. */
export type SetupServer = { reply: unknown } | 'pending' | 'fails'

/** The old note and list on a fake <body>, with a search field to give the focus back to. */
export class OldSetup {
  readonly world: FakeWorld
  readonly note: Element
  readonly pop: Element
  readonly storage = new Map<string, string>()
  private api: OldNote | null = null
  private saved: Record<string, PropertyDescriptor | undefined> = {}

  constructor(
    readonly t: Translator,
    readonly server: SetupServer,
    rects: (el: FakeElement) => RectBox | null = () => null,
  ) {
    this.world = new FakeWorld({ viewport: { w: 1200, h: 800 }, rects })
    const page = parseHtml(upstream('web/index.html'))
    applyTexts(page, t)
    this.note = byId(page, 'setup-note')
    this.pop = byId(page, 'setup-pop')
    const [search] = parseHtml('<input id="search" type="search">')
    for (const node of [search, this.note, this.pop]) if (node?.kind === 'element') this.world.mount(node)
  }

  /** The old page's start: the world's globals, a window size and the server's answer, then initSetupNote. */
  async start(): Promise<void> {
    this.world.install()
    const answer = (): Promise<unknown> => {
      if (this.server === 'pending') return new Promise(() => {})
      if (this.server === 'fails') return Promise.reject(new Error('offline'))
      const body = this.server.reply
      return Promise.resolve({ ok: true, status: 200, json: async () => body })
    }
    const globals: Record<string, unknown> = {
      fetch: answer,
      innerWidth: 1200,
      innerHeight: 800,
      navigator: { clipboard: { writeText: async () => {} } },
    }
    for (const [name, value] of Object.entries(globals)) {
      this.saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    }
    const init = await oldModule()
    this.api = init({
      t: () => this.t,
      esc,
      store: {
        get: (key, fallback) => this.storage.get(key) ?? fallback,
        set: (key, value) => void this.storage.set(key, value),
      },
    })
  }

  stop(): void {
    for (const [name, descriptor] of Object.entries(this.saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    this.saved = {}
    this.world.uninstall()
  }

  /** The board sent its summary (renderLimits passes it on). */
  render(summary: unknown): void {
    this.api?.render(summary)
  }

  /** A click on the note, then whatever the answer brings. */
  async click(el: Element = this.note): Promise<void> {
    await this.world.fire(this.world.wrap(el), 'click')
    await settle()
  }

  /** The element that `selector` finds in the list. */
  find(selector: string): Element {
    const el = this.world.wrap(this.pop).querySelector(selector)
    if (!el) throw new Error(`no ${selector}`)
    return el.node
  }

  /** The list's inline style as the old code left it: { left, top, 'transform-origin', … }. */
  popStyle(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const decl of (this.pop.attrs.get('style') ?? '').split(';')) {
      const [name, ...value] = decl.split(':')
      if (name?.trim()) out[name.trim()] = value.join(':').trim()
    }
    return out
  }
}

/** The old markup as React renders it: no i18n keys, typed buttons, no inline style (motion, place). */
export function oldMarkup(node: Node): string {
  const nodes = [structuredClone(node)]
  stripAttrs(nodes, [...OLD_PAGE_ONLY, 'style'])
  addButtonTypes(nodes)
  return canonical(nodes)
}

/** The React markup the same way. */
export function newMarkup(nodes: Node[]): string {
  stripAttrs(nodes, ['style'])
  return canonical(nodes)
}

export { esc }
