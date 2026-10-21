// Settings → "Sleep and wake…" (#119): offered only while the payload carries wake's state line
// (wake shipped, turned on, or sessions still asleep in its file), after Profiles… and before
// Phones…; picked from the gear, its panel opens; the side panels draw it only then. Without wake
// in the payload the menu and the panels are exactly as before.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { WakeView } from '../../src/core/wake/view.ts'
import { SidePanels, type SidePanelsProps } from '../../web/src/components/SidePanels.tsx'
import { type SettingsDeps, settingsMenuFrom } from '../../web/src/hooks/useSettingsMenu.ts'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { type Element, hasClass } from './support/markup.ts'

const WAKE: WakeView = { on: true, state: 'running', since: Date.now(), asleep: 0, port: 12421, downSince: null }
const RECT = { left: 1300, top: 10, right: 1328, bottom: 38, width: 28, height: 28 }
const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))

describe('the Settings menu', () => {
  const now = {
    t: translator('en'),
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right' as const,
    sleepers: true,
    profiles: false,
  }

  test('offers Sleep and wake… only with wake in the payload: today’s list exactly without it', () => {
    expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, wake: false }))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, profiles: true, phones: true, wake: false }))).toEqual([
      'theme',
      'lang',
      'panel',
      'profiles',
      'phones',
      '—',
      'sleepers',
    ])
  })

  test('after Profiles… and before Phones…, in the board’s language', () => {
    expect(ids(settingsMenu({ ...now, profiles: true, phones: true, wake: true }))).toEqual([
      'theme',
      'lang',
      'panel',
      'profiles',
      'wake',
      'phones',
      '—',
      'sleepers',
    ])
    expect(settingsMenu({ ...now, wake: true })[3]).toEqual({ id: 'wake', label: 'Sleep and wake…' })
    expect(settingsMenu({ ...now, t: translator('ru'), wake: true })[3]).toEqual({
      id: 'wake',
      label: 'Сон и пробуждение…',
    })
    expect(settingPicked('wake')).toEqual({ kind: 'wake' })
  })

  test('picked from the gear, its panel opens', () => {
    for (const offered of [false, true]) {
      const calls: string[] = []
      let opened: readonly MenuEntry[] = []
      let pick = (_id: string): void => {}
      const deps: SettingsDeps = {
        menu: {
          open: (items, options) => {
            opened = items
            pick = id => options.onPick?.(id, { id, label: '' })
          },
        },
        t: () => translator('en'),
        canEdit: () => true,
        languages: () => ({ en: 'English' }),
        dock: () => 'right',
        sleepers: () => true,
        root: () => ({ dataset: {} }),
        coarse: () => false,
        setTheme() {},
        chooseLanguage() {},
        placePanels() {},
        resetPanelSize() {},
        toggleSleepers() {},
        profiles: () => false,
        openProfiles: () => void calls.push('profiles'),
        fold: () => null,
        chooseFold() {},
        wake: () => offered,
        openWake: () => void calls.push('wake'),
      }
      settingsMenuFrom(deps)({ getBoundingClientRect: () => RECT } as unknown as HTMLElement, false)
      expect(ids(opened).includes('wake')).toBe(offered)
      pick('wake')
      expect(calls).toEqual(['wake'])
    }
  })
})

test('the side panels draw Sleep and wake only with wake in the payload, after the profiles’', () => {
  const props: SidePanelsProps = {
    categories: { open: false, focus: null, onClose() {}, onOpen() {} },
    schedule: {
      open: false,
      focus: null,
      onClose() {},
      schedule: { armed: null, held: null, cancel() {}, mode() {}, disarm() {} },
    },
    wake: { open: false, onClose() {} },
  }
  const asides = (wake?: WakeView) =>
    renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
        <SidePanels {...props} />
      </PanelProvider>,
      board({ data: payload(wake ? { wake } : {}) }),
    )
      .filter((n): n is Element => n.kind === 'element' && hasClass(n, 'sheet'))
      .map(a => a.attrs.get('id'))
  expect(asides()).toEqual(['sheet', 'cats-sheet', 'sched-sheet'])
  expect(asides(WAKE)).toEqual(['sheet', 'cats-sheet', 'sched-sheet', 'wake-sheet'])
})
