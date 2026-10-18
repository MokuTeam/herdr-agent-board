// Which elements of a page's sources carry which attributes, read from the code itself rather than
// from a render, so a whole page is seen at once, its rarely drawn corners too: the elements of an
// HTML page, the HTML a script builds in its strings and template literals (upstream's web/*.js),
// the elements and components a React file writes in JSX (web/src/**/*.tsx), and the attributes
// code sets at run time (`el.dataset.x =`, `setAttribute('x', …)`, `el.hidden =`, …) on elements
// the source does not name. What a source leaves to run time may hold anything: a value
// (`data-col="${col}"`, `data-col={column}`), a class (`class="card ${col}"`), or, from a template's
// `<div ${attrs}>`, any attribute.
import { type Element, findAll, parseHtml } from './markup.ts'
import { type AttrTest, type Compound, valueHolds } from './stylesheets.ts'

export interface Carrier {
  /** The file and the line the element is written on. */
  where: string
  /** The element's tag; null for a React component (whatever it draws). */
  tag: string | null
  /** Its classes; with `anyClass`, the classes it may have beyond them. */
  classes: Set<string>
  anyClass: boolean
  /** Attribute names (lowercase) and their values, null where only run time knows the value. */
  attrs: Map<string, string | null>
  /** Attributes are left to run time: any attribute may be there. */
  anyAttr: boolean
}

const lineAt = (source: string, at: number) => source.slice(0, at).split('\n').length

const blank = (tag: string | null): Carrier => ({
  where: '',
  tag,
  classes: new Set(),
  anyClass: false,
  attrs: new Map(),
  anyAttr: false,
})

// ---------------------------------------------------------------- HTML pages

/** Every element of an HTML page. */
export function pageCarriers(file: string, html: string): Carrier[] {
  return findAll(parseHtml(html), () => true).map((el: Element) => ({
    ...blank(el.tag),
    where: file,
    classes: new Set((el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean)),
    attrs: new Map([...el.attrs].filter(([name]) => name !== 'class')),
  }))
}

// ---------------------------------------------------------------- scanning code

/** Where the string, template literal or comment starting at `i` ends (`i` itself when none starts there). */
function skipLiteral(src: string, i: number): number {
  const c = src[i]
  if (c === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i)
    return end < 0 ? src.length : end
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2)
    return end < 0 ? src.length : end + 2
  }
  if (c === '"' || c === "'") {
    let j = i + 1
    while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
    return j + 1
  }
  if (c === '`') {
    let j = i + 1
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') j += 2
      else if (src[j] === '$' && src[j + 1] === '{') j = closeBrace(src, j + 1) + 1
      else j++
    }
    return j + 1
  }
  return i
}

/** Where the brace opened at `open` closes, strings, templates and comments skipped. */
function closeBrace(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const skipped = skipLiteral(src, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return i
    i++
  }
  return src.length
}

/** The parts of an expression between its top-level `sep`s (outside brackets, strings and templates). */
function splitTop(expr: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < expr.length) {
    const skipped = skipLiteral(expr, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    const c = expr[i] ?? ''
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(start, i))
      i += sep.length
      start = i
      continue
    }
    i++
  }
  parts.push(expr.slice(start))
  return parts
}

/** `cond ? a : b` at the top level of an expression: its two branches. */
function branches(expr: string): [string, string] | null {
  let depth = 0
  let ask = -1
  let nested = 0
  let i = 0
  while (i < expr.length) {
    const skipped = skipLiteral(expr, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    const c = expr[i] ?? ''
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && c === '?' && !'.?'.includes(expr[i + 1] ?? '') && expr[i - 1] !== '?') {
      if (ask < 0) ask = i
      else nested++
    } else if (depth === 0 && c === ':' && ask >= 0) {
      if (nested-- === 0) return [expr.slice(ask + 1, i), expr.slice(i + 1)]
    }
    i++
  }
  return null
}

