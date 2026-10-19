// The page's stylesheets (web/styles/*.css) read as selectors, for the parity checks: which
// attributes their rules select by, on which element of the selector, and whether an element of a
// markup tree (support/markup.ts) could be that element. "Could": what the markup cannot tell
// (hover, focus, `:not()`, `:has()`, ancestors above the tree drawn) counts as matching.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Element, Node } from './markup.ts'

export interface AttrTest {
  name: string
  /** '' for `[name]`, else the operator: `=`, `~=`, `|=`, `^=`, `$=` or `*=`. */
  op: string
  value: string | null
}
export interface Pseudo {
  name: string
  /** The selectors in `:not()`, `:is()`, `:where()` and `:has()`; null for other pseudo-classes. */
  args: Complex[] | null
}
export interface Compound {
  tag: string | null
  id: string | null
  classes: string[]
  attrs: AttrTest[]
  pseudos: Pseudo[]
}
export type Combinator = ' ' | '>' | '+' | '~'
/** compounds[i + 1] stands in `combinators[i]` to compounds[i]; the last compound is the subject. */
export interface Complex {
  compounds: Compound[]
  combinators: Combinator[]
}

export interface StyleRule {
  sheet: string
  selector: string
  complex: Complex
}

/** One attribute a rule selects by: on its compound, the selector up to that compound being its element. */
export interface AttributeRead {
  sheet: string
  selector: string
  attr: AttrTest
  compound: Compound
  /** The selector cut after the compound (a `:has()` argument starts afresh). */
  upTo: Complex
}

const SELECTOR_LISTS = new Set(['not', 'is', 'where', 'has', 'matches'])
const GROUPING = new Set(['media', 'container', 'supports', 'layer', 'document', 'scope', 'starting-style'])

/** Where the quoted string starting at `i` ends. */
function skipQuoted(text: string, i: number): number {
  const quote = text[i]
  let j = i + 1
  while (j < text.length && text[j] !== quote) j += text[j] === '\\' ? 2 : 1
  return j + 1
}

/** Where the block opened at `open` closes. */
function skipBlock(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    const c = css[i]
    if (c === '"' || c === "'") i = skipQuoted(css, i) - 1
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
  }
  return css.length
}

/** The style rules' selectors of a sheet, also those inside @media, @container and @supports. */
export function selectorsOf(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: string[] = []
  const walk = (from: number, to: number) => {
    let i = from
    while (i < to) {
      const brace = text.indexOf('{', i)
      const semi = text.indexOf(';', i)
      const close = text.indexOf('}', i)
      if (brace < 0 || brace >= to || (close >= 0 && close < brace)) return
      if (semi >= 0 && semi < brace && text.slice(i, semi).trim().startsWith('@')) {
        i = semi + 1
        continue
      }
      const prelude = text.slice(i, brace).trim()
      const end = skipBlock(text, brace)
      const at = /^@([\w-]+)/.exec(prelude)
      if (at?.[1] && GROUPING.has(at[1])) walk(brace + 1, end - 1)
      else if (!at && prelude) found.push(prelude.replace(/\s+/g, ' '))
      i = end
    }
  }
  walk(0, text.length)
  return found
}

/** `text` split at `sep` where it stands outside brackets, parentheses and quotes. */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") i = skipQuoted(text, i) - 1
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map(p => p.trim()).filter(Boolean)
}

/** Where the parenthesised run starting at `open` closes. */
function closeParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") i = skipQuoted(text, i) - 1
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  throw new Error(`unclosed ( in ${text}`)
}

const IDENT = /^-?[_a-zA-Z\\-][\w\\-]*/
const ATTR_TEST = /^\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*(?:[is]\s*)?)?\]$/

const emptyCompound = (): Compound => ({ tag: null, id: null, classes: [], attrs: [], pseudos: [] })

