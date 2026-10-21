// Settings (the gear in the toolbar; the old page's app.js #settings): the menu out of the button,
// and what its items do — light or dark (models/theme.ts), the board's language for every board,
// the panels' place and default size (components/panel/place.ts), whether sleeping sessions show,
// with more than one profile folder the Profiles panel, while wake's state line is in the payload
// Sleep and wake…, and how sessions asleep in "Waiting" fold, for every board. The items are models/settings-menu.ts.
import { useEffect, useState } from 'react'
import type { FoldMode } from '../../../src/core/fold-mode.ts'
import { LANGUAGES, translator } from '../../../src/core/i18n/translator.ts'
import type { Translator } from '../../../src/core/types.ts'
import { api, errorText } from '../api/client.ts'
import type { MenuEngine, MenuSource } from '../components/menu/menu-engine.ts'
import { useLanguage } from '../i18n/I18nProvider.tsx'
import { type Dock, isDock } from '../models/panel-layout.ts'
import { offersProfiles } from '../models/profiles.ts'
import { settingPicked, settingsMenu } from '../models/settings-menu.ts'
import { reducedMotion } from '../models/spring.ts'
import { setTheme, THEME_KEY, themeNow } from '../models/theme.ts'
import { isWakeView } from '../models/wake.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { storage } from '../state/storage.ts'
import { useLatest } from './useLatest.ts'
import { usePanelPlace } from './usePanelLayout.ts'

export interface SettingsDeps {
  menu: Pick<MenuEngine, 'open'>
  t(): Translator
  canEdit(): boolean
  /** The board's languages by code. */
  languages(): Record<string, string>
  dock(): Dock
  sleepers(): boolean
  /** <html>: its data-theme is the look. */
  root(): { dataset: DOMStringMap }
  /** The pointer is a finger. */
  coarse(): boolean
  setTheme(theme: string): void
  chooseLanguage(lang: string): void
  placePanels(dock: string): void
  resetPanelSize(): void
  toggleSleepers(): void
  /** More than one profile folder is found (the payload's profiles): Profiles… is offered. */
  profiles(): boolean
  openProfiles(): void
  /** How sessions asleep in "Waiting" fold, as the board says (null: it does not, none offered). */
  fold(): FoldMode | null
  chooseFold(mode: FoldMode): void
  /** The payload carries wake's state line: Sleep and wake… is offered. */
  wake?(): boolean
  openWake?(): void
  /** The remote mode is on: Phones… is offered. */
  phones?(): boolean
  openPhones?(): void
}

/** The menu out of the gear (`keyboard`: opened from the keyboard, the first item lit). */
export function settingsMenuFrom(deps: SettingsDeps): (button: HTMLElement, keyboard: boolean) => void {
  return (button, keyboard) => {
    const rect = button.getBoundingClientRect()
    const t = deps.t()
    const items = settingsMenu({
      t,
      theme: themeNow(deps.root()),
      languages: deps.languages(),
      canEdit: deps.canEdit(),
      dock: deps.dock(),
      sleepers: deps.sleepers(),
      profiles: deps.profiles(),
      fold: deps.fold(),
      wake: deps.wake?.() ?? false,
      phones: deps.phones?.() ?? false,
    })
    const source: MenuSource = keyboard ? 'keyboard' : deps.coarse() ? 'touch' : 'mouse'
    deps.menu.open(items, {
      x: rect.right,
      y: rect.bottom + 6,
      source,
      origin: button,
      label: t('set.title'),
      onPick: id => {
        const pick = settingPicked(id)
        if (pick?.kind === 'theme') deps.setTheme(pick.value)
        else if (pick?.kind === 'lang') deps.chooseLanguage(pick.value)
        else if (pick?.kind === 'dock') deps.placePanels(pick.value)
        else if (pick?.kind === 'reset') deps.resetPanelSize()
        else if (pick?.kind === 'sleepers') deps.toggleSleepers()
        else if (pick?.kind === 'profiles') deps.openProfiles()
        else if (pick?.kind === 'wake') deps.openWake?.()
        else if (pick?.kind === 'fold') deps.chooseFold(pick.value)
        else if (pick?.kind === 'phones') deps.openPhones?.()
      },
    })
  }
}

export interface LanguageDeps {
  t: Translator
  canEdit: boolean
  /** The page shows it at once (I18nProvider's choose). */
  choose(lang: string): void
  /** POST /api/settings. */
  save(body: { language: string }): Promise<unknown>
  toast(text: string, error?: boolean): void
}

