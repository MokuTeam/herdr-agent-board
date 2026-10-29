// Settings (the gear in the toolbar; the old page's app.js #settings): the menu out of the button,
// and what its items do — light or dark (models/theme.ts), Classic or Terminal (models/look.ts),
// card text cut short or wrapped (models/card-text.ts), the board's language for every board, the panels' place and default size
// (components/panel/place.ts), whether sleeping sessions show, with more than one profile folder
// the Profiles panel, while wake's state line is in the payload Sleep and wake…, and how sessions
// asleep in "Waiting" fold, for every board; on the local board, Remote access…; on a page
// signed in through the owner's domain, Sign out; Presence (#172), the board's, for every board.
// The items are models/settings-menu.ts.
import { useEffect, useState } from 'react'
import type { FoldMode } from '../../../src/core/fold-mode.ts'
import { LANGUAGES, translator } from '../../../src/core/i18n/translator.ts'
import type { PresenceMode } from '../../../src/core/presence.ts'
import { type TodoMode, todoModeOf } from '../../../src/core/todos.ts'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, api, errorText, isReply, postJson, replyOf } from '../api/client.ts'
import type { MenuEngine, MenuSource } from '../components/menu/menu-engine.ts'
import { useLanguage } from '../i18n/I18nProvider.tsx'
import { CARD_TEXT_KEY, cardTextNow, setCardText } from '../models/card-text.ts'
import { LOOK_KEY, lookNow, setLook } from '../models/look.ts'
import { type Dock, isDock } from '../models/panel-layout.ts'
import { offersProfiles } from '../models/profiles.ts'
import { keptAuth, remotePage, UNPAIRED } from '../models/remote-page.ts'
import { offersMokupilot, settingPicked, settingsMenu } from '../models/settings-menu.ts'
import { reducedMotion } from '../models/spring.ts'
import { offersTeam } from '../models/team.ts'
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
  /** The style on show (data-look on <html>, else 'classic'); none: no Style item. */
  look?(): string
  setLook?(look: string): void
  /** Card text on show (data-card-text on <html>, else 'cut'); none: no Card text item. */
  cardText?(): string
  setCardText?(value: string): void
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
  /** The board offers MokuPilot calls: MokuPilot… is offered. */
  mokupilot?(): boolean
  openMokupilot?(): void
  /** The local board's page (not one through Tailscale or the domain): Remote access… is offered. */
  access?(): boolean
  openAccess?(): void
  /** The local board's page: Backup… is offered (#233). */
  backup?(): boolean
  openBackup?(): void
  /** The local board's page with the payload's teamRev (#231): Team… is offered. */
  team?(): boolean
  openTeam?(): void
  /** This page signed in through the owner's domain: Sign out is offered. */
  signOut?(): boolean
  endLogin?(): void
  /** Presence as the board has it ('none': not on); none: no Presence item. */
  presence?(): PresenceMode | 'none' | undefined
  idleMinutes?(): number | undefined
  choosePresence?(body: PresenceSetting): void
  /** Tasks as the board has them (#202, 'none': off); none: no Tasks item. */
  todos?(): TodoMode | undefined
  chooseTodos?(mode: TodoMode): void
}

/** What Settings → Presence asks the board for (POST /api/presence { op: 'settings', … }). */
export type PresenceSetting = { on: false } | { on: true; mode?: PresenceMode; idleMinutes?: number }

/** The menu out of the gear (`keyboard`: opened from the keyboard, the first item lit). */
export function settingsMenuFrom(deps: SettingsDeps): (button: HTMLElement, keyboard: boolean) => void {
  return (button, keyboard) => {
    const rect = button.getBoundingClientRect()
    const t = deps.t()
    const items = settingsMenu({
      t,
      theme: themeNow(deps.root()),
      look: deps.look?.(),
      cardText: deps.cardText?.(),
      languages: deps.languages(),
      canEdit: deps.canEdit(),
      dock: deps.dock(),
      sleepers: deps.sleepers(),
      profiles: deps.profiles(),
      fold: deps.fold(),
      wake: deps.wake?.() ?? false,
      phones: deps.phones?.() ?? false,
      mokupilot: deps.mokupilot?.() ?? false,
      access: deps.access?.() ?? false,
      backup: deps.backup?.() ?? false,
      team: deps.team?.() ?? false,
      signOut: deps.signOut?.() ?? false,
      presence: deps.presence?.(),
      idleMinutes: deps.idleMinutes?.(),
      todos: deps.todos?.(),
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
        else if (pick?.kind === 'look') deps.setLook?.(pick.value)
        else if (pick?.kind === 'cardText') deps.setCardText?.(pick.value)
        else if (pick?.kind === 'lang') deps.chooseLanguage(pick.value)
        else if (pick?.kind === 'dock') deps.placePanels(pick.value)
        else if (pick?.kind === 'reset') deps.resetPanelSize()
        else if (pick?.kind === 'sleepers') deps.toggleSleepers()
        else if (pick?.kind === 'profiles') deps.openProfiles()
        else if (pick?.kind === 'wake') deps.openWake?.()
        else if (pick?.kind === 'fold') deps.chooseFold(pick.value)
        else if (pick?.kind === 'phones') deps.openPhones?.()
        else if (pick?.kind === 'mokupilot') deps.openMokupilot?.()
        else if (pick?.kind === 'access') deps.openAccess?.()
        else if (pick?.kind === 'backup') deps.openBackup?.()
        else if (pick?.kind === 'team') deps.openTeam?.()
        else if (pick?.kind === 'signout') deps.endLogin?.()
        else if (pick?.kind === 'presence')
          deps.choosePresence?.(pick.value === 'none' ? { on: false } : { on: true, mode: pick.value })
        else if (pick?.kind === 'presenceIdle') deps.choosePresence?.({ on: true, idleMinutes: pick.value })
        else if (pick?.kind === 'todos') deps.chooseTodos?.(pick.value)
      },
    })
  }
}