/** One selector of a list: its compounds and the combinators between them. */
export function parseComplex(selector: string): Complex {
  const compounds: Compound[] = []
  const combinators: Combinator[] = []
  let current = emptyCompound()
  let empty = true
  let pending: Combinator | null = null
  const startCompound = () => {
    if (!empty) return
    // A `:has()` argument may start with its combinator: relative to the element, left out here.
    if (compounds.length) combinators.push(pending ?? ' ')
    pending = null
    empty = false
    compounds.push(current)
  }
  let i = 0
  while (i < selector.length) {
    const c = selector[i] ?? ''
    if (/\s/.test(c) || c === '>' || c === '+' || c === '~') {
      if (c === '>' || c === '+' || c === '~') pending = c
      else if (!empty && pending === null) pending = ' '
      if (!empty) {
        current = emptyCompound()
        empty = true
      }
      i++
      continue
    }
    startCompound()
    const rest = selector.slice(i)
    if (c === '*') i++
    else if (c === '#' || c === '.') {
      const name = IDENT.exec(rest.slice(1))?.[0]
      if (!name) throw new Error(`bad selector ${selector}`)
      if (c === '#') current.id = name
      else current.classes.push(name)
      i += 1 + name.length
    } else if (c === '[') {
      const end = selector.indexOf(']', i)
      const m = ATTR_TEST.exec(selector.slice(i, end + 1))
      if (!m?.[1]) throw new Error(`bad attribute in ${selector}`)
      current.attrs.push({
        name: m[1].toLowerCase(),
        op: m[2] ?? '',
        value: m[2] ? (m[3] ?? m[4] ?? m[5] ?? '') : null,
      })
      i = end + 1
    } else if (c === ':') {
      const element = selector[i + 1] === ':'
      const at = i + (element ? 2 : 1)
      const name = IDENT.exec(selector.slice(at))?.[0]
      if (!name) throw new Error(`bad pseudo in ${selector}`)
      i = at + name.length
      let args: Complex[] | null = null
      if (selector[i] === '(') {
        const close = closeParen(selector, i)
        if (SELECTOR_LISTS.has(name)) args = splitTop(selector.slice(i + 1, close), ',').map(parseComplex)
        i = close + 1
      }
      if (!element) current.pseudos.push({ name, args })
    } else {
      const name = IDENT.exec(rest)?.[0]
      if (!name) throw new Error(`bad selector ${selector} at ${i}`)
      current.tag = name.toLowerCase()
      i += name.length
    }
  }
  return { compounds, combinators }
}

/** The selectors of a sheet's rules, each selector of a list on its own. */
export function rulesOf(sheet: string, css: string): StyleRule[] {
  return selectorsOf(css).flatMap(list =>
    splitTop(list, ',').map(selector => ({ sheet, selector, complex: parseComplex(selector) })),
  )
}

/** Every attribute test of a selector, with the part of it that ends on the test's element. */
function readsOf(sheet: string, selector: string, complex: Complex): AttributeRead[] {
  return complex.compounds.flatMap((compound, at) => {
    const upTo: Complex = {
      compounds: complex.compounds.slice(0, at + 1),
      combinators: complex.combinators.slice(0, at),
    }
    const own = compound.attrs.map(attr => ({ sheet, selector, attr, compound, upTo }))
    // In `:not()` or `:is()` of one compound, an attribute is read on this element; a `:has()`
    // argument, or a longer selector in one, reads on elements of its own.
    const inner = compound.pseudos.flatMap(p =>
      (p.args ?? []).flatMap(arg =>
        p.name === 'has'
          ? readsOf(sheet, selector, arg)
          : arg.compounds.length === 1
            ? (arg.compounds[0]?.attrs ?? []).map(attr => ({ sheet, selector, attr, compound, upTo }))
            : readsOf(sheet, selector, arg),
      ),
    )
    return [...own, ...inner]
  })
}

/** Every attribute the rules select by. */
export function attributeReads(rules: StyleRule[]): AttributeRead[] {
  return rules.flatMap(rule => readsOf(rule.sheet, rule.selector, rule.complex))
}

const STYLES = join(import.meta.dir, '..', '..', '..', 'web', 'styles')
let pageRules: StyleRule[] | null = null
let pageReads: AttributeRead[] | null = null

