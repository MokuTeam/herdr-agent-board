// Settings → Housekeeping… menu item and panel body (#652).
import { describe, expect, test } from 'bun:test'
import { housekeepingConfig } from '../../src/core/housekeeping.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { HousekeepingBody } from '../../web/src/components/housekeeping/HousekeepingPanel.tsx'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { board, renderInBoard } from './support/board.tsx'
import type { Node } from './support/markup.ts'

const textOf = (n: Node | Node[]): string =>
  Array.isArray(n) ? n.map(textOf).join('') : n.kind === 'text' ? n.text : n.children.map(textOf).join('')

describe('Settings → Housekeeping… (#652)', () => {
  test('settingsMenu omits housekeeping when off/remote and offers it on the local board', () => {
    const base = {
      t: translator('en'),
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'right' as const,
      sleepers: false,
      profiles: false,
    }
    const ids = (list: ReturnType<typeof settingsMenu>) => list.map(i => ('id' in i ? i.id : '—'))
    expect(ids(settingsMenu(base))).not.toContain('housekeeping')
    expect(ids(settingsMenu({ ...base, housekeeping: true }))).toContain('housekeeping')
    expect(settingPicked('housekeeping')).toEqual({ kind: 'housekeeping' })
  })

  test('HousekeepingBody renders memory guard, tab sweep, dry-run output and log', () => {
    const cfg = housekeepingConfig(undefined)
    const nodes = renderInBoard(
      <HousekeepingBody
        view={{
          config: cfg,
          warned: false,
          lastMemoryAt: null,
          lastTabsAt: null,
          lastMemAvailableMb: 7200,
          lastMemTotalMb: 16_000,
          log: [{ at: Date.now(), kind: 'tab-close', text: 'closed idle tab in bsd (host: example.com, 140m idle)' }],
        }}
        dryRun={{
          at: Date.now(),
          config: cfg,
          memory: {
            level: 'ok',
            memAvailableMb: 7200,
            memTotalMb: 16_000,
            thresholds: { warnMb: 3424, actionMb: 2400 },
            shouldWarn: false,
            recovered: false,
            candidates: [],
            skipped: [],
          },
          tabs: { profiles: [], note: 'no connected Chrome profiles in mokutab-bridge' },
        }}
        loadError={null}
        busy={null}
        note={null}
        canEdit={true}
        onSave={() => {}}
        onDryRun={() => {}}
      />,
      board(),
    )
    const txt = textOf(nodes)
    expect(txt).toContain('Memory guard')
    expect(txt).toContain('Leftover browser tabs')
    expect(txt).toContain('Dry run now')
    expect(txt).toContain('example.com')
  })
})
