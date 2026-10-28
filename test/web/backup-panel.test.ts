// Settings → Backup… (#233, web/src/models/backup.ts and the Settings menu): offered on the local
// board's page only; the view read with a guard; a target's line; what Look found, a line each.
import { expect, test } from 'bun:test'
import { freshTarget } from '../../src/core/backup.ts'
import type { BackupLook } from '../../src/core/backup-server.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { isBackupView, lastGood, lookLines, stateLine } from '../../web/src/models/backup.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'

const t = translator('en')
const now = {
  t,
  theme: 'auto',
  languages: { en: 'English' },
  canEdit: true,
  dock: 'right' as const,
  sleepers: false,
  profiles: false,
}
const ids = (items: ReturnType<typeof settingsMenu>) => items.map(i => ('separator' in i ? '—' : i.id))

test('Backup… is offered on the local board only, after Remote access…; picked, it opens its panel', () => {
  expect(ids(settingsMenu({ ...now, access: true, backup: true }))).toContain('backup')
  expect(ids(settingsMenu({ ...now, access: true, backup: false }))).not.toContain('backup')
  const items = ids(settingsMenu({ ...now, access: true, backup: true }))
  expect(items.indexOf('backup')).toBe(items.indexOf('access') + 1)
  expect(settingsMenu({ ...now, t: translator('ru'), backup: true }).find(i => 'id' in i && i.id === 'backup')).toEqual(
    {
      id: 'backup',
      label: 'Бэкап…',
    },
  )
  expect(settingPicked('backup')).toEqual({ kind: 'backup' })
})

test('the view is taken only as the board sends it', () => {
  const view = {
    needed: true,
    config: { folder: null, server: null },
    key: null,
    states: {},
    problems: [],
    damaged: null,
    dropKey: false,
    suggest: null,
  }
  expect(isBackupView(view)).toBe(true)
  expect(isBackupView({ ...view, problems: null })).toBe(false)
  expect(isBackupView(null)).toBe(false)
})

test('a target’s line: its last good snapshot or nothing yet, and its last error', () => {
  const at = new Date(2026, 9, 29, 9, 30).getTime()
  expect(stateLine(undefined, t, at).line).toBe('Nothing sent yet')
  const s = { ...freshTarget(), lastOk: at - 60_000, error: 'refused', lastTry: at }
  // the time as the system writes it (9:29, or 9:29 AM)
  expect(stateLine(s, t, at).line).toMatch(/^Last good 9:29/)
  expect(stateLine(s, t, at).error).toBe('Last try failed: refused')
  expect(lastGood({ folder: { ...s, lastOk: 5 }, server: { ...s, lastOk: 9 } })).toBe(9)
  expect(lastGood({})).toBe(null)
})

test('what Look found, a line each, ending with whether Apply can go on', () => {
  const look: BackupLook = {
    ssh: 'OpenSSH_9.6p1',
    include: true,
    user: 'none',
    drop: 'none',
    keys: 'none',
    fence: 'none',
    record: false,
    snapshots: { count: 0, kb: 0 },
    freeKb: 2048 * 1024,
    sshdNow: 'ok',
    candidate: 'ok',
  }
  expect(lookLines(look, t)).toEqual([
    'sshd: OpenSSH_9.6p1',
    'No backup user yet',
    'The fence goes in a file of its own under sshd_config.d',
    '2048 MB free',
    'sshd takes the fence: Apply can go on.',
  ])
  expect(lookLines({ ...look, candidate: 'nope' }, t)).not.toContain('sshd takes the fence: Apply can go on.')
})
