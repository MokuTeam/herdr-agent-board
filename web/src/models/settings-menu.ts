// Settings (the gear in the toolbar) as a menu: how the board looks (as the system has it, light or
// dark), its style (Classic or Terminal), whether card text is cut short or wraps, its language,
// where the session panel sits, and whether sleeping sessions show. Light or dark is this browser's
// (models/theme.ts), and so are the style (models/look.ts) and the card text (models/card-text.ts);
// the language is the board's, for every board; the panel's place is this
// browser's too (components/panel/place.ts). With more than one Claude
// profile folder found, Profiles… opens their panel (components/profiles/ProfilesPanel.tsx). While
// the remote mode is on (core/remote.ts), Phones… opens theirs (components/phones/PhonesPanel.tsx).
// The board on another device has Paths on this computer… (components/phones/LocalPathsPanel.tsx).
// While the payload carries wake's state line, Sleep and wake… opens its panel (components/wake).
// MokuPilot… opens where a call starts (components/mokupilot), on every board's page (offersMokupilot).
// On the local board, Remote access… opens the board-through-your-domain panel
// (components/access/AccessPanel.tsx), Backup… the backup of the board's database (#233,
// components/backup/BackupPanel.tsx), Updates… the board's update of itself from git (#617,
// components/updates/UpdatesPanel.tsx), and Time tracking… its clients and projects (#237,
// components/time/TimeSettingsPanel.tsx).
// How sessions asleep in "Waiting" fold is the board's, for every board (src/core/fold-mode.ts).
// On a page signed in through the owner's domain, Sign out ends this browser's own login (Call 15).
// Tasks (#202, src/core/todos.ts) are the board's: Off, the user's pins only, or agents too.
// Threads (#410, src/core/work-threads.ts) beside them, on the local board's page: Off, the owner's
// only, or agents too, and with Team on, shared over it or kept on this board.
// Presence (#172, src/core/presence.ts) is the board's: Off, or on with how it notices the user
// went away (by itself, only an offer, by hand only), and after how many idle minutes.
// Auto-compact (#378, src/core/compact.ts) is the board's: Off, or the default limit every session
// without one of its own compacts at (a session's own is set on its sheet or with `board compact`).
// Watches (#486), Decisions (#487, with whether a default may answer) and Away journal (#489) after
// Threads, and under Threads while they are on, Case files (#488) and Verified done (#492): Off or
// On, on the local board's page, each with one line on what it does (#596).
import { FOLD_MODES, type FoldMode, isFoldMode } from '../../../src/core/fold-mode.ts'
import { isPresenceMode, PRESENCE_MODES, type PresenceMode } from '../../../src/core/presence.ts'
import { isTodoMode, TODO_MODES, type TodoMode } from '../../../src/core/todos.ts'
import type { Translator } from '../../../src/core/types.ts'
import { isWatch } from '../../../src/core/watches.ts'
import { isThreadMode, THREAD_MODES, type ThreadMode } from '../../../src/core/work-threads.ts'
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
  /** The local board's page: Backup… is offered (#233). */
  backup?: boolean
  /** The local board's page: Updates… is offered (#617). */
  updates?: boolean
  /** The local board's page: Housekeeping… is offered (#652). */
  housekeeping?: boolean
  /** The local board's page: Time tracking… is offered (#237). */
  timeSettings?: boolean
  /** The local board's page: Calendar… is offered (#328). */
  calendarSettings?: boolean
  /** The local board's page with the payload's teamRev (#231): Team… is offered. */
  team?: boolean
  /** The local page of a board with `nodes` (the payload's `devices`, #510): Devices… is offered. */
  devices?: boolean
  /** This page signed in through the owner's domain: Sign out is offered, last. */
  signOut?: boolean
  /** Presence as the board has it ('none': not on); none given: no Presence item (an older board). */
  presence?: PresenceMode | 'none' | undefined
  /** Presence's idle minutes, while it is on. */
  idleMinutes?: number | undefined
  /** Tasks as the board has them (#202, 'none': off); none given: no Tasks item (an older board). */
  todos?: TodoMode | undefined
  /** Threads as the board has them (#410, 'none': off); none given: no Threads item (another device's page, an older board). */
  threads?: ThreadMode | undefined
  /** Threads shared over Team (#410); none given: no choice (Team off, or threads off). */
  threadsShare?: boolean | undefined
  /** The board on another device (models/remote-page.ts): Paths on this computer… is offered. */
  localPaths?: boolean
  /** Auto-compact's default limit as the board has it (#378, '' for off); none given: no item (an older board). */
  compact?: string | undefined
  /** Watches on (#486, the payload's `watches`); none given: no item (another device's page). */
  watches?: boolean | undefined
  /** Decisions on (#487, the payload's `decisions`); none given: no item (another device's page). */
  decisions?: boolean | undefined
  /** Whether a decision's default may answer it (the payload's `decisions.defaults`); none given: no choice (decisions off). */
  decisionsDefaults?: boolean | undefined
  /** The away journal on (#489, the payload's `journal`); none given: no item (another device's page). */
  journal?: boolean | undefined
  /** Case files on (#488, the payload's `threads.cases`); none given: no item (threads off, another device's page). */
  threadsCases?: boolean | undefined
  /** Verified done on (#492, the payload's `threads.verify`); none given: no item (threads off, another device's page). */
  threadsVerify?: boolean | undefined
  /** Watches being checked now: Off says they stop (#596). */
  watchesRunning?: number | undefined
  /** Decisions' defaults due to run: Off says they will not (#596). */
  defaultsRunning?: number | undefined
  /** The journal is on but journal.db did not open: what went wrong, shown in place of its line. */
  journalError?: string | undefined
}

