// Settings (the gear in the toolbar; the old page's app.js #settings): the menu out of the button,
// and what its items do — light or dark (models/theme.ts), the board's language for every board,
// the panels' place and default size (components/panel/place.ts), and whether sleeping sessions
// show. The items are models/settings-menu.ts.
import { useEffect, useState } from 'react'
import { LANGUAGES, translator } from '../../../src/core/i18n/translator.ts'
import type { Translator } from '../../../src/core/types.ts'
import { api, errorText } from '../api/client.ts'
import type { MenuEngine, MenuSource } from '../components/menu/menu-engine.ts'
import { useLanguage } from '../i18n/I18nProvider.tsx'
import { type Dock, isDock } from '../models/panel-layout.ts'
import { settingPicked, settingsMenu } from '../models/settings-menu.ts'
import { reducedMotion } from '../models/spring.ts'
import { setTheme, THEME_KEY, themeNow } from '../models/theme.ts'
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

/** Settings for the page: `menu` is the board's one menu (hooks/useContextMenus.ts). */
export function useSettingsMenu(menu: MenuEngine): SettingsMenu {
  const { t, choose } = useLanguage()
  const board = useBoardContext()
  const place = usePanelPlace()
  const latest = useLatest({ t, choose, board })
  const [expanded, setExpanded] = useState(false)
  // The menu gone (not one opened in its place): the gear says it is closed.
  useEffect(() => menu.openNow.subscribe(() => !menu.isOpen() && setExpanded(false)), [menu])

  const [open] = useState(() =>
    settingsMenuFrom({
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
    }),
  )

  return {
    open(button, keyboard) {
      open(button, keyboard)
      setExpanded(true)
    },
    expanded,
  }
}