/** An expression without the parentheses around all of it. */
function unwrap(expr: string): string {
  let e = expr.trim()
  while (e.startsWith('(') && closeParen(e) === e.length - 1) e = e.slice(1, -1).trim()
  return e
}

function closeParen(expr: string): number {
  let depth = 0
  for (let i = 0; i < expr.length; i++) {
    const skipped = skipLiteral(expr, i)
    if (skipped !== i) i = skipped - 1
    else if (expr[i] === '(') depth++
    else if (expr[i] === ')' && --depth === 0) return i
  }
  return -1
}

/** A template literal's static text and the expressions of its `${…}`. */
function templateParts(literal: string): { statics: string[]; holes: string[] } {
  const statics: string[] = []
  const holes: string[] = []
  let text = ''
  let i = 1
  while (i < literal.length - 1) {
    if (literal[i] === '\\') {
      text += literal.slice(i, i + 2)
      i += 2
    } else if (literal[i] === '$' && literal[i + 1] === '{') {
      const close = closeBrace(literal, i + 1)
      statics.push(text)
      text = ''
      holes.push(literal.slice(i + 2, close))
      i = close + 1
    } else text += literal[i++]
  }
  statics.push(text)
  return { statics, holes }
}

/** What an expression gives as far as its text tells: strings, and whether it may give others. */
interface Outcome {
  texts: string[]
  open: boolean
}
const NOTHING: Outcome = { texts: [], open: false }
const either = (outcomes: Outcome[]): Outcome => ({
  texts: outcomes.flatMap(o => o.texts),
  open: outcomes.some(o => o.open),
})

/**
 * The strings an expression may give: its literals and the choices between them (`a ? 'x' : ''`,
 * `on && ' hidden'`, `a || 'x'`, `classNames('a', on && 'b')`), a template's text with what its
 * holes give (`marked`: each hole as a marker instead, for a value only run time knows). Anything
 * else (a name, a call) is `open`: it may give any string.
 */
function outcomes(expr: string, marked = false, names: ReadonlyMap<string, string> = new Map()): Outcome {
  const e = unwrap(expr)
  if (e === '' || /^(?:true|false|null|undefined)$/.test(e)) return NOTHING
  const held = names.get(e)
  if (held !== undefined) return outcomes(held, marked, new Map([...names].filter(([name]) => name !== e)))
  if ((e[0] === "'" || e[0] === '"') && skipLiteral(e, 0) === e.length) return { texts: [e.slice(1, -1)], open: false }
  if (e[0] === '`' && skipLiteral(e, 0) === e.length) {
    const { statics, holes } = templateParts(e)
    if (marked) return { texts: [statics.join(MARK)], open: false }
    return either([{ texts: statics, open: false }, ...holes.map(h => outcomes(h, false, names))])
  }
  const chosen = branches(e)
  if (chosen) return either(chosen.map(b => outcomes(b, marked, names)))
  for (const op of ['||', '??']) {
    const parts = splitTop(e, op)
    if (parts.length > 1) return either(parts.map(p => outcomes(p, marked, names)))
  }
  const all = splitTop(e, '&&')
  if (all.length > 1) return outcomes(all[all.length - 1] ?? '', marked, names)
  const call = /^classNames\(([\s\S]*)\)$/.exec(e)
  if (call && closeParen(e.slice('classNames'.length)) === e.length - 'classNames'.length - 1)
    return either(splitTop(call[1] ?? '', ',').map(arg => outcomes(arg, false, names)))
  return { texts: [], open: true }
}

function addClasses(carrier: Carrier, outcome: Outcome): void {
  for (const text of outcome.texts) for (const name of text.split(/\s+/)) if (name) carrier.classes.add(name)
  if (outcome.open) carrier.anyClass = true
}

// ---------------------------------------------------------------- HTML in strings and template literals