/** The features Settings switches on and off by themselves (#596). */
export const FEATURE_SWITCHES = ['watches', 'decisions', 'journal'] as const
export type FeatureSwitch = (typeof FEATURE_SWITCHES)[number]
const isFeatureSwitch = (v: unknown): v is FeatureSwitch => FEATURE_SWITCHES.includes(v as FeatureSwitch)

/**
 * The switches as the payload says them (#596): watches by `watches`, decisions and the journal by
 * their own lines (there only while on), case files and verified done by the threads line's
 * `cases` and `verify` (absent while threads are off). Defaults only while decisions are on.
 */
export function featuresNow(payload: {
  watches?: true | undefined
  decisions?: { defaults: boolean; items?: readonly { defaultAt: number | null; held: boolean }[] } | undefined
  journal?: { strip?: unknown; last?: unknown; error?: string | undefined } | undefined
  threads?: { cases?: true; verify?: true } | undefined
  schedules?: readonly unknown[] | undefined
}): FeaturesNow {
  const { decisions, threads, journal } = payload
  const watches = payload.watches === true
  const checked = watches ? (payload.schedules ?? []).filter(e => isWatch(e) && !e.off).length : 0
  const defaults = (decisions?.items ?? []).filter(d => d.defaultAt !== null && !d.held).length
  return {
    watches,
    decisions: !!decisions,
    ...(decisions && { decisionsDefaults: decisions.defaults !== false }),
    journal: !!journal,
    ...(journal?.error && { journalError: journal.error }),
    ...(checked && { watchesRunning: checked }),
    ...(defaults && { defaultsRunning: defaults }),
    ...(threads && { threadsCases: threads.cases === true, threadsVerify: threads.verify === true }),
  }
}

type FeaturesNow = Pick<
  SettingsNow,
  | 'watches'
  | 'decisions'
  | 'decisionsDefaults'
  | 'journal'
  | 'journalError'
  | 'watchesRunning'
  | 'defaultsRunning'
  | 'threadsCases'
  | 'threadsVerify'
>

/**
 * One feature's Off and On (#596), its line under the name (`note`: another line in its place);
 * `running` things Off would leave behind are said on Off while it is on; `more` after them.
 */