/**
 * Sign out: this page's own login ends (POST /api/logout, the tunnel listener's), then the gate asks
 * hello again (UNPAIRED) and shows the login screen; a 401 (no login there any more) too. Any other
 * answer (Caddy's 502 while the board is closed), or none: the login may still hold on this device,
 * so the board stays on show and a toast says it was not signed out (the gate asked again would
 * keep the board on show all the same, #108, and say nothing).
 */
export async function endLogin({ t, toast }: Pick<LanguageDeps, 't' | 'toast'>): Promise<void> {
  try {
    const res = await postJson('/api/logout', {})
    if (!res.ok && res.status !== 401) {
      const reply = await replyOf(res)
      throw new ApiError(res.status, isReply(reply) ? reply : {})
    }
  } catch (err) {
    return toast(t('set.signOutFailed', { why: errorText(err, t) }), true)
  }
  dispatchEvent(new Event(UNPAIRED))
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

/** Presence on or off, its mode or idle minutes, for every board (config.json's `presence`). */
export async function choosePresence(
  body: PresenceSetting,
  {
    t,
    canEdit,
    save,
    toast,
  }: Pick<LanguageDeps, 't' | 'canEdit' | 'toast'> & {
    save(body: PresenceSetting & { op: 'settings' }): Promise<unknown>
  },
): Promise<void> {
  if (!canEdit) return toast(t('live.off'), true)
  try {
    await save({ op: 'settings', ...body })
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

/** The page's cross-fade into another theme or style, when the browser has it and motion is not reduced. */
const crossFade = (): ((apply: () => void) => unknown) | undefined =>
  typeof document.startViewTransition === 'function' && !reducedMotion.matches
    ? apply => document.startViewTransition(apply)
    : undefined

/**
 * Settings for the page: `menu` is the board's one menu (hooks/useContextMenus.ts);
 * `openProfiles` opens the Profiles panel, `openPhones` the Phones panel, `openWake` Sleep and wake,
 * `openAccess` the Remote access panel, `openMokupilot` the MokuPilot panel, `openBackup` the Backup panel,
 * `openTeam` the Team panel.
 */
export function useSettingsMenu(
  menu: MenuEngine,
  openProfiles: () => void,
  openPhones: () => void = () => {},
  openWake: () => void = () => {},
  openAccess: () => void = () => {},
  openMokupilot: () => void = () => {},
  openBackup: () => void = () => {},
  openTeam: () => void = () => {},
): SettingsMenu {
  const { t, choose } = useLanguage()
  const board = useBoardContext()
  const place = usePanelPlace()
  const latest = useLatest({
    t,
    choose,
    board,
    openProfiles,
    openPhones,
    openWake,
    openAccess,
    openMokupilot,
    openBackup,
    openTeam,
  })
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
          transition: crossFade(),
        }),
      look: () => lookNow(document.documentElement),
      setLook: look => {
        setLook(look, {
          root: document.documentElement,
          keep: value => storage.set(LOOK_KEY, value),
          transition: crossFade(),
        })
        // A column shown alone is the Terminal style's (its keys): Classic shows them all.
        if (look !== 'terminal') latest.current.board.dispatch({ type: 'column', id: null })
      },
      cardText: () => cardTextNow(document.documentElement),
      setCardText: value =>
        setCardText(value, {
          root: document.documentElement,
          keep: kept => storage.set(CARD_TEXT_KEY, kept),
          transition: crossFade(),
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
      mokupilot: () => offersMokupilot(latest.current.board.data),
      openMokupilot: () => latest.current.openMokupilot(),
      access: () => !remotePage(),
      openAccess: () => latest.current.openAccess(),
      backup: () => !remotePage(),
      openBackup: () => latest.current.openBackup(),
      team: () => offersTeam(latest.current.board.data),
      openTeam: () => latest.current.openTeam(),
      signOut: () => remotePage() && keptAuth() === 'login',
      endLogin: () => {
        const { t, board } = latest.current
        void endLogin({ t, toast: board.toast })
      },
      // No `presence` in the board's payload: presence is off.
      presence: () => {
        const data = latest.current.board.data
        return data ? (data.presence?.mode ?? 'none') : undefined
      },
      idleMinutes: () => latest.current.board.data?.presence?.idleMinutes,
      choosePresence: body => {
        const { t, board } = latest.current
        void choosePresence(body, {
          t,
          canEdit: board.canEdit,
          save: b => api.post('/api/presence', b),
          toast: board.toast,
        })
      },
      // No `todos` in the board's payload: tasks are off.
      todos: () => {
        const data = latest.current.board.data
        return data ? todoModeOf(data.todos ?? null) : undefined
      },
      chooseTodos: mode => {
        const { t, board } = latest.current
        if (!board.canEdit) return board.toast(t('live.off'), true)
        api.post('/api/todos', { op: 'settings', mode }).catch(err => board.toast(errorText(err, t), true))
      },
    })
    return settingsGear(menu, open, setExpanded)
  })
  useEffect(() => gear.watch(), [gear])
  return { open: gear.open, expanded }
}
