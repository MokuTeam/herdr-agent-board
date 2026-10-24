// Templates of the board's own server scripts, for the one command ("Do it myself", the
// simple-setup spec's "'Do it myself': one command"). The board renders a script with stand-in
// values (sentinels); each stand-in then becomes a named place, `@{name}@`, which the command fills
// in on the server with what it found there. How each place spells its value (as it is; as one
// shell word, quoted when it needs it; as such a word inside another quoted word) is read from a
// second rendering with a value that needs quoting (a probe), so that a template filled in is, byte
// for byte, what the board's own functions render for that value: fill() here, and the command's
// awk, which does the same on the server. A rendering with other plain values checks the whole of
// it once more. Pure, with no node: import.
import { shQuote } from './server-shell.ts'

/**
 * How a place spells its value: `id` as it is; `q` as one shell word (the plan's own `q`: as it is
 * when plain, else quoted); `sqq` that word inside another single-quoted word; `sqwords` and
 * `qwords` a list, each item quoted or as one word, with spaces between; `listen` a list of nginx
 * `listen` lines, each one word; `lines` a whole line, taken by any number of lines, or none.
 */
export type Spelling = 'id' | 'q' | 'sqq' | 'sqwords' | 'qwords' | 'listen' | 'lines'
export type Value = string | string[]
/** One value the server fills in: its stand-in, another plain value, and one that needs quoting (when it may). */
export interface Input {
  sentinel: Value
  alt: Value
  probe?: Value
}
export type Inputs = Record<string, Input>
/** A place in the rendering: its text from the inputs (`from`), and its spelling when it is fixed. */
export interface Place {
  name: string
  from: string[]
  text: (v: Record<string, Value>) => Value
  spelling?: Spelling
}

/** What the plan's `q` leaves as it is. */
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/
const q = (s: string): string => (PLAIN.test(s) ? s : shQuote(s))
const one = (v: Value): string => {
  if (typeof v !== 'string') throw new Error('a list where one value goes')
  return v
}
const many = (v: Value): string[] => {
  if (typeof v === 'string') throw new Error('one value where a list goes')
  return v
}

/** A value as a place spells it. */
export function spell(v: Value, s: Spelling): string {
  switch (s) {
    case 'id':
    case 'lines':
      return one(v)
    case 'q':
      return q(one(v))
    case 'sqq':
      return q(one(v)).replaceAll("'", `'\\''`)
    case 'sqwords':
      return many(v).map(shQuote).join(' ')
    case 'qwords':
      return many(v).map(q).join(' ')
    case 'listen':
      return many(v)
        .map(a => q(`    listen ${a};`))
        .join(' ')
  }
}

const SPELLINGS: ReadonlySet<string> = new Set(['id', 'q', 'sqq', 'sqwords', 'qwords', 'listen', 'lines'])
const MARK = /@\{([a-z0-9_]+)(?:\|([a-z]+))?\}@/g
const LINE_MARK = /^@\{([a-z0-9_]+)\|lines\}@$/

/** A template filled in: each place by its value as it spells it; a `lines` place is its whole line. */
export function fill(template: string, values: Record<string, Value>): string {
  const valueFor = (name: string): Value => {
    const v = values[name]
    if (v === undefined) throw new Error(`no value for ${name}`)
    return v
  }
  const out: string[] = []
  for (const line of template.split('\n')) {
    const whole = LINE_MARK.exec(line)
    if (whole) {
      const v = one(valueFor(whole[1] ?? ''))
      if (v !== '') out.push(v)
      continue
    }
    out.push(
      line.replace(MARK, (_m, name: string, how: string | undefined) => {
        const s = (how ?? 'id') as Spelling
        if (!SPELLINGS.has(s) || s === 'lines') throw new Error(`a place spelled ${how}`)
        return spell(valueFor(name), s)
      }),
    )
  }
  return out.join('\n')
}

interface Occurrence {
  start: number
  end: number
  place: Place
  spelling: Spelling | null
}

const valuesOf = (inputs: Inputs, which: 'sentinel' | 'alt'): Record<string, Value> =>
  Object.fromEntries(Object.entries(inputs).map(([name, i]) => [name, i[which]]))
const placeValues = (places: readonly Place[], v: Record<string, Value>): Record<string, Value> =>
  Object.fromEntries(places.map(p => [p.name, p.text(v)]))