function switchItem(
  now: SettingsNow,
  edit: { disabled?: boolean; reason?: string },
  id: FeatureSwitch,
  on: boolean | undefined,
  o: { more?: MenuEntry[]; running?: number | undefined; note?: string | undefined } = {},
): MenuEntry[] {
  const { t } = now
  if (on === undefined) return []
  const left = on && o.running ? { note: t(`set.${id}.offNote`, { n: o.running }) } : {}
  return [
    {
      id,
      label: t(`set.${id}`),
      note: o.note ?? t(`set.${id}.note`),
      ...edit,
      submenu: [
        { id: `${id}:off`, label: t('set.feature.off'), checked: !on, ...left },
        { id: `${id}:on`, label: t('set.feature.on'), checked: on },
        ...(o.more ?? []),
      ],
    },
  ]
}

function featureItems(now: SettingsNow, edit: { disabled?: boolean; reason?: string }): MenuEntry[] {
  const { t, decisions, decisionsDefaults } = now
  const defaults: MenuEntry[] =
    decisions && decisionsDefaults !== undefined
      ? [
          { separator: true as const },
          { id: 'decisionsDefaults:on', label: t('set.decisions.defaults'), checked: decisionsDefaults },
          { id: 'decisionsDefaults:off', label: t('set.decisions.noDefaults'), checked: !decisionsDefaults },
        ]
      : []
  return [
    ...switchItem(now, edit, 'watches', now.watches, { running: now.watchesRunning }),
    ...switchItem(now, edit, 'decisions', decisions, { more: defaults, running: now.defaultsRunning }),
    ...switchItem(now, edit, 'journal', now.journal, {
      note: now.journal && now.journalError ? t('set.journal.error', { error: now.journalError }) : undefined,
    }),
  ]
}

/** Under Threads while they are on (#596): case files and verified done, a check each; a pick asks for the other state. */
function threadParts(now: SettingsNow): MenuEntry[] {
  const { t } = now
  const parts = (
    [
      ['threadsCases', 'cases', now.threadsCases],
      ['threadsVerify', 'verify', now.threadsVerify],
    ] as const
  ).filter(([, , on]) => on !== undefined)
  if (now.threads === 'none' || !parts.length) return []
  return [
    { separator: true as const },
    ...parts.map(([id, name, on]) => ({
      id: `${id}:${on ? 'off' : 'on'}`,
      label: t(`set.${name}`),
      note: t(`set.${name}.note`),
      checked: !!on,
    })),
  ]
}

/** The default limits Settings → Auto-compact offers (#378); config.json or the CLI may hold any other. */
export const COMPACT_CHOICES = ['200k', '300k', '400k', '500k', '50%', '75%'] as const

function compactItem(now: SettingsNow, edit: { disabled?: boolean; reason?: string }): MenuEntry[] {
  const { t, compact } = now
  if (compact === undefined) return []
  // One config.json holds that the menu does not offer is shown too, checked.
  const choices: string[] = [...COMPACT_CHOICES]
  if (compact && !choices.includes(compact)) choices.push(compact)
  return [
    {
      id: 'compact',
      label: t('set.compact'),
      ...edit,
      submenu: [
        { id: 'compact:off', label: t('set.compact.off'), checked: compact === '' },
        { separator: true as const },
        ...choices.map(at => ({
          id: `compact:${at}`,
          label: at.endsWith('%') ? t('set.compact.share', { share: at }) : t('set.compact.tokens', { tokens: at }),
          checked: compact === at,
        })),
      ],
    },
  ]
}

/** Threads as the payload says (#410): off without its line; `agents: false` and `share: false` only where config.json says so. */
export function threadsNow(payload: {
  threads?: { agents?: boolean; share?: boolean } | undefined
  teamRev?: number | undefined
}): { mode: ThreadMode; share?: boolean } {
  const line = payload.threads
  if (!line) return { mode: 'none' }
  const mode = line.agents === false ? 'mine' : 'agents'
  return payload.teamRev === undefined ? { mode } : { mode, share: line.share !== false }
}

