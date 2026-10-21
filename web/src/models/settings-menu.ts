// Settings (the gear in the toolbar) as a menu: how the board looks (as the system has it, light or
// dark), its style (Classic or Terminal), its language, where the session panel sits, and whether
// sleeping sessions show. Light or dark is this browser's (models/theme.ts), and so is the style
// (models/look.ts); the language is the board's, for every board; the panel's place is this
// browser's too (components/panel/place.ts). With more than one Claude
// profile folder found, Profiles… opens their panel (components/profiles/ProfilesPanel.tsx). While
// the remote mode is on (core/remote.ts), Phones… opens theirs (components/phones/PhonesPanel.tsx).
// How sessions asleep in "Waiting" fold is the board's, for every board (src/core/fold-mode.ts).
import { FOLD_MODES, type FoldMode, isFoldMode } from '../../../src/core/fold-mode.ts'
import type { Translator } from '../../../src/core/types.ts'
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
  /** The remote mode is on (the payload's `remote`): Phones… is offered. */
  phones?: boolean
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
    ...(now.profiles ? [{ id: 'profiles', label: t('set.profiles') }] : []),
    ...(now.phones ? [{ id: 'phones', label: t('set.phones') }] : []),
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
  ]
}

/** What a picked item asks for. */
export type SettingPick =
  | { kind: 'theme'; value: string }
  | { kind: 'look'; value: string }
  | { kind: 'lang'; value: string }
  | { kind: 'dock'; value: string }
  | { kind: 'reset' }
  | { kind: 'sleepers' }
  | { kind: 'profiles' }
  | { kind: 'fold'; value: FoldMode }
  | { kind: 'phones' }
  | null

export function settingPicked(id: string): SettingPick {
  const [kind, value = ''] = id.split(':')
  if (kind === 'theme' || kind === 'lang') return { kind, value }
  if (kind === 'look' && isLook(value)) return { kind, value }
  if (kind === 'dock') return value === 'reset' ? { kind: 'reset' } : { kind: 'dock', value }
  if (id === 'sleepers') return { kind: 'sleepers' }
  if (id === 'profiles') return { kind: 'profiles' }
  if (kind === 'fold' && isFoldMode(value)) return { kind, value }
  if (id === 'phones') return { kind: 'phones' }
  return null
}