/** Where the places' stand-in texts are in the rendering: the longest first, none overlapping. */
function occurrences(text: string, places: readonly Place[], sentinels: Record<string, Value>): Occurrence[] {
  const found: Occurrence[] = []
  for (const place of places) {
    const raw = place.text(sentinels)
    if (place.spelling === undefined && !PLAIN.test(one(raw)))
      throw new Error(`the stand-in of ${place.name} needs quoting`)
    const at = spell(raw, place.spelling ?? 'id')
    if (at === '') throw new Error(`the stand-in of ${place.name} is empty`)
    for (let i = text.indexOf(at); i >= 0; i = text.indexOf(at, i + 1))
      found.push({ start: i, end: i + at.length, place, spelling: place.spelling ?? null })
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Occurrence[] = []
  for (const o of found) if (!kept.length || o.start >= (kept.at(-1) as Occurrence).end) kept.push(o)
  return kept
}

/** Each place's spelling in `probed`, the rendering with input `name`'s probe: the one that lines up with the text around it. */
function readSpellings(
  plain: string,
  probed: string,
  occ: Occurrence[],
  name: string,
  values: Record<string, Value>,
): void {
  let pos = 0
  let last = 0
  const expectAt = (s: string, what: string): void => {
    if (!probed.startsWith(s, pos)) throw new Error(`the probe of ${name} changed the text beyond its places (${what})`)
    pos += s.length
  }
  occ.forEach((o, k) => {
    expectAt(plain.slice(last, o.start), 'between')
    const next = plain.slice(o.end, occ[k + 1]?.start ?? plain.length)
    if (!o.place.from.includes(name)) {
      expectAt(plain.slice(o.start, o.end), o.place.name)
    } else {
      const raw = o.place.text(values)
      const tries: Spelling[] = o.place.spelling ? [o.place.spelling] : ['sqq', 'q', 'id']
      const fits = tries.find(s => {
        const text = spell(raw, s)
        return probed.startsWith(text, pos) && probed.startsWith(next, pos + text.length)
      })
      if (!fits) throw new Error(`no spelling of ${o.place.name} fits where its probe is`)
      if (o.spelling !== null && o.spelling !== fits) throw new Error(`${o.place.name} spelled two ways`)
      o.spelling = fits
      pos += spell(raw, fits).length
    }
    last = o.end
  })
  expectAt(plain.slice(last), 'at the end')
  if (pos !== probed.length) throw new Error(`the probe of ${name} added text at the end`)
}

/**
 * The template of what `render` makes of the inputs: rendered with the stand-ins, each place's
 * stand-in text replaced by its name and spelling (read from the probes). Checked: filled in with
 * the stand-ins, with each probe, and with the other plain values, it is what `render` makes of
 * them. Throws when it is not, or when the rendering holds a `@{` of its own.
 */
export function templateOf(
  render: (v: Record<string, Value>) => string,
  inputs: Inputs,
  places: readonly Place[],
): string {
  const sentinels = valuesOf(inputs, 'sentinel')
  const plain = render(sentinels)
  if (plain.includes('@{')) throw new Error('the rendering holds a @{ of its own')
  const occ = occurrences(plain, places, sentinels)
  for (const [name, input] of Object.entries(inputs)) {
    if (input.probe === undefined) continue
    const values = { ...sentinels, [name]: input.probe }
    readSpellings(plain, render(values), occ, name, values)
  }
  let out = ''
  let last = 0
  for (const o of occ) {
    const s = o.spelling ?? 'id'
    out += `${plain.slice(last, o.start)}@{${o.place.name}${s === 'id' ? '' : `|${s}`}}@`
    last = o.end
  }
  out += plain.slice(last)
  const check = (v: Record<string, Value>, what: string): void => {
    const filled = fill(out, placeValues(places, v)).split('\n')
    const rendered = render(v).split('\n')
    const at = filled.findIndex((l, k) => l !== rendered[k])
    if (at >= 0 || filled.length !== rendered.length)
      throw new Error(`the template does not render as ${what}, at line ${at}:\n${filled[at]}\n${rendered[at]}`)
  }
  check(sentinels, 'the stand-ins')
  for (const [name, input] of Object.entries(inputs))
    if (input.probe !== undefined) check({ ...sentinels, [name]: input.probe }, `the probe of ${name}`)
  check(valuesOf(inputs, 'alt'), 'other values')
  return out
}
