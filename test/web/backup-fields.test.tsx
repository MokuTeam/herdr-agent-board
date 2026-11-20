// Settings → Backup…: its fields show where to type (#283). `.path-add` (app.css) has no fill and no
// outline at rest; every Settings field takes a fill and a focus ring from web/styles/fields.css
// (#287, test/web/settings-fields.test.ts). Every field of the panel must be a `.path-add`, or that
// rule misses it.
import { expect, test } from 'bun:test'
import { freshTarget } from '../../src/core/backup.ts'
import { type BackupActions, BackupBody } from '../../web/src/components/backup/BackupPanel.tsx'
import type { BackupPanelView } from '../../web/src/models/backup.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, hasClass } from './support/markup.ts'

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
