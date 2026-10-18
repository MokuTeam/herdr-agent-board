// Settings (the gear) against upstream's own, at the compact toolbar's merge (#43): the menu
// web/app.js opens out of #settings (its items, where and how it opens, what each pick does),
// its setTheme and its chooseLanguage, picked out of app.js there and run with the same state;
// then the look kept in this browser before the page paints (web/src/theme.ts, as theme.js); and
// what the gear says of its menu (aria-expanded) as menus come and go, on each side's own menu.
import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { LANGUAGES, translator } from '../../src/core/i18n/translator.ts'
import type { Translator } from '../../src/core/types.ts'
import type { MenuSource } from '../../web/src/components/menu/menu-engine.ts'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import {
  chooseLanguage,
  type SettingsDeps,
  settingsGear,
  settingsMenuFrom,
} from '../../web/src/hooks/useSettingsMenu.ts'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import type { Dock } from '../../web/src/models/panel-layout.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { keptTheme, setTheme, themeNow } from '../../web/src/models/theme.ts'
import { board, renderInBoard } from './support/board.tsx'
import { byId } from './support/markup.ts'
import { oldMenuSide, reactMenuSide } from './support/menu-sides.tsx'
import { oldCode, oldFunction } from './support/old-app.ts'
import { asDom } from './support/react-commit.ts'

const SETTINGS_MERGE = '8c4b987'

interface Scene {
  t: Translator
  theme?: string
  canEdit?: boolean
  dock?: Dock
  sleepers?: boolean
  /** The board's languages; none: the dictionary's own. */
  languages?: Record<string, string>
  coarse?: boolean
  keyboard?: boolean
}

type Opened = { items: unknown; options: Record<string, unknown> }
const RECT = { left: 1300, top: 10, right: 1328, bottom: 38, width: 28, height: 28 }

/** What a pick asked for, on either side. */
type Call = [string, ...unknown[]]

/** Upstream's handler on #settings, with the scene's state, its menu's open and what its picks do. */
function oldHandler(scene: Scene, calls: Call[], open: (items: unknown, options: Record<string, unknown>) => void) {
  let handler: ((e: unknown) => void) | null = null
  const dataset: Record<string, string> = scene.theme && scene.theme !== 'auto' ? { theme: scene.theme } : {}
  const state = { data: scene.languages ? { languages: scene.languages } : {}, sleepers: scene.sleepers ?? true }
  oldCode(
    'web/app.js',
    ['THEMES', 'themeNow', { statement: "$('#settings').addEventListener('click'" }],
    {
      $: () => ({
        addEventListener: (_type: string, fn: (e: unknown) => void) => {
          handler = fn
        },
      }),
      document: { documentElement: { dataset } },
      state,
      LANGUAGES,
      t: scene.t,
      canEdit: () => scene.canEdit ?? true,
      panelDock: () => scene.dock ?? 'right',
      matchMedia: () => ({ matches: !!scene.coarse }),
      menu: { open },
      setTheme: (theme: string) => void calls.push(['theme', theme]),
      chooseLanguage: (lang: string) => void calls.push(['lang', lang]),
      placePanels: (dock: string) => void calls.push(['dock', dock]),
      resetPanelSize: () => void calls.push(['reset']),
      setSleepers: (on: boolean) => void calls.push(['sleepers', on]),
    },
    SETTINGS_MERGE,
  )
  if (!handler) throw new Error('no #settings handler')
  const click: (e: unknown) => void = handler
  return click
}

/** Upstream's gear clicked once: the menu it opened and what its picks do. */
function oldSettings(scene: Scene) {
  const opened: { menu: Opened | null } = { menu: null }
  const calls: Call[] = []
  const button = {
    attrs: {} as Record<string, string>,
    getBoundingClientRect: () => RECT,
    setAttribute(name: string, value: string) {
      this.attrs[name] = value
    },
  }
  const click = oldHandler(scene, calls, (items, options) => {
    opened.menu = { items, options }
  })
  click({ currentTarget: button, detail: scene.keyboard ? 0 : 1 })
  const menu = opened.menu
  if (!menu) throw new Error('no menu')
  return { menu, calls, button }
}

