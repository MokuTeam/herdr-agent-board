// Settings (the gear) against upstream's own, at the compact toolbar's merge (#43): the menu
// web/app.js opens out of #settings (its items, where and how it opens, what each pick does),
// its setTheme and its chooseLanguage, picked out of app.js there and run with the same state;
// then the look kept in this browser before the page paints (web/src/theme.ts, as theme.js); the
// board's own style, Classic or Terminal (#161), which upstream did not have; and what the gear
// says of its menu (aria-expanded) as menus come and go, on each side's own menu.
import { afterEach, describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { LANGUAGES, translator } from '../../src/core/i18n/translator.ts'
import type { BoardProfile } from '../../src/core/payload.ts'
import type { Translator } from '../../src/core/types.ts'
import type { MenuSource } from '../../web/src/components/menu/menu-engine.ts'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import {
  chooseFold,
  chooseLanguage,
  endLogin,
  type SettingsDeps,
  settingsGear,
  settingsMenuFrom,
} from '../../web/src/hooks/useSettingsMenu.ts'
import { isLook, keptLook, LOOKS, lookNow, setLook } from '../../web/src/models/look.ts'
import type { MenuEntry, MenuItem } from '../../web/src/models/menu-model.ts'
import type { Dock } from '../../web/src/models/panel-layout.ts'
import { offersProfiles } from '../../web/src/models/profiles.ts'
import { UNPAIRED } from '../../web/src/models/remote-page.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { keptTheme, setTheme, themeNow } from '../../web/src/models/theme.ts'
import { board, renderInBoard } from './support/board.tsx'
import { type Answer, answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { byId } from './support/markup.ts'
import { oldMenuSide, reactMenuSide } from './support/menu-sides.tsx'
import { oldCode, oldFunction } from './support/old-app.ts'
import { asDom } from './support/react-commit.ts'

const SETTINGS_MERGE = '8c4b987'

afterEach(restoreFetch)

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
    // One profile folder, as upstream knew: no Profiles… item.
    profiles: () => false,
    openProfiles: () => void calls.push(['profiles']),
    // A board that does not say how sessions asleep in "Waiting" fold, as upstream's: no such item.
    fold: () => null,
    chooseFold: mode => void calls.push(['fold', mode]),
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
      profiles: false,
    })
    expect(items.map(i => ('id' in i ? i.id : '—'))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(settingPicked('dock:reset')).toEqual({ kind: 'reset' })
    expect(settingPicked('dock:left')).toEqual({ kind: 'dock', value: 'left' })
    expect(settingPicked('lang:ru')).toEqual({ kind: 'lang', value: 'ru' })
    expect(settingPicked('sleepers')).toEqual({ kind: 'sleepers' })
    expect(settingPicked('panel')).toBeNull()
  })

  test('the Settings menu offers Phones… only while the remote mode is on', () => {
    const now = {
      t: translator('en'),
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'right' as const,
      sleepers: true,
      profiles: false,
    }
    const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))
    // Off, or a board before the remote mode: today's list exactly.
    expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, phones: false }))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, profiles: true, phones: true }))).toEqual([
      'theme',
      'lang',
      'panel',
      'profiles',
      'phones',
      '—',
      'sleepers',
    ])
    expect(settingsMenu({ ...now, phones: true })[3]).toEqual({ id: 'phones', label: 'Phones…' })
    expect(settingsMenu({ ...now, t: translator('ru'), phones: true })[3]).toEqual({ id: 'phones', label: 'Телефоны…' })
    expect(settingPicked('phones')).toEqual({ kind: 'phones' })
  })

  test('the local board offers Remote access…, after Phones…; picked, it opens its panel', () => {
    const now = {
      t: translator('en'),
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'right' as const,
      sleepers: true,
      profiles: false,
    }
    const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))
    // Not said (a page through Tailscale or the domain), or said no: today's list exactly.
    expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, access: false }))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, profiles: true, phones: true, access: true }))).toEqual([
      'theme',
      'lang',
      'panel',
      'profiles',
      'phones',
      'access',
      '—',
      'sleepers',
    ])
    expect(settingsMenu({ ...now, access: true })[3]).toEqual({ id: 'access', label: 'Remote access…' })
    expect(settingsMenu({ ...now, t: translator('ru'), access: true })[3]).toEqual({
      id: 'access',
      label: 'Удалённый доступ…',
    })
    expect(settingPicked('access')).toEqual({ kind: 'access' })

    // From the gear: offered as the page says, and picked, it opens the panel.
    for (const local of [false, true]) {
      const calls: Call[] = []
      let opened: readonly MenuEntry[] = []
      let pick = (_id: string): void => {}
      settingsMenuFrom({
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
        openProfiles() {},
        fold: () => null,
        chooseFold() {},
        access: () => local,
        openAccess: () => void calls.push(['access']),
      })({ getBoundingClientRect: () => RECT } as unknown as HTMLElement, false)
      expect(ids(opened).includes('access')).toBe(local)
      pick('access')
      expect(calls).toEqual([['access']])
    }
  })

  test('a page signed in through the domain offers Sign out, last after a separator; it ends that login', async () => {
    const now = {
      t: translator('en'),
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'right' as const,
      sleepers: true,
      profiles: false,
    }
    const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))
    // Not through the domain: today's list exactly.
    expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, signOut: false }))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    const items = settingsMenu({ ...now, signOut: true })
    expect(ids(items)).toEqual(['theme', 'lang', 'panel', '—', 'sleepers', '—', 'signout'])
    expect(items.at(-1)).toEqual({ id: 'signout', label: 'Sign out' })
    expect(ids(settingsMenu({ ...now, fold: 'push', signOut: true }))).toEqual([
      'theme',
      'lang',
      'panel',
      '—',
      'sleepers',
      'fold',
      '—',
      'signout',
    ])
    expect(settingsMenu({ ...now, t: translator('ru'), signOut: true }).at(-1)).toEqual({
      id: 'signout',
      label: 'Выйти',
    })
    expect(settingPicked('signout')).toEqual({ kind: 'signout' })

    // Picked from the gear: this page's login ends.
    for (const signedIn of [false, true]) {
      const calls: Call[] = []
      let opened: readonly MenuEntry[] = []
      let pick = (_id: string): void => {}
      settingsMenuFrom({
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
        openProfiles() {},
        fold: () => null,
        chooseFold() {},
        signOut: () => signedIn,
        endLogin: () => void calls.push(['signout']),
      })({ getBoundingClientRect: () => RECT } as unknown as HTMLElement, false)
      expect(ids(opened).includes('signout')).toBe(signedIn)
      pick('signout')
      expect(calls).toEqual([['signout']])
    }

    // Ending it: POST /api/logout with the board's header (the tunnel listener refuses a POST
    // without it). Ended, or no login there any more (401): the gate asks hello again (UNPAIRED)
    // and shows the login screen. Any other answer (Caddy's 502 while the board is closed) or none
    // at all: the login may still hold on this device, so the board stays, saying so.
    const cases: [Answer, string, string | null][] = [
      [[200, { ok: true }], 'en', null],
      [[401, { error: 'login' }], 'en', null],
      [[502, {}], 'en', 'Not signed out: Error 502'],
      [[500, { error: 'disk full' }], 'en', 'Not signed out: disk full'],
      [new TypeError('Failed to fetch'), 'en', 'Not signed out: No connection to the board: Failed to fetch'],
      [[502, {}], 'ru', 'Выход не выполнен: Ошибка 502'],
    ]
    for (const [answer, lang, note] of cases) {
      const posted = answers(answer)
      const toasts: [string, boolean | undefined][] = []
      let asked = 0
      const again = () => void asked++
      addEventListener(UNPAIRED, again)
      try {
        await endLogin({ t: translator(lang), toast: (text, error) => void toasts.push([text, error]) })
      } finally {
        removeEventListener(UNPAIRED, again)
      }
      expect(sent(posted)).toEqual([['/api/logout', 'POST', '1', {}]])
      const headers = posted[0]?.init?.headers as Record<string, string> | undefined
      expect(headers?.['content-type']).toBe('application/json')
      expect([asked, toasts]).toEqual(note === null ? [1, []] : [0, [[note, true]]])
    }
  })

  test('how sessions asleep in "Waiting" fold: the board’s way checked; gray without the board; a pick saves it (the board’s own)', async () => {
    const now = {
      t: translator('en'),
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'right' as const,
      sleepers: true,
      profiles: false,
    }
    const fold = (items: readonly MenuEntry[]) => items.find(i => 'id' in i && i.id === 'fold')
    // A board that does not say (upstream's): none.
    expect(fold(settingsMenu(now))).toBeUndefined()
    expect(JSON.stringify(fold(settingsMenu({ ...now, fold: 'push' })))).toBe(
      JSON.stringify({
        id: 'fold',
        label: 'Sleeping in Waiting',
        submenu: [
          { id: 'fold:push', label: 'Unfold, moving cards below', checked: true },
          { id: 'fold:over', label: 'Unfold over cards below', checked: false },
          { id: 'fold:off', label: 'Don’t fold', checked: false },
        ],
      }),
    )
    expect(JSON.stringify(fold(settingsMenu({ ...now, fold: 'off', canEdit: false })))).toContain(
      '"disabled":true,"reason"',
    )
    expect(settingPicked('fold:over')).toEqual({ kind: 'fold', value: 'over' })
    expect(settingPicked('fold:sideways')).toBeNull()

    const saved: unknown[] = []
    const toasts: unknown[] = []
    const deps = (canEdit: boolean) => ({
      t: translator('en'),
      canEdit,
      save: async (body: unknown) => void saved.push(body),
      toast: (text: string, error?: boolean) => void toasts.push([text, error]),
    })
    await chooseFold('over', deps(true))
    expect(saved).toEqual([{ foldWaiting: 'over' }])
    await chooseFold('off', deps(false))
    expect(saved).toHaveLength(1)
    expect(toasts).toEqual([[translator('en')('live.off'), true]])
  })

  test('the Settings menu offers Profiles… only when more than one profile folder is found', () => {
    const now = {
      t: translator('en'),
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'right' as const,
      sleepers: true,
    }
    const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))
    // One folder: today's list exactly.
    expect(ids(settingsMenu({ ...now, profiles: false }))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    // More than one: Profiles… after the session panel's place.
    const items = settingsMenu({ ...now, profiles: true })
    expect(ids(items)).toEqual(['theme', 'lang', 'panel', 'profiles', '—', 'sleepers'])
    expect(items[3]).toEqual({ id: 'profiles', label: 'Profiles…' })
    expect(settingsMenu({ ...now, t: translator('ru'), profiles: true })[3]).toEqual({
      id: 'profiles',
      label: 'Профили…',
    })
    expect(settingPicked('profiles')).toEqual({ kind: 'profiles' })

    // More than one folder found, shown or hidden; none listed, or a board before profiles: one.
    const folder = (id: string, hidden: boolean): BoardProfile => ({
      id,
      title: id,
      color: '#5856D6',
      colorName: 'indigo',
      dir: `C:\\Users\\me\\.claude-${id}`,
      hidden,
      inherited: false,
      exists: true,
      hooks: hidden ? null : true,
      sessions: 0,
      limits: null,
    })
    expect(offersProfiles(undefined)).toBe(false)
    expect(offersProfiles([])).toBe(false)
    expect(offersProfiles([folder('default', false)])).toBe(false)
    expect(offersProfiles([folder('default', false), folder('work', true)])).toBe(true)
    expect(offersProfiles([folder('default', false), folder('work', false), folder('x', true)])).toBe(true)

    // Picked from the gear: the panel opens.
    for (const many of [false, true]) {
      const calls: Call[] = []
      let opened: readonly MenuEntry[] = []
      let pick = (_id: string): void => {}
      settingsMenuFrom({
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
        profiles: () => many,
        openProfiles: () => void calls.push(['profiles']),
        fold: () => null,
        chooseFold() {},
      })({ getBoundingClientRect: () => RECT } as unknown as HTMLElement, false)
      expect(ids(opened).includes('profiles')).toBe(many)
      pick('profiles')
      expect(calls).toEqual([['profiles']])
    }
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

describe('Classic or Terminal (#161)', () => {
  const now = {
    t: translator('en'),
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right' as const,
    sleepers: true,
    profiles: false,
  }
  const ids = (items: readonly MenuEntry[]) => items.map(i => ('id' in i ? i.id : '—'))

  test('the Style item comes after Appearance, the style on show checked; none without one, as upstream’s menu', () => {
    expect(ids(settingsMenu(now))).toEqual(['theme', 'lang', 'panel', '—', 'sleepers'])
    expect(ids(settingsMenu({ ...now, look: 'classic' }))).toEqual(['theme', 'look', 'lang', 'panel', '—', 'sleepers'])
    expect(settingsMenu({ ...now, look: 'terminal' })[1]).toEqual({
      id: 'look',
      label: 'Style',
      submenu: [
        { id: 'look:classic', label: 'Classic', checked: false },
        { id: 'look:terminal', label: 'Terminal', checked: true },
      ],
    })
    expect(settingsMenu({ ...now, t: translator('ru'), look: 'classic' })[1]).toEqual({
      id: 'look',
      label: 'Стиль',
      submenu: [
        { id: 'look:classic', label: 'Классический', checked: true },
        { id: 'look:terminal', label: 'Терминал', checked: false },
      ],
    })
    expect(settingPicked('look:terminal')).toEqual({ kind: 'look', value: 'terminal' })
    expect(settingPicked('look:classic')).toEqual({ kind: 'look', value: 'classic' })
    expect(settingPicked('look:sepia')).toBeNull()
    expect(settingPicked('look')).toBeNull()
    expect(LOOKS.filter(isLook)).toEqual(['classic', 'terminal'])
  })

  test('out of the gear: the style the page shows checked, a pick sets it; a page without one offers none', () => {
    for (const shown of ['classic', 'terminal', undefined]) {
      const calls: Call[] = []
      let opened: readonly MenuEntry[] = []
      let pick = (_id: string): void => {}
      settingsMenuFrom({
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
        setTheme: theme => void calls.push(['theme', theme]),
        ...(shown && { look: () => shown, setLook: (look: string) => void calls.push(['look', look]) }),
        chooseLanguage() {},
        placePanels() {},
        resetPanelSize() {},
        toggleSleepers() {},
        profiles: () => false,
        openProfiles() {},
        fold: () => null,
        chooseFold() {},
      })({ getBoundingClientRect: () => RECT } as unknown as HTMLElement, false)
      const look = opened.find((i): i is MenuItem => 'id' in i && i.id === 'look')
      const checked = look?.submenu?.flatMap(i => ('checked' in i && i.checked ? [i.id] : [])) ?? null
      expect(checked).toEqual(shown ? [`look:${shown}`] : null)
      pick('look:terminal')
      pick('look:sepia')
      pick('theme:dark')
      expect(calls).toEqual(
        shown
          ? [
              ['look', 'terminal'],
              ['theme', 'dark'],
            ]
          : [['theme', 'dark']],
      )
    }
  })

  /** setLook on a page showing `shown`: what it kept, what <html> says after, whether it faded. */
  function picked(shown: string, look: string, transition: boolean, reduced: boolean) {
    const dataset: Record<string, string> = shown === 'classic' ? {} : { look: shown }
    const kept: string[] = []
    const faded: string[] = []
    setLook(look, {
      root: { dataset },
      keep: value => void kept.push(value),
      transition:
        transition && !reduced
          ? apply => {
              faded.push(look)
              apply()
            }
          : undefined,
    })
    return { dataset: { ...dataset }, kept, faded }
  }

  test('picked: kept in this browser and on the page, in a cross-fade when it can; the same again changes nothing', () => {
    for (const shown of ['classic', 'terminal'])
      for (const look of ['classic', 'terminal'])
        for (const transition of [false, true])
          for (const reduced of [false, true]) {
            const same = shown === look
            expect([shown, look, transition, reduced, picked(shown, look, transition, reduced)]).toEqual([
              shown,
              look,
              transition,
              reduced,
              {
                // Classic is no data-look at all: the page as it always was.
                dataset: look === 'classic' ? {} : { look },
                kept: same ? [] : [look],
                faded: !same && transition && !reduced ? [look] : [],
              },
            ])
          }
    expect(lookNow({ dataset: {} })).toBe('classic')
    expect(lookNow({ dataset: { look: 'terminal' } })).toBe('terminal')
  })

  test('before the page paints, only Terminal sets a style: kept in this browser, or the board’s with none kept', () => {
    expect(['terminal', 'classic', 'dark', '', null].map(raw => keptLook(raw))).toEqual([
      'terminal',
      null,
      null,
      null,
      null,
    ])
    // config.json's look: Terminal, unless this browser picked Classic.
    expect(['terminal', 'classic', 'dark', null].map(raw => keptLook(raw, 'terminal'))).toEqual([
      'terminal',
      null,
      'terminal',
      'terminal',
    ])
    expect(keptLook(null, 'classic')).toBeNull()
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
