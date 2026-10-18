// Every attribute the stylesheets select by (web/styles/*.css: `[hidden]`, `[aria-expanded="true"]`,
// `span[data-i18n]`, …), the React page renders where upstream's page had it, the whole page at once:
// upstream's web/index.html and the HTML its scripts write or the attributes they set (web/*.js at
// the newest merge ported) against the React page's JSX and what its code sets (web/src). A rule
// whose attribute React stopped rendering matches nothing in the React page, which no markup test
// sees: the markup tests compare what both sides draw, not what a stylesheet reads.
//
// Each attribute a rule reads, on the element of the selector it is read on, is looked for in:
// - upstream's sources, generously: an element that could be that one (a class or an attribute
//   left to run time could be any), or, when no element written says so, its scripts setting that
//   attribute on some element at run time (`el.dataset.edge =`, `setAttribute('aria-pressed', …)`);
// - the React page's sources, strictly: an element its JSX writes with the selector's tag and
//   classes (as written, or added at run time) and the attribute, or its code setting the
//   attribute at run time.
// Upstream writing such an element asks React to write one; upstream setting the attribute at run
// time asks React to write it or set it.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  type Carrier,
  carries,
  jsxCarriers,
  pageCarriers,
  type RunTime,
  runTimeOf,
  type Setting,
  settingsIn,
  templateCarriers,
} from './support/attribute-carriers.ts'
import { oldSource } from './support/old-app.ts'
import { type AttributeRead, attributeReads, pageStyleRules } from './support/stylesheets.ts'

/** The newest upstream merge ported (the stylesheets are its: styles.test.ts). */
const UPSTREAM_REF = 'bde9cfd'
const ROOT = join(import.meta.dir, '..', '..')

/**
 * Rules upstream's page itself no longer matches, though its scripts set the attribute elsewhere:
 * `selector :: attribute` → why.
 */
const UPSTREAM_ONLY_SET_ELSEWHERE: Record<string, string> = {
  '.pill-toggle[aria-pressed="true"] :: aria-pressed':
    'the sleepers toggle was the last pressed pill, gone with #43; app.js sets aria-pressed on the sheet’s chips only',
  '.pill-toggle[aria-pressed="false"] :: aria-pressed':
    'the sleepers toggle was the last pressed pill, gone with #43; app.js sets aria-pressed on the sheet’s chips only',
}

/**
 * Rules that match upstream's static page only before its scripts first run: `selector ::
 * attribute` → why. React draws nothing before its code runs.
 */
const BEFORE_SCRIPTS: Record<string, string> = {
  '.limits[hidden] :: hidden':
    'index.html hides the usage pill until renderLimits() first runs (`pill.hidden = false`, at the first connection report); React draws the pill shown',
}

interface Side {
  carriers: Carrier[]
  settings: Setting[]
  run: RunTime
}

function side(carriers: Carrier[], settings: Setting[]): Side {
  return { carriers, settings, run: runTimeOf(settings) }
}

function upstreamPage(): Side {
  const git = Bun.spawnSync(['git', 'ls-tree', '--name-only', `${UPSTREAM_REF}:web/`], { cwd: ROOT })
  const files = git.stdout.toString().split('\n').filter(Boolean)
  const carriers: Carrier[] = []
  const settings: Setting[] = []
  for (const name of files) {
    const file = `web/${name}`
    if (name.endsWith('.html')) carriers.push(...pageCarriers(file, oldSource(file, UPSTREAM_REF)))
    if (!name.endsWith('.js')) continue
    const js = oldSource(file, UPSTREAM_REF)
    carriers.push(...templateCarriers(file, js))
    settings.push(...settingsIn(file, js))
  }
  return side(carriers, settings)
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })

function reactPage(): Side {
  const carriers = pageCarriers('web/index.html', readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'))
  const settings: Setting[] = []
  for (const path of filesUnder(join(ROOT, 'web', 'src')).filter(p => /\.tsx?$/.test(p))) {
    const file = relative(ROOT, path).split(sep).join('/')
    const source = readFileSync(path, 'utf8')
    if (path.endsWith('.tsx')) carriers.push(...jsxCarriers(file, source))
    settings.push(...settingsIn(file, source))
  }
  return side(carriers, settings)
}

type Found = 'written' | 'set' | 'none'

/** How a side gives the read's element its attribute; React's must be written as a host element. */
function found(page: Side, read: AttributeRead, surely: boolean): Found {
  const own = surely ? page.carriers.filter(c => c.tag !== null) : page.carriers
  if (own.some(c => carries(c, read.compound, read.attr, page.run, surely))) return 'written'
  return page.settings.some(s => s.name === read.attr.name) ? 'set' : 'none'
}

const keyOf = (read: AttributeRead) => `${read.selector} :: ${read.attr.name}`

/** One read per selector and attribute, sheet by sheet. */
function pageReads(): AttributeRead[] {
  const seen = new Set<string>()
  return attributeReads(pageStyleRules()).filter(read => {
    const key = `${read.sheet} ${keyOf(read)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** What the read asks of React, as a failure line; null when React gives it. */
function missing(upstream: Side, react: Side, read: AttributeRead): string | null {
  const theirs = found(upstream, read, false)
  const ours = found(react, read, true)
  if (theirs === 'written' && ours === 'written') return null
  if (theirs === 'set' && ours !== 'none') return null
  if (theirs === 'none') return null
  const where =
    theirs === 'written'
      ? upstream.carriers.filter(c => carries(c, read.compound, read.attr, upstream.run)).map(c => c.where)
      : upstream.settings.filter(s => s.name === read.attr.name).map(s => s.where)
  const how = theirs === 'written' ? 'writes it' : 'sets it at run time'
  const ourHow = ours === 'set' ? 'only sets it at run time' : 'does not'
  return `${read.sheet}: ${keyOf(read)}: upstream ${how} (${[...new Set(where)].slice(0, 3).join(', ')}), React ${ourHow}`
}

describe(`stylesheet attributes are where upstream’s page (${UPSTREAM_REF}) had them`, () => {
  const upstream = upstreamPage()
  const react = reactPage()
  const reads = pageReads()
  const known = { ...UPSTREAM_ONLY_SET_ELSEWHERE, ...BEFORE_SCRIPTS }

  test('the sheets are read: their rules select by attributes, which both pages carry', () => {
    // A broken reader would find nothing and pass everything.
    expect(reads.length).toBeGreaterThan(100)
    for (const name of ['hidden', 'data-i18n', 'aria-expanded', 'data-dock', 'data-edge', 'open', 'role'])
      expect(reads.some(r => r.attr.name === name)).toBe(true)
    const icon = reads.find(r => r.selector === '.pill-toggle.icon-only > span[data-i18n]')
    if (!icon) throw new Error('no icon-only label rule')
    expect(found(upstream, icon, false)).toBe('written')
    expect(upstream.carriers.length).toBeGreaterThan(500)
    expect(react.carriers.filter(c => c.tag !== null).length).toBeGreaterThan(500)
  })

  test('every one React renders where upstream had it', () => {
    const misses = reads
      .filter(read => !(keyOf(read) in known))
      .map(read => missing(upstream, react, read))
      .filter(line => line !== null)
    expect(misses).toEqual([])
  })

  test('the rules let pass still differ, for the reason given', () => {
    for (const key of Object.keys(known)) {
      const read = reads.find(r => keyOf(r) === key)
      if (!read) throw new Error(`no rule ${key} any more`)
      expect([key, missing(upstream, react, read) !== null]).toEqual([key, true])
    }
  })
})