/** How sessions asleep in "Waiting" fold, for every board (config.json); the board shows it once the server has it. */
export async function chooseFold(
  mode: FoldMode,
  {
    t,
    canEdit,
    save,
    toast,
  }: Pick<LanguageDeps, 't' | 'canEdit' | 'toast'> & {
    save(body: { foldWaiting: FoldMode }): Promise<unknown>
  },
): Promise<void> {
  if (!canEdit) return toast(t('live.off'), true)
  try {
    await save({ foldWaiting: mode })
  } catch (err) {
    toast(errorText(err, t), true)
  }
}

/** The board's language, for every board (the server keeps it in config.json). */
export async function chooseLanguage(next: string, { t, canEdit, choose, save, toast }: LanguageDeps): Promise<void> {
  if (!canEdit) return toast(t('live.off'), true)
  if (next === t.lang) return
  choose(next)
  try {
    await save({ language: next })
  } catch (err) {
    toast(errorText(err, translator(next)), true)
  }
}

export interface SettingsMenu {
  /** The gear was pressed. */
  open(button: HTMLElement, keyboard: boolean): void
  /** The menu up is the gear's (its aria-expanded). */
  expanded: boolean
}

export interface SettingsGear {
  /** The gear pressed: it says its menu is up, then opens it. */
  open(button: HTMLElement, keyboard: boolean): void
  /** Keeps what the gear says with the menu, until the function it gives back is called. */
  watch(): () => void
}

/**
 * The gear's aria-expanded kept with the menu, as the old page's #settings and its menu's onChange
 * kept it: true as it opens its menu; false whenever a menu goes and none is up, which another
 * menu opening in its place does too (the one before closes first).
 */
export function settingsGear(
  menu: Pick<MenuEngine, 'openNow' | 'isOpen'>,
  openMenu: (button: HTMLElement, keyboard: boolean) => void,
  expanded: (on: boolean) => void,
): SettingsGear {
  return {
    open(button, keyboard) {
      expanded(true)
      openMenu(button, keyboard)
    },
    watch: () =>
      menu.openNow.subscribe(() => {
        if (!menu.isOpen()) expanded(false)
      }),
  }
}

/**
 * Settings for the page: `menu` is the board's one menu (hooks/useContextMenus.ts);
 * `openProfiles` opens the Profiles panel, `openPhones` the Phones panel, `openWake` Sleep and wake.
 */
export function useSettingsMenu(
  menu: MenuEngine,
  openProfiles: () => void,
  openPhones: () => void = () => {},
  openWake: () => void = () => {},
): SettingsMenu {
  const { t, choose } = useLanguage()
  const board = useBoardContext()
  const place = usePanelPlace()
  const latest = useLatest({ t, choose, board, openProfiles, openPhones, openWake })
  const [expanded, setExpanded] = useState(false)
  const [gear] = useState(() => {
    const open = settingsMenuFrom({
      menu,
      t: () => latest.current.t,
      canEdit: () => latest.current.board.canEdit,
      languages: () => latest.current.board.data?.languages ?? LANGUAGES,
      dock: () => place.layout.dock,
      sleepers: () => latest.current.board.ui.sleepers,
      root: () => document.documentElement,
      coarse: () => matchMedia('(pointer: coarse)').matches,
      setTheme: theme =>
        setTheme(theme, {
          root: document.documentElement,
          keep: value => storage.set(THEME_KEY, value),
          // A cross-fade, not a flash from one brightness to the other.
          transition:
            typeof document.startViewTransition === 'function' && !reducedMotion.matches
              ? apply => document.startViewTransition(apply)
              : undefined,
        }),
      chooseLanguage: lang => {
        const { t, choose, board } = latest.current
        void chooseLanguage(lang, {
          t,
          canEdit: board.canEdit,
          choose,
          save: body => api.post('/api/settings', body),
          toast: board.toast,
        })
      },
      placePanels: dock => isDock(dock) && place.placePanels(dock),
      resetPanelSize: () => place.resetPanelSize(),
      toggleSleepers: () => latest.current.board.dispatch({ type: 'toggleSleepers' }),
      profiles: () => offersProfiles(latest.current.board.data?.profiles),
      openProfiles: () => latest.current.openProfiles(),
      fold: () => latest.current.board.data?.foldWaiting ?? null,
      chooseFold: mode => {
        const { t, board } = latest.current
        void chooseFold(mode, {
          t,
          canEdit: board.canEdit,
          save: body => api.post('/api/settings', body),
          toast: board.toast,
        })
      },
      wake: () => isWakeView(latest.current.board.data?.wake),
      openWake: () => latest.current.openWake(),
      phones: () => !!latest.current.board.data?.remote,
      openPhones: () => latest.current.openPhones(),
    })
    return settingsGear(menu, open, setExpanded)
  })
  useEffect(() => gear.watch(), [gear])
  return { open: gear.open, expanded }
}
