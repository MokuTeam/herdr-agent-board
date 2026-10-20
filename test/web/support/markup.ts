// Markup parity for the web board: the old page (web/index.html plus what web/app.js filled in, as
// they were at the parity baseline) against what the React components render with react-dom/server.
// A small HTML parser builds a tree both sides go through; `canonical` prints it with attributes
// and class names sorted, style declarations tidied, whitespace-only text dropped and other
// whitespace collapsed, so only real differences show. The DOM-like helpers rebuild what the old
// imperative code did.
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Translator } from '../../../src/core/types.ts'
import { oldSource } from './old-app.ts'
import { styledBy, Tree } from './stylesheets.ts'

export interface Element {
  kind: 'element'
  tag: string
  attrs: Map<string, string>
  children: Node[]
}
export interface Text {
  kind: 'text'
  text: string
}
export type Node = Element | Text

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])
const RAW = new Set(['script', 'style'])
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
    return String.fromCodePoint(code)
  })
}

const ATTR = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y

/** Parses a fragment (or a whole page) of well-formed HTML; comments and the doctype are left out. */
export function parseHtml(html: string): Node[] {
  const root: Element = { kind: 'element', tag: '#root', attrs: new Map(), children: [] }
  const open: Element[] = [root]
  const top = (): Element => open[open.length - 1] ?? root
  let i = 0
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      i = end < 0 ? html.length : end + 3
    } else if (html.startsWith('<!', i)) {
      i = html.indexOf('>', i) + 1 || html.length
    } else if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i)
      const tag = html
        .slice(i + 2, end)
        .trim()
        .toLowerCase()
      const at = open.findLastIndex(el => el.tag === tag)
      if (at > 0) open.length = at
      i = end + 1
    } else if (/^<[a-z]/i.test(html.slice(i, i + 2))) {
      i = openTag(html, i + 1, top(), open)
    } else {
      const end = html.indexOf('<', i)
      const text = html.slice(i, end < 0 ? html.length : end)
      top().children.push({ kind: 'text', text: decode(text) })
      i = end < 0 ? html.length : end
    }
  }
  return root.children
}

function openTag(html: string, start: number, parent: Element, open: Element[]): number {
  const name = /^[^\s/>]+/.exec(html.slice(start))?.[0] ?? ''
  const el: Element = { kind: 'element', tag: name.toLowerCase(), attrs: new Map(), children: [] }
  let i = start + name.length
  for (;;) {
    ATTR.lastIndex = i
    const m = ATTR.exec(html)
    if (!m || m.index !== i || !m[1]) break
    el.attrs.set(m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ''))
    i = ATTR.lastIndex
  }
  const close = html.indexOf('>', i)
  const selfClosing = html.slice(i, close).trim() === '/'
  parent.children.push(el)
  i = close + 1
  if (RAW.has(el.tag)) {
    const end = html.indexOf(`</${el.tag}`, i)
    const text = html.slice(i, end)
    if (text) el.children.push({ kind: 'text', text })
    return html.indexOf('>', end) + 1
  }
  if (!selfClosing && !VOID.has(el.tag)) open.push(el)
  return i
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

function attrValue(name: string, value: string): string {
  if (name === 'class') return value.split(/\s+/).filter(Boolean).sort().join(' ')
  if (name === 'style')
    return value
      .split(';')
      .map(d => d.trim().replace(/\s*:\s*/, ':'))
      .filter(Boolean)
      .join(';')
  return value
}

export interface CanonicalOptions {
  /**
   * Keep whitespace-only text between elements (as one space, printed `' '`), for inline markup
   * where a space shows: a card's `<b>Asks:</b> <span class="qa-tag">…`. Off, such text is
   * dropped, as indentation in web/index.html must be.
   */
  spaces?: boolean
}

/** Adjacent texts as one (react-dom/server splits them with `<!-- -->`, which the parser drops). */
function joinTexts(nodes: Node[]): Node[] {
  const joined: Node[] = []
  for (const node of nodes) {
    const last = joined[joined.length - 1]
    if (node.kind === 'text' && last?.kind === 'text')
      joined[joined.length - 1] = { kind: 'text', text: last.text + node.text }
    else joined.push(node)
  }
  return joined
}

