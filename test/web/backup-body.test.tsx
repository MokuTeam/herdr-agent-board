// Settings → Backup… (#233, components/backup/BackupPanel.tsx BackupBody) and the toolbar's backup
// note (components/BackupNote.tsx), rendered from their props and the board: loading, a view that
// could not be read, nothing to back up yet, the passphrase unset and set, a folder with its state,
// a server that takes snapshots (its fields locked, a new key offered), each Test busy on its own;
// the note there only while the payload carries a problem, in words with no error text in them.
import { expect, test } from 'bun:test'
import { freshTarget } from '../../src/core/backup.ts'
import { BackupNote } from '../../web/src/components/BackupNote.tsx'
import { type BackupActions, BackupBody, type BackupBodyProps } from '../../web/src/components/backup/BackupPanel.tsx'
import type { BackupPanelView } from '../../web/src/models/backup.ts'
import { board, payload, renderInBoard } from './support/board.tsx'
import { type Element, findAll, type Node } from './support/markup.ts'

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
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
const VIEW: BackupPanelView = {
  needed: true,
  config: { folder: null, server: null },
  key: null,
  states: {},
  problems: [],
  damaged: null,
  dropKey: false,
  suggest: null,
}

function render(props: Partial<BackupBodyProps>) {
  const nodes = renderInBoard(
    <BackupBody
      view={null}
      loadError={null}
      busy={null}
      notes={{}}
      manual={null}
      canEdit={true}
      actions={ACTIONS}
      {...props}
    />,
    board(),
  )
  const buttons = findAll(nodes, el => el.tag === 'button')
  const button = (label: string): Element | undefined => buttons.find(b => text(b.children) === label)
  const inputs = findAll(nodes, el => el.tag === 'input')
  return { all: text(nodes), button, inputs }
}

test('while the view is asked, and when it could not be read', () => {
  expect(render({}).all).toContain('Reading the backup’s state…')
  const failed = render({ loadError: 'status 500' })
  expect(failed.all).toContain('Could not read the backup’s state: status 500')
  expect(failed.all).not.toContain('Reading the backup’s state…')
})

test('nothing to back up yet: said, and no Back up now', () => {
  const r = render({ view: { ...VIEW, needed: false } })
  expect(r.all).toContain('Nothing to back up yet')
  expect(r.button('Back up now')).toBeUndefined()
})

test('problems first; no passphrase: the two fields to set it', () => {
  const r = render({
    view: { ...VIEW, problems: [{ kind: 'noTarget', text: 'No backup target: on this computer only.' }] },
  })
  expect(r.all).toContain('No backup target: on this computer only.')
  expect(r.inputs.filter(i => i.attrs.get('type') === 'password').length).toBe(2)
})

test('a passphrase set, a folder with its state, and each Test busy on its own', () => {
  const now = Date.now()
  const view: BackupPanelView = {
    ...VIEW,
    key: { made: now - 3_600_000 },
    config: {
      folder: 'D:\\Sync',
      server: { host: 'example.org', port: 22, admin: { user: 'me', key: '' }, set: new Date(now).toISOString() },
    },
    states: {
      folder: { ...freshTarget(), lastOk: now - 60_000, seq: 3, name: 'x' },
      server: { ...freshTarget(), error: 'refused', lastTry: now, failures: 1 },
    },
    dropKey: true,
  }
  const r = render({ view, busy: 'test:server' })
  expect(r.all).toContain('Change…')
  expect(r.all).toMatch(/Last good /)
  expect(r.all).toContain('Last try failed: refused')
  expect(r.button('Testing…')).toBeDefined()
  // the folder's Test is not the server's
  const tests = ['Test', 'Testing…'].map(label => r.button(label))
  expect(tests.every(Boolean)).toBe(true)
  // a server that takes snapshots keeps its fields: Undo first
  const host = r.inputs.find(i => i.attrs.get('value') === 'example.org')
  expect(host?.attrs.has('disabled')).toBe(true)
  expect(r.button('Remove')?.attrs.has('disabled')).toBe(true)
  expect(r.all).toContain('A lost or stolen laptop')
  expect(r.button('New key')).toBeDefined()
})

test('the toolbar note: none without a problem; with one, its words and no error text', () => {
  expect(renderInBoard(<BackupNote />, board({ data: payload() }))).toEqual([])
  const nodes = renderInBoard(
    <BackupNote onOpen={noop} />,
    board({ data: payload({ backup: { last: null, problem: { kind: 'failing', target: 'server' } } }) }),
  )
  const note = findAll(nodes, el => el.tag === 'button')[0]
  expect(note?.attrs.get('title')).toBe('Backup: the last one to the server failed')
  expect(text(nodes)).toBe('Backup')
  const ru = renderInBoard(
    <BackupNote />,
    board({ data: payload({ backup: { last: null, problem: { kind: 'reset' } } }) }),
    'ru',
  )
  expect(findAll(ru, el => el.tag === 'button')[0]?.attrs.get('title')).toBe(
    'Бэкап: в базе меньше, чем в последнем бэкапе',
  )
})