/** A value only run time knows, in a template's text. */
const MARK = '\uE000'
const TAG_ATTR = /\s*(\uE001\d+\uE002|[^\s"'>/=\uE000\uE001]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y
const HOLE_AT = /^\uE001(\d+)\uE002$/
const HOLES = /\uE001(\d+)\uE002/g

interface Hole {
  expr: string
  /** The line of the script it starts on. */
  line: number
}

/**
 * A script's text with its comments blanked and each `${…}` of its template literals as a
 * numbered hole (its line breaks kept after it, so the lines still count), the holes apart.
 */
function holed(src: string, line: number): { text: string; holes: Hole[] } {
  const holes: Hole[] = []
  let text = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '`') {
      text += src[i++]
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') {
          text += src.slice(i, i + 2)
          i += 2
        } else if (src[i] === '$' && src[i + 1] === '{') {
          const close = closeBrace(src, i + 1)
          const expr = src.slice(i + 2, close)
          holes.push({ expr, line: line + lineAt(text, text.length) - 1 })
          text += `\uE001${holes.length - 1}\uE002${'\n'.repeat(expr.split('\n').length - 1)}`
          i = close + 1
        } else text += src[i++]
      }
      text += src[i++] ?? ''
      continue
    }
    const skipped = skipLiteral(src, i)
    if (skipped === i) text += src[i++]
    else {
      const literal = src.slice(i, skipped)
      text += src[i] === '/' ? literal.replace(/[^\n]/g, ' ') : literal
      i = skipped
    }
  }
  return { text, holes }
}

/** The elements written in the HTML of a script's strings and template literals, nested ones too. */
export function templateCarriers(file: string, js: string, line = 1): Carrier[] {
  const { text, holes } = holed(js, line)
  const exprs = holes.map(h => h.expr)
  const found: Carrier[] = []
  for (const m of text.matchAll(/<([a-zA-Z][\w-]*)/g)) {
    const carrier = tagAt(text, exprs, m.index + m[0].length, (m[1] ?? '').toLowerCase())
    if (carrier) found.push({ ...carrier, where: `${file}:${line + lineAt(text, m.index) - 1}` })
  }
  for (const hole of holes) found.push(...templateCarriers(file, hole.expr, hole.line))
  return found
}

/** The tag whose attributes start at `from`, if a `>` closes it. */
function tagAt(text: string, holes: string[], from: number, tag: string): Carrier | null {
  const carrier = blank(tag)
  const end = readAttrs(carrier, text, from, holes)
  const rest = text.slice(end).trimStart()
  return rest.startsWith('>') || rest.startsWith('/>') ? carrier : null
}

/** The attributes written from `from` on into the carrier; where they end. */
function readAttrs(carrier: Carrier, text: string, from: number, holes: string[]): number {
  let i = from
  for (;;) {
    TAG_ATTR.lastIndex = i
    const m = TAG_ATTR.exec(text)
    if (!m?.[1] || m.index !== i) return i
    i = TAG_ATTR.lastIndex
    const name = m[1]
    const raw = m[2] ?? m[3] ?? m[4]
    const hole = HOLE_AT.exec(name)
    if (hole) holeAttrs(carrier, holes[Number(hole[1])] ?? '')
    else if (name.toLowerCase() === 'class') {
      const parts = (raw ?? '').split(HOLES)
      addClasses(
        carrier,
        either([
          { texts: parts.filter((_, k) => k % 2 === 0), open: (raw ?? '').includes(MARK) },
          ...parts.filter((_, k) => k % 2 === 1).map(n => outcomes(holes[Number(n)] ?? '')),
        ]),
      )
    } else
      carrier.attrs.set(
        name.toLowerCase(),
        raw === undefined ? '' : raw.includes(MARK) || /\uE001/.test(raw) ? null : raw,
      )
  }
}

/** `${on ? ' hidden' : ''}` where an attribute goes: the attributes its strings write, or any. */
function holeAttrs(carrier: Carrier, expr: string): void {
  const outcome = outcomes(expr, true)
  if (outcome.open) carrier.anyAttr = true
  for (const text of outcome.texts) {
    const end = readAttrs(carrier, text, 0, [])
    // `${…}` where a name goes, inside: its attributes are run time's.
    if (text.slice(end).includes(MARK)) carrier.anyAttr = true
  }
}