/** The port's menu out of the gear, with the same state, opened on `menu`. */
function newHandler(scene: Scene, calls: Call[], menu: SettingsDeps['menu']) {
  const sleepers = scene.sleepers ?? true
  return settingsMenuFrom({
    menu,
    t: () => scene.t,
    canEdit: () => scene.canEdit ?? true,
    languages: () => scene.languages ?? LANGUAGES,
    dock: () => scene.dock ?? 'right',
    sleepers: () => sleepers,
    root: () => ({ dataset: scene.theme && scene.theme !== 'auto' ? { theme: scene.theme } : {} }),
    coarse: () => !!scene.coarse,
    setTheme: theme => void calls.push(['theme', theme]),
    chooseLanguage: lang => void calls.push(['lang', lang]),
    placePanels: dock => void calls.push(['dock', dock]),
    resetPanelSize: () => void calls.push(['reset']),
    toggleSleepers: () => void calls.push(['sleepers', !sleepers]),
  })
}

/** The port's gear pressed once. */
function newSettings(scene: Scene) {
  const opened: { menu: Opened | null } = { menu: null }
  const calls: Call[] = []
  const button = { getBoundingClientRect: () => RECT } as unknown as HTMLElement
  const open = newHandler(scene, calls, {
    open: (items, options) => {
      opened.menu = { items, options: { ...options } }
    },
  })
  open(button, !!scene.keyboard)
  const menu = opened.menu
  if (!menu) throw new Error('no menu')
  return { menu, calls, button }
}

// What the menu can pick: an item without a submenu (one with a submenu opens it instead).
const PICKS = ['theme:light', 'theme:auto', 'lang:ru', 'dock:bottom', 'dock:float', 'dock:reset', 'sleepers', 'nothing']

function same(scene: Scene): Opened {
  const old = oldSettings(scene)
  const ours = newSettings(scene)
  expect(JSON.stringify(ours.menu.items)).toBe(JSON.stringify(old.menu.items))
  const { onPick: oldPick, origin: oldOrigin, ...oldOptions } = old.menu.options
  const { onPick: newPick, origin: newOrigin, ...newOptions } = ours.menu.options
  expect(newOptions).toEqual(oldOptions)
  expect(oldOrigin).toBe(old.button)
  expect(newOrigin).toBe(ours.button)
  expect(old.button.attrs['aria-expanded']).toBe('true')
  if (typeof oldPick !== 'function' || typeof newPick !== 'function') throw new Error('no onPick')
  for (const id of PICKS) {
    oldPick(id)
    newPick(id)
  }
  expect(ours.calls).toEqual(old.calls)
  return old.menu
}