/**
 * React turns a glyph in a box of its own (components/icons.tsx Turn, #109) where the old page
 * turned the SVG itself: the box is left out and its glyph compared in its place.
 */
const unwrapTurns = (nodes: Node[]): Node[] =>
  nodes.flatMap(n => (n.kind === 'element' && n.tag === 'span' && hasClass(n, 'turn') ? unwrapTurns(n.children) : [n]))

const visible = (nodes: Node[], spaces = false): Node[] =>
  joinTexts(unwrapTurns(nodes)).filter(n => n.kind === 'element' || spaces || n.text.trim() !== '')
const collapse = (text: string) => text.replace(/\s+/g, ' ')
const textLine = (text: string) => (text.trim() === '' ? "' '" : escapeText(collapse(text)))

/** The tree as text, one element per line, in a form both sides agree on when they mean the same. */
export function canonical(nodes: Node[], options: CanonicalOptions = {}, depth = 0): string {
  const pad = '  '.repeat(depth)
  return visible(nodes, options.spaces)
    .map(node => {
      if (node.kind === 'text') return pad + textLine(node.text)
      const attrs = [...node.attrs]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, value]) => ` ${name}="${escapeAttr(attrValue(name, value))}"`)
        .join('')
      const children = visible(node.children, options.spaces)
      if (VOID.has(node.tag)) return `${pad}<${node.tag}${attrs}>`
      if (children.every(c => c.kind === 'text'))
        return `${pad}<${node.tag}${attrs}>${children.map(c => (c.kind === 'text' ? escapeText(collapse(c.text)) : '')).join('')}</${node.tag}>`
      return `${pad}<${node.tag}${attrs}>\n${canonical(children, options, depth + 1)}\n${pad}</${node.tag}>`
    })
    .join('\n')
}

// ---------------------------------------------------------------- the two sides

/**
 * Elements upstream's web/index.html gained after the parity baseline, in changes ported since:
 * [the change's merge commit, the element's id, the id of the element it follows there].
 */
const LATER_ELEMENTS: [string, string, string][] = [
  ['0d33639', 'sheet-helpers', 'sheet-question'], // #40: a session's helpers above its conversation
  ['2b9e6b7', 'archive-sheet', 'sched-sheet'], // #56: the archive's panel after the schedule's
]

/** `el` put right after the element with id `after`, wherever that is in `nodes`. */
function insertAfter(nodes: Node[], after: string, el: Element): boolean {
  const at = nodes.findIndex(n => n.kind === 'element' && n.attrs.get('id') === after)
  if (at >= 0) {
    nodes.splice(at + 1, 0, el)
    return true
  }
  return nodes.some(n => n.kind === 'element' && insertAfter(n.children, after, el))
}

/**
 * The old page's web/index.html (at the parity baseline, or at `ref`: today's holds only the React
 * root), parsed, with the elements later ported changes added to it (those it lacks), taken from
 * the page as each change left it.
 */
export function pageMarkup(ref?: string): Node[] {
  const nodes = parseHtml(ref === undefined ? oldSource('web/index.html') : oldSource('web/index.html', ref))
  for (const [later, id, after] of LATER_ELEMENTS) {
    if (findAll(nodes, el => el.attrs.get('id') === id).length) continue
    const el = byId(parseHtml(oldSource('web/index.html', later)), id)
    if (!insertAfter(nodes, after, el)) throw new Error(`no #${after} for #${id}`)
  }
  return nodes
}

/** A tree back to markup (`innerHTML`). */
export function serializeNodes(nodes: Node[]): string {
  return nodes
    .map(n => {
      if (n.kind === 'text') return escapeText(n.text)
      const attrs = [...n.attrs].map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
      return VOID.has(n.tag) ? `<${n.tag}${attrs}>` : `<${n.tag}${attrs}>${serializeNodes(n.children)}</${n.tag}>`
    })
    .join('')
}

/** What a React tree renders on the server, parsed. */
export function reactMarkup(node: ReactNode): Node[] {
  return parseHtml(renderToStaticMarkup(node))
}

// ---------------------------------------------------------------- DOM-like helpers