// ---------------------------------------------------------------- JSX

/** The JSX names of attributes React writes under another name. */
const JSX_NAMES: Record<string, string> = { classname: 'class', htmlfor: 'for' }

/** Whether a `<` at `at` opens JSX rather than a type argument or a comparison. */
function opensJsx(src: string, at: number): boolean {
  const before = src
    .slice(Math.max(0, at - 400), at)
    .replace(/\/\/[^\n]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trimEnd()
  return !/[\w$)\]]$/.test(before) || /(?:^|[^\w$.])(?:return|yield|await|default|case)$/.test(before)
}

/** Where the expression starting at `from` ends: a `;`, or a line break that no operator carries on. */
function statementEnd(src: string, from: number): number {
  let depth = 0
  let i = from
  while (i < src.length) {
    const skipped = skipLiteral(src, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    const c = src[i] ?? ''
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (--depth < 0) return i
    } else if (
      depth === 0 &&
      (c === ';' || (c === '\n' && !/^\s*(?:[?:.+]|&&|\|\||\?\?)/.test(src.slice(i + 1, i + 40))))
    )
      return i
    i++
  }
  return i
}

/** What a file's `const name = …` hold, by name (one written in two places holds either). */
function constsIn(src: string): Map<string, string> {
  const held = new Map<string, string>()
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const at = (m.index ?? 0) + m[0].length
    const expr = src.slice(at, statementEnd(src, at)).trim()
    const name = m[1] ?? ''
    const before = held.get(name)
    held.set(name, before === undefined ? expr : `(${before}) || (${expr})`)
  }
  return held
}

/** The elements and components a TSX file writes, with the attributes and classes it gives them. */
export function jsxCarriers(file: string, tsx: string): Carrier[] {
  const names = constsIn(tsx)
  const found: Carrier[] = []
  let i = 0
  while (i < tsx.length) {
    const skipped = skipLiteral(tsx, i)
    if (skipped !== i) {
      i = skipped
      continue
    }
    const m = tsx[i] === '<' ? /^<([a-zA-Z][\w.]*)/.exec(tsx.slice(i, i + 80)) : null
    if (m?.[1] && opensJsx(tsx, i)) {
      const carrier = jsxTag(tsx, i + m[0].length, m[1], names)
      if (carrier) found.push({ ...carrier, where: `${file}:${lineAt(tsx, i)}` })
      i += m[0].length
      continue
    }
    i++
  }
  return found
}