describe('the menu out of the gear', () => {
  test('appearance, language, the panel’s place and sleeping sessions, each checked as it is now', () => {
    const menu = same({ t: translator('en') })
    expect(JSON.stringify(menu.items)).toContain('"id":"theme:auto","label":"Match the system","checked":true')
    same({
      t: translator('ru'),
      theme: 'dark',
      dock: 'float',
      sleepers: false,
      languages: { en: 'English', ru: 'Русский' },
    })
    same({ t: translator('en'), theme: 'light', dock: 'bottom' })
  })

  test('without the board the language waits, gray with the reason; a finger or the keyboard opens it', () => {
    const menu = same({ t: translator('en'), canEdit: false, coarse: true })
    expect(JSON.stringify(menu.items)).toContain('"id":"lang","label":"Language","disabled":true,"reason"')
    expect(same({ t: translator('en'), keyboard: true }).options.source).toBe('keyboard')
    expect(same({ t: translator('en'), coarse: true }).options.source).toBe('touch')
  })

  test('the items as the model gives them; what a pick is', () => {
    const items = settingsMenu({
      t: translator('en'),
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'left',
      sleepers: true,
    })
    expect(items.map(i => ('id' in i ? i.id : '—'))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(settingPicked('dock:reset')).toEqual({ kind: 'reset' })
    expect(settingPicked('dock:left')).toEqual({ kind: 'dock', value: 'left' })
    expect(settingPicked('lang:ru')).toEqual({ kind: 'lang', value: 'ru' })
    expect(settingPicked('sleepers')).toEqual({ kind: 'sleepers' })
    expect(settingPicked('panel')).toBeNull()
  })
})

describe('light or dark', () => {
  /** Upstream's setTheme with a page of `theme`, and whether the browser cross-fades. */
  function oldTheme(theme: string, picked: string, transition: boolean, reduced: boolean) {
    const dataset: Record<string, string> = theme === 'auto' ? {} : { theme }
    const kept: string[] = []
    const faded: string[] = []
    const document = {
      documentElement: { dataset },
      ...(transition && {
        startViewTransition: (apply: () => void) => {
          faded.push(picked)
          apply()
        },
      }),
    }
    const code = oldCode(
      'web/app.js',
      ['THEMES', 'themeNow', 'setTheme'],
      {
        document,
        store: { set: (_key: string, value: string) => void kept.push(value) },
        reducedMotion: { matches: reduced },
      },
      SETTINGS_MERGE,
    )
    oldFunction(code, 'setTheme')(picked)
    return { dataset: { ...dataset }, kept, faded }
  }

  function newTheme(theme: string, picked: string, transition: boolean, reduced: boolean) {
    const dataset: Record<string, string> = theme === 'auto' ? {} : { theme }
    const kept: string[] = []
    const faded: string[] = []
    setTheme(picked, {
      root: { dataset },
      keep: value => void kept.push(value),
      transition:
        transition && !reduced
          ? apply => {
              faded.push(picked)
              apply()
            }
          : undefined,
    })
    return { dataset: { ...dataset }, kept, faded }
  }

  test('picked: kept in this browser and on the page, in a cross-fade when it can; the same again changes nothing', () => {
    for (const theme of ['auto', 'light', 'dark'])
      for (const picked of ['auto', 'light', 'dark'])
        for (const transition of [false, true])
          for (const reduced of [false, true])
            expect([theme, picked, transition, reduced, newTheme(theme, picked, transition, reduced)]).toEqual([
              theme,
              picked,
              transition,
              reduced,
              oldTheme(theme, picked, transition, reduced),
            ])
    expect(themeNow({ dataset: {} })).toBe('auto')
  })

  test('before the page paints, only light or dark kept in this browser set the look', () => {
    expect(['light', 'dark', 'auto', 'sepia', null].map(keptTheme)).toEqual(['light', 'dark', null, null, null])
  })
})

describe('the language', () => {
  /** Upstream's chooseLanguage: what it toasted, set and posted. */
  async function oldChoose(t: Translator, next: string, canEdit: boolean) {
    const said: [string, boolean][] = []
    const set: string[] = []
    const posted: unknown[] = []
    const state: Record<string, unknown> = {}
    const code = oldCode(
      'web/app.js',
      ['chooseLanguage'],
      {
        t,
        state,
        canEdit: () => canEdit,
        toast: (text: string, error = false) => void said.push([text, error]),
        setLanguage: (lang: string) => void set.push(lang),
        render() {},
        fetch: async (_url: string, init: { body: string }) => {
          posted.push(JSON.parse(init.body))
          return { ok: true, status: 200, json: async () => ({ ok: true }) }
        },
      },
      SETTINGS_MERGE,
    )
    await oldFunction(code, 'chooseLanguage')(next)
    return { said, set, posted }
  }

  async function newChoose(t: Translator, next: string, canEdit: boolean) {
    const said: [string, boolean][] = []
    const set: string[] = []
    const posted: unknown[] = []
    await chooseLanguage(next, {
      t,
      canEdit,
      choose: lang => void set.push(lang),
      save: async body => void posted.push(body),
      toast: (text, error = false) => void said.push([text, error]),
    })
    return { said, set, posted }
  }

  test('another language: the page at once, then the board for every board; the same one, nothing; no board, why not', async () => {
    for (const [lang, next, canEdit] of [
      ['en', 'ru', true],
      ['ru', 'ru', true],
      ['en', 'ru', false],
    ] as const) {
      const t = translator(lang)
      expect(await newChoose(t, next, canEdit)).toEqual(await oldChoose(t, next, canEdit))
    }
  })
})

describe('the gear says whether its menu is up', () => {
  /** A step: the gear pressed, another menu opened in its place (a card's), the menu closed. */
  type Step = 'gear' | 'other' | 'close'
  const OTHER: MenuEntry[] = [{ id: 'x', label: 'Something else' }]
  const scene: Scene = { t: translator('en') }

  /** Upstream's: the #settings click and the menu's onChange of app.js, on its menu.js; the gear's aria-expanded after each step. */
  async function oldGear(steps: Step[]): Promise<(string | null)[]> {
    let changed = () => {}
    const side = oldMenuSide(() => changed())
    try {
      const gear = side.page('opener')
      oldCode(
        'web/app.js',
        [{ statement: 'const menu = initMenu({' }],
        {
          initMenu: (options: { onChange: () => void }) => {
            changed = options.onChange
            return { isOpen: () => side.isOpen() }
          },
          dialogBack: { sync() {} },
          document: { querySelectorAll: () => [gear] },
        },
        SETTINGS_MERGE,
      )
      const click = oldHandler(scene, [], (items, options) => {
        const { x, y, source, label } = options
        if (typeof x !== 'number' || typeof y !== 'number' || typeof label !== 'string') throw new Error('no place')
        void side.open(items as MenuEntry[], { x, y, source: source as MenuSource, label, origin: 'opener' })
      })
      const seen: (string | null)[] = []
      for (const step of steps) {
        if (step === 'gear') click({ currentTarget: gear, detail: 1 })
        else if (step === 'other') await side.open(OTHER, { x: 5, y: 5 })
        else await side.close()
        await side.world.flush()
        seen.push(gear.getAttribute('aria-expanded'))
      }
      return seen
    } finally {
      await side.dispose()
    }
  }

  /** The port's: the gear (hooks/useSettingsMenu.ts settingsGear) on the board's menu engine; what the toolbar then says. */
  async function newGear(steps: Step[]): Promise<(string | null)[]> {
    const side = reactMenuSide()
    const states: boolean[] = []
    try {
      const gear = asDom(side.page('opener'))
      let expanded = false
      const control = settingsGear(side.engine, newHandler(scene, [], side.engine), on => {
        expanded = on
      })
      const stop = control.watch()
      for (const step of steps) {
        if (step === 'gear') control.open(gear, false)
        else if (step === 'other') await side.open(OTHER, { x: 5, y: 5 })
        else await side.close()
        await side.world.flush()
        states.push(expanded)
      }
      stop()
    } finally {
      await side.dispose()
    }
    return states.map(expanded => {
      const toolbar = renderInBoard(
        <Toolbar limitsAnchor={createRef<HTMLButtonElement>()} settings={{ open() {}, expanded }} />,
        board(),
        'en',
      )
      return byId(toolbar, 'settings').attrs.get('aria-expanded') ?? null
    })
  }

  test('pressed with no menu up: expanded; a menu closing says not, also as another opens over it, the gear’s own too', async () => {
    const steps: Step[] = ['gear', 'other', 'gear', 'close', 'gear', 'gear', 'close', 'close']
    const old = await oldGear(steps)
    expect(old).toEqual(['true', 'false', 'false', 'false', 'true', 'false', 'false', 'false'])
    expect(await newGear(steps)).toEqual(old)
  })
})