const elements = (nodes: Node[]): Element[] => nodes.filter((n): n is Element => n.kind === 'element')

export function findAll(nodes: Node[], match: (el: Element) => boolean): Element[] {
  const found: Element[] = []
  for (const el of elements(nodes)) {
    if (match(el)) found.push(el)
    found.push(...findAll(el.children, match))
  }
  return found
}

export function find(nodes: Node[], match: (el: Element) => boolean): Element {
  const el = findAll(nodes, match)[0]
  if (!el) throw new Error('no such element')
  return el
}

export const hasClass = (el: Element, name: string): boolean =>
  (el.attrs.get('class') ?? '').split(/\s+/).includes(name)

export const byId = (nodes: Node[], id: string): Element => find(nodes, el => el.attrs.get('id') === id)

export const byClass = (nodes: Node[], name: string): Element => find(nodes, el => hasClass(el, name))

/** `textContent = text`. */
export function setText(el: Element, text: string): void {
  el.children = [{ kind: 'text', text }]
}

/** `innerHTML = html`. */
export function setHtml(el: Element, html: string): void {
  el.children = parseHtml(html)
}

export function setAttr(el: Element, name: string, value: string): void {
  el.attrs.set(name, value)
}

export function removeAttr(el: Element, name: string): void {
  el.attrs.delete(name)
}

/** `el.hidden = on`, `el.disabled = on` and the like. */
export function toggleAttr(el: Element, name: string, on: boolean): void {
  if (on) el.attrs.set(name, '')
  else el.attrs.delete(name)
}

/** `classList.toggle(name, on)`. */
export function toggleClass(el: Element, name: string, on: boolean): void {
  const names = (el.attrs.get('class') ?? '').split(/\s+/).filter(n => n && n !== name)
  el.attrs.set('class', [...names, ...(on ? [name] : [])].join(' '))
}

export function prepend(el: Element, html: string): void {
  el.children = [...parseHtml(html), ...el.children]
}

export function append(el: Element, html: string): void {
  el.children = [...el.children, ...parseHtml(html)]
}

/** The static texts by their data-i18n attributes, as web/app.js `applyTexts()` filled them. */
export function applyTexts(nodes: Node[], t: Translator): void {
  for (const el of findAll(nodes, () => true)) {
    const text = el.attrs.get('data-i18n')
    const title = el.attrs.get('data-i18n-title')
    const label = el.attrs.get('data-i18n-label')
    const placeholder = el.attrs.get('data-i18n-placeholder')
    if (text !== undefined) setText(el, t(text))
    if (title !== undefined) setAttr(el, 'title', t(title))
    if (label !== undefined) setAttr(el, 'aria-label', t(label))
    if (placeholder !== undefined) setAttr(el, 'placeholder', t(placeholder))
  }
}

/**
 * Attributes the old imperative code needed: the i18n keys `applyTexts()` read (React renders the
 * texts themselves), the key of a title set later (`data-hint`) and a re-render cache (`data-sig`).
 * A stylesheet reads one of them in places: the icon-only toolbar buttons hide their labels by
 * `span[data-i18n]` (upstream #43). `stripAttrs` keeps those, so React must render them there.
 */
export const OLD_PAGE_ONLY = [
  'data-i18n',
  'data-i18n-title',
  'data-i18n-label',
  'data-i18n-placeholder',
  'data-hint',
  'data-sig',
]

/**
 * The attributes dropped from a tree, except where a rule of the page's stylesheets selects by one
 * (support/stylesheets.ts): there the attribute is part of how the page looks, and both sides must
 * have it.
 */
export function stripAttrs(nodes: Node[], names: string[]): void {
  const tree = new Tree(nodes)
  for (const el of findAll(nodes, () => true))
    for (const name of names) if (el.attrs.has(name) && !styledBy(el, name, tree)) el.attrs.delete(name)
}

/**
 * React buttons say `type="button"` (Biome a11y/useButtonType); the old page's buttons without a type sit
 * outside any form, where the two behave the same and no stylesheet tells them apart.
 */
export function addButtonTypes(nodes: Node[]): void {
  for (const el of findAll(nodes, el => el.tag === 'button' && !el.attrs.has('type'))) setAttr(el, 'type', 'button')
}
