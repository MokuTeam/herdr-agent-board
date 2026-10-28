// Settings (the gear in the toolbar) as a menu: how the board looks (as the system has it, light or
// dark), its style (Classic or Terminal), whether card text is cut short or wraps, its language,
// where the session panel sits, and whether sleeping sessions show. Light or dark is this browser's
// (models/theme.ts), and so are the style (models/look.ts) and the card text (models/card-text.ts);
// the language is the board's, for every board; the panel's place is this
// browser's too (components/panel/place.ts). With more than one Claude
// profile folder found, Profiles… opens their panel (components/profiles/ProfilesPanel.tsx). While
// the remote mode is on (core/remote.ts), Phones… opens theirs (components/phones/PhonesPanel.tsx).
// While the payload carries wake's state line, Sleep and wake… opens its panel (components/wake).
// MokuPilot… opens where a call starts (components/mokupilot), on every board's page (offersMokupilot).
// On the local board, Remote access… opens the board-through-your-domain panel
// (components/access/AccessPanel.tsx).
// How sessions asleep in "Waiting" fold is the board's, for every board (src/core/fold-mode.ts).
// On a page signed in through the owner's domain, Sign out ends this browser's own login (Call 15).
// Tasks (#202, src/core/todos.ts) are the board's: Off, the user's pins only, or agents too.
// Presence (#172, src/core/presence.ts) is the board's: Off, or on with how it notices the user
// went away (by itself, only an offer, by hand only), and after how many idle minutes.
import { FOLD_MODES, type FoldMode, isFoldMode } from '../../../src/core/fold-mode.ts'
import { isPresenceMode, PRESENCE_MODES, type PresenceMode } from '../../../src/core/presence.ts'
import { isTodoMode, TODO_MODES, type TodoMode } from '../../../src/core/todos.ts'
import type { Translator } from '../../../src/core/types.ts'
import { CARD_TEXTS, type CardText, isCardText } from './card-text.ts'
import { isLook, LOOKS } from './look.ts'
import type { MenuEntry } from './menu-model.ts'
import { DOCKS, type Dock } from './panel-layout.ts'
import { THEMES } from './theme.ts'

/** What the menu shows checked and what it can do now. */
export interface SettingsNow {
  t: Translator
  /** data-theme on <html>, else 'auto'. */
  theme: string
  /** data-look on <html>, else 'classic'; none given: no Style item (upstream's menu). */
  look?: string | undefined
  /** data-card-text on <html>, else 'cut'; none given: no Card text item (upstream's menu). */
  cardText?: string | undefined
  /** The board's languages by code ({ en: 'English', … }). */
  languages: Record<string, string>
  /** The language can only be switched with the board there. */
  canEdit: boolean
  dock: Dock
  sleepers: boolean
  /** More than one profile folder is found (models/profiles.ts offersProfiles): Profiles… is offered. */
  profiles: boolean
  /** How sessions asleep in "Waiting" fold; null from a board that does not say (none offered). */
  fold?: FoldMode | null | undefined
  /** The payload carries wake's state line (#119): Sleep and wake… is offered. */
  wake?: boolean
  /** The remote mode is on (the payload's `remote`): Phones… is offered. */
  phones?: boolean
  /** MokuPilot… is offered (offersMokupilot: always, from the page). */
  mokupilot?: boolean
  /** The local board's page (not one through Tailscale or the domain): Remote access… is offered. */
  access?: boolean
  /** This page signed in through the owner's domain: Sign out is offered, last. */
  signOut?: boolean
  /** Presence as the board has it ('none': not on); none given: no Presence item (an older board). */
  presence?: PresenceMode | 'none' | undefined
  /** Presence's idle minutes, while it is on. */
  idleMinutes?: number | undefined
  /** Tasks as the board has them (#202, 'none': off); none given: no Tasks item (an older board). */
  todos?: TodoMode | undefined
}

/** The idle minutes Settings → Presence offers; config.json may hold any other. */
export const PRESENCE_IDLE_CHOICES = [5, 10, 15, 30, 60] as const

function presenceItem(now: SettingsNow, edit: { disabled?: boolean; reason?: string }): MenuEntry[] {
  const { t, presence } = now
  if (!presence) return []
  const idle = now.idleMinutes
  return [
    {
      id: 'presence',
      label: t('set.presence'),
      ...edit,
      submenu: [
        ...(['none', ...PRESENCE_MODES] as const).map(id => ({
          id: `presence:${id}`,
          label: t(`set.presence.${id}`),
          checked: presence === id,
        })),
        ...(presence === 'none' || presence === 'off'
          ? []
          : [
              { separator: true as const },
              ...PRESENCE_IDLE_CHOICES.map(min => ({
                id: `presenceIdle:${min}`,
                label: t('set.presence.idle', { min }),
                checked: idle === min,
              })),
            ]),
      ],
    },
  ]
}