/** A JSX tag's attributes from `from` on; null when it is no tag after all. */
function jsxTag(src: string, from: number, name: string, names: ReadonlyMap<string, string>): Carrier | null {
  const carrier = blank(/^[a-z]/.test(name) ? name.toLowerCase() : null)
  let i = from
  for (;;) {
    while (/\s/.test(src[i] ?? '')) i++
    const c = src[i]
    if (c === undefined) return null
    if (c === '>' || (c === '/' && src[i + 1] === '>')) return carrier
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      i = skipLiteral(src, i)
      continue
    }
    if (c === '{') {
      // A spread: the attributes it names in an object written there.
      const close = closeBrace(src, i)
      for (const k of src.slice(i, close).matchAll(/['"]?((?:aria|data)-[\w-]+)['"]?\s*:/g))
        if (k[1]) carrier.attrs.set(k[1], null)
      i = close + 1
      continue
    }
    const attr = /^[\w:-]+/.exec(src.slice(i, i + 80))?.[0]
    if (!attr) return null
    i += attr.length
    const lower = JSX_NAMES[attr.toLowerCase()] ?? attr.toLowerCase()
    while (/\s/.test(src[i] ?? '')) i++
    if (src[i] !== '=') {
      carrier.attrs.set(lower, '')
      continue
    }
    i++
    while (/\s/.test(src[i] ?? '')) i++
    let value: string | null
    let expr = ''
    if (src[i] === '"' || src[i] === "'") {
      const end = skipLiteral(src, i)
      value = src.slice(i + 1, end - 1)
      i = end
    } else if (src[i] === '{') {
      const close = closeBrace(src, i)
      expr = src.slice(i + 1, close)
      const literal = /^\s*(['"])([^'"]*)\1\s*$/.exec(expr)
      value = literal ? (literal[2] ?? '') : null
      i = close + 1
    } else return null
    if (lower === 'class')
      addClasses(carrier, value === null ? outcomes(expr, false, names) : { texts: [value], open: false })
    else carrier.attrs.set(lower, value)
  }
}

// ---------------------------------------------------------------- set at run time

/** An attribute, or a class (`.name`), code sets on some element at run time. */
export interface Setting {
  where: string
  name: string
}

const kebab = (name: string) => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

const SETTINGS: [RegExp, (m: RegExpMatchArray) => string[]][] = [
  [/\.dataset\.([A-Za-z]\w*)\s*=(?!=)/g, m => [`data-${kebab(m[1] ?? '')}`]],
  [/\.(?:set|toggle)Attribute\(\s*['"]([\w-]+)['"]/g, m => [(m[1] ?? '').toLowerCase()]],
  [/\.(hidden|open|disabled|checked|role)\s*=(?!=)/g, m => [m[1] ?? '']],
  [/\.aria([A-Z]\w*)\s*=(?!=)/g, m => [`aria-${(m[1] ?? '').toLowerCase()}`]],
  [/\.classList\.add\(([^)]*)\)/g, m => [...(m[1] ?? '').matchAll(/['"`]([\w-]+)['"`]/g)].map(c => `.${c[1]}`)],
  [/\.classList\.toggle\(\s*['"`]([\w-]+)['"`]/g, m => [`.${m[1]}`]],
  [/\.classList\.replace\([^,)]*,\s*['"`]([\w-]+)['"`]/g, m => [`.${m[1]}`]],
]

/** The attributes and classes a script sets at run time. */
export function settingsIn(file: string, js: string): Setting[] {
  return SETTINGS.flatMap(([re, names]) =>
    [...js.matchAll(re)].flatMap(m => names(m).map(name => ({ where: `${file}:${lineAt(js, m.index ?? 0)}`, name }))),
  )
}

// ---------------------------------------------------------------- matching a rule's element

/** What a page's code may change on any element at run time: attribute values, added classes. */
export interface RunTime {
  attrs: ReadonlySet<string>
  classes: ReadonlySet<string>
}

export const runTimeOf = (settings: Setting[]): RunTime => ({
  attrs: new Set(settings.filter(s => !s.name.startsWith('.')).map(s => s.name)),
  classes: new Set(settings.filter(s => s.name.startsWith('.')).map(s => s.name.slice(1))),
})

/**
 * Whether the carrier could be the compound's element with `attr` on it, given what that page's
 * code changes at run time (`run`): a value drawn for an attribute it sets may change, a class it
 * adds may be there. A `<details>` is opened by the browser itself, which writes its `open`.
 * `surely`: only by what the source writes, not by the classes or attributes it leaves to run time.
 */
export function carries(carrier: Carrier, compound: Compound, attr: AttrTest, run: RunTime, surely = false): boolean {
  const anyClass = carrier.anyClass && !surely
  const anyAttr = carrier.anyAttr && !surely
  if (compound.tag && carrier.tag && compound.tag !== carrier.tag) return false
  if (compound.pseudos.some(p => p.name === 'root') && carrier.tag !== 'html') return false
  if (compound.id) {
    const id = carrier.attrs.get('id')
    if (id === undefined ? !anyAttr : id !== null && id !== compound.id) return false
  }
  const classed = (name: string) => anyClass || carrier.classes.has(name) || run.classes.has(name)
  if (!compound.classes.every(classed)) return false
  const has = (test: AttrTest) => {
    if (test.name === 'open' && carrier.tag === 'details') return true
    const value = carrier.attrs.get(test.name)
    if (value === undefined) return anyAttr
    return value === null || run.attrs.has(test.name) || valueHolds(test, value)
  }
  return compound.attrs.every(has) && has(attr)
}
