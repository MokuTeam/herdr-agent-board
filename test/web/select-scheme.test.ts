// Native lists in the board's theme (#412). The page's color-scheme follows the theme (light, dark,
// the system's), and the terminal look keeps it. The system draws a select's open list from its
// options' colors, over white where the select's fill is see-through (--fill, --fill-2), which gave
// the threads' and Team's lists light text on white in the dark theme: their options take the
// panel's colors, as profiles.css's and time.css's already do; the closed fields look as before.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(import.meta.dir, '..', '..', 'web')
const sheet = (name: string) => readFileSync(join(WEB, 'styles', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of every rule (at any depth) whose selector list names `selector`, in order. */
function declsOf(css: string, selector: string): string[] {
  const out: string[] = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? '').split(',').map(s => s.trim().replace(/\s+/g, ' '))
    if (selectors.includes(selector)) out.push((m[2] ?? '').trim())
  }
  return out
}
/** The value of `property` in declarations, the last one winning. */
function declared(decls: readonly string[], property: string): string | undefined {
  let value: string | undefined
  for (const d of decls)
    for (const part of d.split(';')) {
      const [name, ...rest] = part.split(':')
      if (name?.trim() === property) value = rest.join(':').trim()
    }
  return value
}

test("the page's color-scheme follows the theme: the system's, light or dark picked; no sheet sets another", () => {
  const app = sheet('app.css')
  expect(declared(declsOf(app, ':root'), 'color-scheme')).toBe('light dark')
  expect(declared(declsOf(app, ':root[data-theme="light"]'), 'color-scheme')).toBe('light')
  expect(declared(declsOf(app, ':root[data-theme="dark"]'), 'color-scheme')).toBe('dark')
  // The terminal look, the threads' and Team's sheets leave it as the theme set it.
  for (const name of ['look-terminal.css', 'threads.css', 'team.css'])
    expect(sheet(name)).not.toMatch(/(^|[;{\s])color-scheme\s*:/)
  expect(readFileSync(join(WEB, 'index.html'), 'utf8')).toContain('<meta name="color-scheme" content="light dark">')
})

test('the lists the threads and Team panes open take the panel’s colors; their fields stay as they were', () => {
  const threads = sheet('threads.css')
  const team = sheet('team.css')
  for (const [css, select, fill] of [
    [threads, '.wt-share-to', 'var(--fill-2)'],
    [team, '.team-add', 'var(--fill)'],
  ] as const) {
    const options = declsOf(css, `${select} option`)
    expect(declared(options, 'background')).toBe('var(--panel-float)')
    expect(declared(options, 'color')).toBe('var(--label)')
    // The closed field: its see-through fill as before.
    expect(declared(declsOf(css, `${select} select`), 'background')).toBe(fill)
  }
  // As the sheets that had it already (the lanes' profile, the window's workspace, Time's fields).
  expect(declared(declsOf(sheet('profiles.css'), '.cat-profile option'), 'background')).toBe('var(--panel-float)')
  // The thread head's status and assignee selects are invisible over their pills and set no
  // background: the browser's own field color, which follows color-scheme.
  expect(declared(declsOf(threads, '.wt-status select'), 'opacity')).toBe('0')
  expect(declared(declsOf(threads, '.wt-status select'), 'background')).toBeUndefined()
})

test('the lane filter is no select any more: a button whose chevron and text sit in the board’s look', () => {
  const threads = sheet('threads.css')
  expect(declared(declsOf(threads, '.wt-lane'), 'cursor')).toBe('pointer')
  expect(declared(declsOf(threads, '.wt-lane-text'), 'text-overflow')).toBe('ellipsis')
  const panel = readFileSync(join(WEB, 'src', 'components', 'threads', 'ThreadsPanel.tsx'), 'utf8')
  expect(panel).not.toContain('<select')
})
