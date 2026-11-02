// Settings → Backup…: its fields show where to type (#283). `.path-add` (app.css) has no fill and no
// outline at rest, so in the dark theme a field was the panel's own color; the panel's sheet
// (web/styles/backup.css) gives them the fill the Remote access Login fields have, a ring on focus,
// and the Terminal look an outline instead (web/styles/look-terminal.css). Every field of the panel
// must be a `.path-add` inside `.backup-body`, or those rules miss it.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshTarget } from '../../src/core/backup.ts'
import { type BackupActions, BackupBody } from '../../web/src/components/backup/BackupPanel.tsx'
import type { BackupPanelView } from '../../web/src/models/backup.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, hasClass } from './support/markup.ts'

const sheet = (name: string) =>
  readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the rule written with exactly this selector; null when the sheet has none. */
const declarations = (css: string, selector: string): string | null => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(String.raw`(?:^|\})\s*${escaped}\s*\{([^}]*)\}`).exec(css)?.[1]?.trim() ?? null
}

const noop = () => {}
const ACTIONS: BackupActions = {
  now: noop,
  passphrase: async () => true,
  folder: noop,
  testFolder: noop,
  server: noop,
  removeServer: noop,
  run: noop,
  testServer: noop,
  manual: noop,
  newKey: noop,
}

test('in every theme the Backup fields have a fill of their own at rest, and a ring while focused', () => {
  const css = sheet('backup.css')
  expect(declarations(css, '.backup-body .path-add')).toBe('background: var(--fill-2);')
  expect(declarations(css, '.backup-body .path-add:focus')).toContain('box-shadow: 0 0 0 3px')
  // the cause: the field itself is bare at rest, so the panel's sheet has to give it the fill
  expect(declarations(sheet('app.css'), '.path-add, .draft-id')).toContain('background: none;')
  // the fill is the one the Remote access Login fields have, not a color of the panel's own
  expect(declarations(sheet('access.css'), '.access-input')).toContain('background: var(--fill-2);')
})

test('in the Terminal look they are outlined, as its other fields are, not filled', () => {
  const css = sheet('look-terminal.css')
  const field = ':root[data-look="terminal"] .backup-body .path-add'
  expect(declarations(css, field)).toBe(
    'border-radius: 4px; background: none; box-shadow: inset 0 0 0 1px var(--t-edge);',
  )
  expect(declarations(css, `${field}:focus`)).toBe('box-shadow: inset 0 0 0 1px var(--accent);')
  // the outline of the search field the look already has
  expect(declarations(css, ':root[data-look="terminal"] .ql-search input')).toContain(
    'box-shadow: inset 0 0 0 1px var(--t-edge);',
  )
})

test('every field of the panel is a .path-add inside .backup-body: the passphrase, the folder, the server and its sudo password', () => {
  const now = Date.now()
  const view: BackupPanelView = {
    needed: true,
    config: {
      folder: 'D:\\Sync',
      server: { host: 'example.org', port: 22, admin: { user: 'me', key: '' }, set: new Date(now).toISOString() },
    },
    key: null,
    states: { folder: freshTarget(), server: freshTarget() },
    problems: [],
    damaged: null,
    dropKey: false,
    suggest: null,
  }
  const nodes = renderInBoard(
    <BackupBody view={view} loadError={null} busy={null} notes={{}} manual={null} canEdit={true} actions={ACTIONS} />,
    board(),
  )
  expect(findAll(nodes, el => hasClass(el, 'backup-body'))).toHaveLength(1)
  const body = findAll(nodes, el => hasClass(el, 'backup-body'))[0]
  const inputs = findAll(body?.children ?? [], el => el.tag === 'input')
  // passphrase twice, folder, host + port + user + key, sudo password
  expect(inputs).toHaveLength(8)
  expect(inputs.filter(i => !hasClass(i, 'path-add')).map(i => i.attrs.get('class'))).toEqual([])
  expect(findAll(body?.children ?? [], el => el.tag === 'textarea' || el.tag === 'select')).toEqual([])
})