export function settingsMenu(now: SettingsNow): MenuEntry[] {
  const { t } = now
  const edit = now.canEdit ? {} : { disabled: true, reason: t('live.off') }
  return [
    {
      id: 'theme',
      label: t('set.theme'),
      submenu: THEMES.map(id => ({ id: `theme:${id}`, label: t(`set.theme.${id}`), checked: now.theme === id })),
    },
    ...(now.look
      ? [
          {
            id: 'look',
            label: t('set.look'),
            submenu: LOOKS.map(id => ({ id: `look:${id}`, label: t(`set.look.${id}`), checked: now.look === id })),
          },
        ]
      : []),
    ...(now.cardText
      ? [
          {
            id: 'cardText',
            label: t('set.cardText'),
            submenu: CARD_TEXTS.map(id => ({
              id: `cardText:${id}`,
              label: t(`set.cardText.${id}`),
              checked: now.cardText === id,
            })),
          },
        ]
      : []),
    {
      id: 'lang',
      label: t('set.lang'),
      ...edit,
      submenu: Object.entries(now.languages).map(([code, name]) => ({
        id: `lang:${code}`,
        label: name,
        checked: t.lang === code,
      })),
    },
    {
      id: 'panel',
      label: t('set.panel'),
      submenu: [
        ...DOCKS.map(id => ({ id: `dock:${id}`, label: t(`panel.${id}`), checked: now.dock === id })),
        { separator: true },
        { id: 'dock:reset', label: t('panel.reset') },
      ],
    },
    ...presenceItem(now, edit),
    ...(now.todos
      ? [
          {
            id: 'todos',
            label: t('set.todos'),
            ...edit,
            submenu: TODO_MODES.map(id => ({
              id: `todos:${id}`,
              label: t(`set.todos.${id}`),
              checked: now.todos === id,
            })),
          },
        ]
      : []),
    ...(now.profiles ? [{ id: 'profiles', label: t('set.profiles') }] : []),
    ...(now.wake ? [{ id: 'wake', label: t('set.wake') }] : []),
    ...(now.phones ? [{ id: 'phones', label: t('set.phones') }] : []),
    ...(now.mokupilot ? [{ id: 'mokupilot', label: t('set.mokupilot') }] : []),
    ...(now.access ? [{ id: 'access', label: t('set.access') }] : []),
    { separator: true },
    { id: 'sleepers', label: t('tb.sleepersTitle'), checked: now.sleepers },
    ...(now.fold
      ? [
          {
            id: 'fold',
            label: t('set.fold'),
            ...edit,
            submenu: FOLD_MODES.map(id => ({ id: `fold:${id}`, label: t(`set.fold.${id}`), checked: now.fold === id })),
          },
        ]
      : []),
    ...(now.signOut ? [{ separator: true as const }, { id: 'signout', label: t('set.signOut') }] : []),
  ]
}

/** What a picked item asks for. */
export type SettingPick =
  | { kind: 'theme'; value: string }
  | { kind: 'look'; value: string }
  | { kind: 'cardText'; value: CardText }
  | { kind: 'lang'; value: string }
  | { kind: 'dock'; value: string }
  | { kind: 'reset' }
  | { kind: 'sleepers' }
  | { kind: 'profiles' }
  | { kind: 'wake' }
  | { kind: 'fold'; value: FoldMode }
  | { kind: 'phones' }
  | { kind: 'mokupilot' }
  | { kind: 'access' }
  | { kind: 'signout' }
  | { kind: 'presence'; value: PresenceMode | 'none' }
  | { kind: 'presenceIdle'; value: number }
  | { kind: 'todos'; value: TodoMode }
  | null

/**
 * Whether the page offers Settings → MokuPilot…: always, whatever the payload's `mokupilot` says,
 * so the mode can be changed also while no call is offered (`local` with MokuPilot missing on the
 * board's computer); the panel says when MokuPilot is turned off.
 */
export const offersMokupilot = (_payload?: { mokupilot?: boolean | undefined } | null): boolean => true

export function settingPicked(id: string): SettingPick {
  const [kind, value = ''] = id.split(':')
  if (kind === 'theme' || kind === 'lang') return { kind, value }
  if (kind === 'look' && isLook(value)) return { kind, value }
  if (kind === 'cardText' && isCardText(value)) return { kind, value }
  if (kind === 'dock') return value === 'reset' ? { kind: 'reset' } : { kind: 'dock', value }
  if (id === 'sleepers') return { kind: 'sleepers' }
  if (id === 'profiles') return { kind: 'profiles' }
  if (id === 'wake') return { kind: 'wake' }
  if (kind === 'fold' && isFoldMode(value)) return { kind, value }
  if (id === 'phones') return { kind: 'phones' }
  if (id === 'mokupilot') return { kind: 'mokupilot' }
  if (id === 'access') return { kind: 'access' }
  if (id === 'signout') return { kind: 'signout' }
  if (kind === 'presence' && (value === 'none' || isPresenceMode(value))) return { kind, value }
  if (kind === 'presenceIdle' && /^\d+$/.test(value)) return { kind, value: Number(value) }
  if (kind === 'todos' && isTodoMode(value)) return { kind, value }
  return null
}
