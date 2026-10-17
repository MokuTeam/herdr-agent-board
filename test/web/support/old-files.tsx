// The chat's files both ways, for parity: the old page's files.js as it was at the parity baseline
// — its quick look (the root it builds, then labels, show, showChanges, showHistory, search,
// head, render and the parts they draw) and a chip's apply — run on a fake DOM
// (support/fake-dom.ts) with the server's answers handed in; and the React port — the quick look's
// steps (models/quick-look.ts) drawn by <QuickLookView>, a chip marked by markChip and drawn by
// <FileChip> — given the same answers. A third side runs files.js as it is now (its pure parts
// from the new models), which the old page serves until Task 27.
import type { Translator } from '../../../src/core/types.ts'
import { changesOf, historyOf, previewOf } from '../../../web/src/api/files.ts'
import { FileChip } from '../../../web/src/components/files/FileChip.tsx'
import { QuickLookView } from '../../../web/src/components/files/QuickLook.tsx'
import { markChip } from '../../../web/src/hooks/useFileChips.ts'
import { changedFiles } from '../../../web/src/models/diff.ts'
import type { PathInfo } from '../../../web/src/models/files.ts'
import * as filesModel from '../../../web/src/models/files.ts'
import { markdown } from '../../../web/src/models/markdown.ts'
import { type LookTarget, type QuickLookNav, quickLookNav } from '../../../web/src/models/quick-look.ts'
import { board, renderInBoard } from './board.tsx'
import { type FakeElement, FakeWorld } from './fake-dom.ts'
import {
  addButtonTypes,
  canonical,
  type Element,
  findAll,
  hasClass,
  type Node,
  parseHtml,
  reactMarkup,
} from './markup.ts'
import { oldCode, oldSource } from './old-app.ts'
import { withoutPreloads } from './sheet-scene.tsx'

/** What the server answers: a preview by path, a session's changes, its history by query. */
export interface FilesServer {
  preview?: (path: string) => unknown
  changes?: (key: string) => unknown
  history?: (key: string, query: string) => unknown
}

const NESTED = [
  'tr',
  'rawUrl',
  'apply',
  'labels',
  'show',
  'showChanges',
  'head',
  'syncActions',
  'render',
  'changes',
  'showHistory',
  'hits',
  'mark',
  'search',
  'kindOfName',
  'date',
  'size',
  'empty',
  'code',
  'table',
  'folder',
].map(name => ({ name, indent: '  ' }))

const never = () => new Promise<never>(() => {})
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** The old target of a step: { path, line }, { changes }, { history, cwd }. */
function oldTarget(target: LookTarget): Record<string, unknown> {
  if (target.kind === 'file') return { path: target.path, line: target.line }
  if (target.kind === 'changes') return { changes: target.key }
  return { history: target.key, cwd: target.cwd }
}

/** The old page's quick look on a fake <body>. */
export class OldLook {
  readonly world = new FakeWorld({ viewport: { w: 1200, h: 800 } })
  readonly root: FakeElement
  readonly ql = { stack: [] as Record<string, unknown>[], origin: null, seq: 0, mode: 'view', data: null as unknown }
  private readonly code: Map<string, unknown>
  canEdit = true