/** The rules of every sheet the page loads (web/styles/*.css), read once. */
export function pageStyleRules(): StyleRule[] {
  pageRules ??= readdirSync(STYLES)
    .filter(f => f.endsWith('.css'))
    .sort()
    .flatMap(sheet => rulesOf(sheet, readFileSync(join(STYLES, sheet), 'utf8')))
  return pageRules
}

// ---------------------------------------------------------------- matching a markup tree

/** Parents and siblings of the elements of a tree, which markup nodes do not keep. */
export class Tree {
  private readonly parents = new Map<Element, Element | null>()
  private readonly rows = new Map<Element, Element[]>()
  constructor(nodes: Node[]) {
    this.index(nodes, null)
  }
  private index(nodes: Node[], parent: Element | null): void {
    const row = nodes.filter((n): n is Element => n.kind === 'element')
    for (const el of row) {
      this.parents.set(el, parent)
      this.rows.set(el, row)
      this.index(el.children, el)
    }
  }
  parentOf(el: Element): Element | null {
    return this.parents.get(el) ?? null
  }
  before(el: Element): Element[] {
    const row = this.rows.get(el) ?? []
    return row.slice(0, row.indexOf(el)).reverse()
  }
}

/** Whether an attribute's value passes the test (the attribute being there). */
export function valueHolds(test: AttrTest, value: string): boolean {
  const want = test.value ?? ''
  switch (test.op) {
    case '':
      return true
    case '=':
      return value === want
    case '~=':
      return value.split(/\s+/).includes(want)
    case '|=':
      return value === want || value.startsWith(`${want}-`)
    case '^=':
      return value.startsWith(want)
    case '$=':
      return value.endsWith(want)
    default:
      return value.includes(want)
  }
}

function attrHolds(test: AttrTest, el: Element): boolean {
  const value = el.attrs.get(test.name)
  return value !== undefined && valueHolds(test, value)
}

/** The compound on `el`; pseudo-classes other than `:root` are taken to hold. */
export function compoundCould(c: Compound, el: Element): boolean {
  if (c.tag && c.tag !== el.tag) return false
  if (c.id && el.attrs.get('id') !== c.id) return false
  const classes = (el.attrs.get('class') ?? '').split(/\s+/)
  if (!c.classes.every(name => classes.includes(name))) return false
  if (c.pseudos.some(p => p.name === 'root') && el.tag !== 'html') return false
  return c.attrs.every(test => attrHolds(test, el))
}

/** Whether `el` could be the subject of `complex` in the page around `tree`. */
export function selectorCould(complex: Complex, el: Element, tree: Tree, at = complex.compounds.length - 1): boolean {
  const compound = complex.compounds[at]
  if (!compound || !compoundCould(compound, el)) return false
  if (at === 0) return true
  const rest = (other: Element) => selectorCould(complex, other, tree, at - 1)
  const parent = tree.parentOf(el)
  switch (complex.combinators[at - 1]) {
    case '>':
      return parent === null ? !inPage(el, tree) : rest(parent)
    case '+': {
      const prev = tree.before(el)[0]
      return prev !== undefined && rest(prev)
    }
    case '~':
      return tree.before(el).some(rest)
    default:
      for (let up = parent; up; up = tree.parentOf(up)) if (rest(up)) return true
      return !inPage(el, tree)
  }
}

/** Whether the tree holds the whole page around `el`; else what is above the tree drawn could match. */
function inPage(el: Element, tree: Tree): boolean {
  let top = el
  for (let up = tree.parentOf(el); up; up = tree.parentOf(up)) top = up
  return top.tag === 'html'
}

/** Whether a page rule selects by `name` on `el`: there React must render the attribute too. */
export function styledBy(el: Element, name: string, tree: Tree): boolean {
  pageReads ??= attributeReads(pageStyleRules())
  return pageReads.some(read => read.attr.name === name && selectorCould(read.upTo, el, tree))
}
