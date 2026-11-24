// Settings' text fields show where to type (#283, #287). `.path-add` and `.draft-id` (app.css) have
// no fill and no outline at rest, so a field was the panel's own color. One rule (web/styles/fields.css)
// gives every one of them the Login fields' fill and a ring on focus, and the Terminal look an outline
// (web/styles/look-terminal.css); the Login fields (.access-input) keep what they had.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const sheet = (name: string) => readFileSync(join(root, 'web', 'styles', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the rule written with exactly this selector (a list joined by ", "); null when none. */
const declarations = (css: string, selector: string): string | null => {
  const rules = [...css.matchAll(/(?<=^|\})\s*([^{}]+?)\s*\{([^}]*)\}/g)]
  const hit = rules.find(
    m =>
      (m[1] ?? '')
        .split(',')
        .map(s => s.trim())
        .join(', ') === selector,
  )
  return hit?.[2]?.trim() ?? null
}

const T = ':root[data-look="terminal"]'

test('every Settings field has the fill at rest and a ring while focused, not only the Backup ones', () => {
  const css = sheet('fields.css')
  expect(declarations(css, '.path-add:not(.access-input), .draft-id')).toBe('background: var(--fill-2);')
  expect(declarations(css, '.path-add:not(.access-input):focus, .draft-id:focus')).toBe(
    'box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent);',
  )
  expect(declarations(css, '.path-add:not(.access-input):disabled, .draft-id:disabled')).toBe('opacity: 0.5;')
  // as the Remote access fields' own
  expect(declarations(sheet('access.css'), '.access-field .path-add:disabled')).toBe('opacity: 0.5;')
  // the cause: the fields themselves are bare at rest
  expect(declarations(sheet('app.css'), '.path-add, .draft-id')).toContain('background: none;')
  // the fill is the Login fields' own
  expect(declarations(sheet('access.css'), '.access-input')).toContain('background: var(--fill-2);')
  // linked after app.css, so it wins over the bare field
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  const at = (href: string) => html.indexOf(`href="styles/${href}"`)
  expect(at('fields.css')).toBeGreaterThan(at('app.css'))
  expect(at('app.css')).toBeGreaterThan(-1)
})

test('in the Terminal look the same fields are outlined, not filled', () => {
  const css = sheet('look-terminal.css')
  expect(declarations(css, `${T} .path-add:not(.access-input), ${T} .draft-id`)).toBe(
    'border-radius: 4px; background: none; box-shadow: inset 0 0 0 1px var(--t-edge);',
  )
  expect(declarations(css, `${T} .path-add:not(.access-input):focus, ${T} .draft-id:focus`)).toBe(
    'box-shadow: inset 0 0 0 1px var(--accent);',
  )
})

test('no field rule reaches the Login fields, and Backup keeps no field rule of its own', () => {
  for (const name of ['fields.css', 'look-terminal.css']) {
    const parts = [...sheet(name).matchAll(/(?:^|\})\s*([^{}@]+?)\s*\{/g)].flatMap(m => (m[1] ?? '').split(','))
    const fields = parts.map(s => s.trim()).filter(s => s.includes('.path-add'))
    expect(fields.length).toBeGreaterThan(0)
    expect(fields.filter(s => !s.includes('.path-add:not(.access-input)'))).toEqual([])
  }
  expect(sheet('backup.css')).not.toMatch(/\.path-add[^{]*\{[^}]*(background|box-shadow)/)
})

test('the fields #287 names are .path-add or .draft-id, so the one rule reaches each', () => {
  const src = join(root, 'web', 'src', 'components')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : []
    })
  const named = (rel: string, cls: string) => readFileSync(join(src, rel), 'utf8').includes(cls)
  expect(named('access/TunnelSection.tsx', 'className="path-add"')).toBe(true)
  expect(named('access/ServerSetup.tsx', 'className="path-add"')).toBe(true)
  expect(named('profiles/ProfilesPanel.tsx', 'className="path-add"')).toBe(true)
  expect(named('profiles/ProfileRow.tsx', 'className="path-add profile-command-field"')).toBe(true)
  expect(named('wake/WakePanel.tsx', 'className="path-add wake-minutes"')).toBe(true)
  expect(named('wake/WakePanel.tsx', 'className="path-add wake-exclude"')).toBe(true)
  expect(named('categories/CategoryRow.tsx', 'inputClass="path-add"')).toBe(true)
  expect(named('categories/CategoryDraft.tsx', 'className="draft-id"')).toBe(true)
  // and no component draws a bare field with them outside Settings, where a fill would be new
  const users = walk(src).filter(f => /path-add|draft-id/.test(readFileSync(f, 'utf8')))
  // (and Add a server / Add a computer / Move master role, forms of Settings, Devices, #509, #513, #697)
  expect(
    users.every(f =>
      /[\\/](access|backup|profiles|wake|categories)[\\/]|[\\/]devices[\\/](AddServer|AddComputer|MasterHandover)\.tsx$/.test(
        f,
      ),
    ),
  ).toBe(true)
})