  /** `now`: files.js as it is now, else as it was at the parity baseline. */
  constructor(
    readonly t: Translator,
    server: FilesServer,
    token = 'tok',
    now = false,
  ) {
    const source = oldSource('web/files.js', !now)
    const template = /root\.innerHTML = `([\s\S]*?)`\r?\n/.exec(source)?.[1] ?? ''
    const diff = oldCode(
      'web/diff.js',
      ['STATUS', 'parseStatus', 'unquote', 'parseDiff', 'changedFiles'],
      {},
      {
        baseline: true,
      },
    )
    const top = oldCode('web/files.js', ['$', 'esc', 'svg', 'DOC', 'ICONS', 'iconOf'], {}, { baseline: true })
    const html = new Function('ICONS', `return \`${template}\``)(top.get('ICONS'))
    const [node] = parseHtml(`<div class="ql" hidden>${html}</div>`)
    if (node?.kind !== 'element') throw new Error('no root')
    this.root = this.world.mount(node)
    const body = this.root.querySelector('.ql-body')
    const reply = (value: unknown) => Promise.resolve({ ok: true, json: async () => value })
    // Now the icons, the kinds and the path and size helpers come from models/files.ts.
    const picked = now
      ? ['$', 'esc', ...NESTED.filter(n => n.name !== 'kindOfName')]
      : ['$', 'esc', 'svg', 'DOC', 'ICONS', 'iconOf', ...NESTED]
    const { rawUrl: rawUrlOf, ...model } = filesModel
    const imported = now ? { ...model, rawUrlOf, changedFiles } : {}
    this.code = oldCode(
      'web/files.js',
      picked,
      {
        ...imported,
        t: () => this.t,
        token: () => token,
        canMutate: () => this.canEdit,
        root: this.root,
        body,
        ql: this.ql,
        markdown,
        upgrade() {},
        changedFiles: now ? changedFiles : diff.get('changedFiles'),
        requestAnimationFrame() {},
        post: async (_url: string, b: { path: string }) => (server.preview ? server.preview(b.path) : never()),
        fetch: (url: string) => {
          const [, key = '', what, query = ''] =
            /^\/api\/session\/([^/]+)\/(changes|history)(?:\?q=(.*))?$/.exec(url) ?? []
          const k = decodeURIComponent(key)
          if (what === 'changes') return server.changes ? reply(server.changes(k)) : never()
          return server.history ? reply(server.history(k, decodeURIComponent(query))) : never()
        },
      },
      { baseline: !now },
    )
  }

  private call(name: string, ...args: unknown[]): unknown {
    const fn = this.code.get(name)
    if (typeof fn !== 'function') throw new Error(`no ${name}`)
    return fn(...args)
  }

  /** look(): the stack starts over, the root shows, its labels in the language, the step shown. */
  async open(target: LookTarget): Promise<void> {
    this.ql.stack = [oldTarget(target)]
    this.root.hidden = false
    this.call('labels')
    void this.call('show')
    await flush()
  }

  async push(target: LookTarget): Promise<void> {
    this.ql.stack.push(oldTarget(target))
    void this.call('show')
    await flush()
  }

  async back(): Promise<void> {
    this.ql.stack.pop()
    void this.call('show')
    await flush()
  }

  async refresh(): Promise<void> {
    void this.call('show', true)
    await flush()
  }

  mode(mode: 'view' | 'source'): void {
    this.ql.mode = mode
    this.call('render')
  }

  /** Typed into the search field and submitted (the submit listener: trimmed, two characters at least). */
  async search(query: string): Promise<void> {
    const input = this.root.querySelector('.ql-search input')
    if (input) input.value = query
    if (query.length >= 2) void this.call('search', this.ql.stack.at(-1), query)
    await flush()
  }

  /** files.relabel / refreshAvailability: after a change of language or of the connection. */
  relabel(t?: Translator): void {
    if (t) Object.assign(this, { t })
    this.call('labels')
    if (this.ql.data) this.call('render')
    this.call('syncActions')
  }

  markup(): Node[] {
    const nodes: Node[] = [this.root.node]
    addButtonTypes(nodes)
    return nodes
  }

  /** apply(el, info) on a candidate drawn from `html`. */
  chip(html: string, info: PathInfo): Node[] {
    const el = this.candidate(html)
    this.call('apply', el, info)
    return [el.node]
  }

  candidate(html: string): FakeElement {
    const [node] = parseHtml(html)
    if (node?.kind !== 'element') throw new Error('no candidate')
    return this.world.mount(node)
  }
}

/** The React quick look: its steps given the same answers (narrowed as the page narrows them), drawn. */
export class NewLook {
  readonly nav: QuickLookNav
  canEdit = true