function threadsItem(now: SettingsNow, edit: { disabled?: boolean; reason?: string }): MenuEntry[] {
  const { t, threads, threadsShare } = now
  if (!threads) return []
  return [
    {
      id: 'threads',
      label: t('set.threads'),
      ...edit,
      submenu: [
        ...THREAD_MODES.map(id => ({ id: `threads:${id}`, label: t(`set.threads.${id}`), checked: threads === id })),
        ...(threads === 'none' || threadsShare === undefined
          ? []
          : [
              { separator: true as const },
              ...(['shared', 'local'] as const).map(id => ({
                id: `threadsShare:${id}`,
                label: t(`set.threads.${id}`),
                checked: threadsShare === (id === 'shared'),
              })),
            ]),
        ...threadParts(now),
      ],
    },
  ]
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
    ...threadsItem(now, edit),
    ...featureItems(now, edit),
    ...compactItem(now, edit),
    ...(now.profiles ? [{ id: 'profiles', label: t('set.profiles') }] : []),
    ...(now.wake ? [{ id: 'wake', label: t('set.wake') }] : []),
    ...(now.phones ? [{ id: 'phones', label: t('set.phones') }] : []),
    ...(now.mokupilot ? [{ id: 'mokupilot', label: t('set.mokupilot') }] : []),
    ...(now.access ? [{ id: 'access', label: t('set.access') }] : []),
    ...(now.backup ? [{ id: 'backup', label: t('set.backup') }] : []),
    ...(now.updates ? [{ id: 'updates', label: t('set.updates') }] : []),
    ...(now.housekeeping ? [{ id: 'housekeeping', label: t('set.housekeeping') }] : []),
    ...(now.timeSettings ? [{ id: 'timeSettings', label: t('set.time') }] : []),
    ...(now.calendarSettings ? [{ id: 'calendarSettings', label: t('set.calendar') }] : []),
    ...(now.localPaths ? [{ id: 'localPaths', label: t('set.localPaths') }] : []),
    ...(now.team ? [{ id: 'team', label: t('set.team') }] : []),
    ...(now.devices ? [{ id: 'devices', label: t('node.set.devices') }] : []),
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
  | { kind: 'backup' }
  | { kind: 'updates' }
  | { kind: 'housekeeping' }
  | { kind: 'timeSettings' }
  | { kind: 'calendarSettings' }
  | { kind: 'team' }
  | { kind: 'devices' }
  | { kind: 'signout' }
  | { kind: 'presence'; value: PresenceMode | 'none' }
  | { kind: 'presenceIdle'; value: number }
  | { kind: 'todos'; value: TodoMode }
  | { kind: 'threads'; value: ThreadMode }
  | { kind: 'threadsShare'; value: boolean }
  | { kind: 'feature'; feature: FeatureSwitch; value: boolean }
  | { kind: 'decisionsDefaults'; value: boolean }
  | { kind: 'threadsCases'; value: boolean }
  | { kind: 'threadsVerify'; value: boolean }
  | { kind: 'compact'; value: string }
  | { kind: 'localPaths' }
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
  if (id === 'backup') return { kind: 'backup' }
  if (id === 'updates') return { kind: 'updates' }
  if (id === 'housekeeping') return { kind: 'housekeeping' }
  if (id === 'timeSettings') return { kind: 'timeSettings' }
  if (id === 'calendarSettings') return { kind: 'calendarSettings' }
  if (id === 'team') return { kind: 'team' }
  if (id === 'devices') return { kind: 'devices' }
  if (id === 'signout') return { kind: 'signout' }
  if (kind === 'presence' && (value === 'none' || isPresenceMode(value))) return { kind, value }
  if (kind === 'presenceIdle' && /^\d+$/.test(value)) return { kind, value: Number(value) }
  if (kind === 'todos' && isTodoMode(value)) return { kind, value }
  if (kind === 'threads' && isThreadMode(value)) return { kind, value }
  if (kind === 'threadsShare' && (value === 'shared' || value === 'local')) return { kind, value: value === 'shared' }
  // The feature switches (#596): on or off, as the item asks.
  if (value === 'on' || value === 'off') {
    if (isFeatureSwitch(kind)) return { kind: 'feature', feature: kind, value: value === 'on' }
    if (kind === 'decisionsDefaults' || kind === 'threadsCases' || kind === 'threadsVerify')
      return { kind, value: value === 'on' }
  }
  // Off is '' for the board; a limit as the menu wrote it.
  if (kind === 'compact' && value) return { kind, value: value === 'off' ? '' : value }
  if (id === 'localPaths') return { kind: 'localPaths' }
  return null
}