  constructor(
    public t: Translator,
    server: FilesServer,
    readonly token = 'tok',
  ) {
    this.nav = quickLookNav({
      t: () => this.t,
      preview: async path => (server.preview ? previewOf(await server.preview(path)) : never()),
      changes: async key => (server.changes ? changesOf(await server.changes(key)) : never()),
      history: async (key, query) => (server.history ? historyOf(await server.history(key, query)) : never()),
      changed() {},
    })
  }

  async open(target: LookTarget): Promise<void> {
    this.nav.open(target)
    await flush()
  }
  async push(target: LookTarget): Promise<void> {
    this.nav.push(target)
    await flush()
  }
  async back(): Promise<void> {
    this.nav.back()
    await flush()
  }
  async refresh(): Promise<void> {
    this.nav.refresh()
    await flush()
  }
  mode(mode: 'view' | 'source'): void {
    this.nav.setMode(mode)
  }
  async search(query: string): Promise<void> {
    this.nav.search(query)
    await flush()
  }

  markup(): Node[] {
    const value = { ...board(), canEdit: this.canEdit }
    const nodes = renderInBoard(
      <QuickLookView view={this.nav.view()} canEdit={this.canEdit} token={this.token} />,
      value,
      this.t.lang,
    )
    return withoutPreloads(nodes)
  }

  /** markChip(el, info) on a candidate, then the chip drawn into it. */
  chip(world: FakeWorld, html: string, info: PathInfo): Node[] {
    const [node] = parseHtml(html)
    if (node?.kind !== 'element') throw new Error('no candidate')
    const el = world.mount(node)
    const content = markChip(el, info, this.t)
    if (content) node.children = reactMarkup(<FileChip {...content} />)
    return [node]
  }
}

/**
 * The view or source buttons say which is on only while Markdown is shown; hidden, their pressed
 * state is left from what the old page showed before (or not set yet), which nobody sees or reads.
 */
function hiddenModeQuiet(nodes: Node[]): Node[] {
  for (const mode of findAll(nodes, el => hasClass(el, 'ql-mode') && el.attrs.has('hidden')))
    for (const button of mode.children) if (button.kind === 'element') (button as Element).attrs.delete('aria-pressed')
  return nodes
}

/** The quick looks, stepped together: the baseline's (`old`), today's old page (`now`), the React port. */
export class BothLooks {
  readonly old: OldLook
  readonly now: OldLook
  readonly react: NewLook
  constructor(t: Translator, server: FilesServer) {
    this.old = new OldLook(t, server)
    this.now = new OldLook(t, server, 'tok', true)
    this.react = new NewLook(t, server)
  }
  private sides(): (OldLook | NewLook)[] {
    return [this.old, this.now, this.react]
  }
  async open(target: LookTarget): Promise<void> {
    for (const side of this.sides()) await side.open(target)
  }
  async push(target: LookTarget): Promise<void> {
    for (const side of this.sides()) await side.push(target)
  }
  async back(): Promise<void> {
    for (const side of this.sides()) await side.back()
  }
  async refresh(): Promise<void> {
    for (const side of this.sides()) await side.refresh()
  }
  mode(mode: 'view' | 'source'): void {
    for (const side of this.sides()) side.mode(mode)
  }
  async search(query: string): Promise<void> {
    for (const side of this.sides()) await side.search(query)
  }
  set canEdit(on: boolean) {
    for (const side of this.sides()) side.canEdit = on
    this.old.relabel()
    this.now.relabel()
  }
  language(t: Translator): void {
    this.old.relabel(t)
    this.now.relabel(t)
    this.react.t = t
  }
  looks(): { old: string; now: string; react: string } {
    return {
      old: canonical(hiddenModeQuiet(this.old.markup())),
      now: canonical(hiddenModeQuiet(this.now.markup())),
      react: canonical(hiddenModeQuiet(this.react.markup())),
    }
  }
}
