// The toolbar: the board's summary at the start of the row while the board is wide enough for it, the
// filters (the lanes control, the profile switch when two or more profiles are shown, search) and
// the actions (new session, categories, the schedule, Tasks, the calendar, Time, the archive, Next,
// the presence switch, the quiet notes, the usage pill), then More, Settings (the gear) and the
// live dot; the read-only banner and the column heads under it. The page's name is a heading for
// screen readers only (#351): it carried nothing a sighted user needed, and its room goes to the
// actions. When the whole of it fits the toolbar is one row, the filters beside the actions; else two,
// the actions on top and the filters under them, and the lanes scroll the filters away (#347,
// hooks/useToolbarCollapse.ts): a button with the filters' count stands for them while they are
// folded, and brings them back. The actions in the row are as many as its width holds, in
// the order of models/toolbar-fit.ts; the rest are in More (hooks/useToolbarFit.ts), which lists them
// with their counts. The lanes control and the profile switch each fold into a pill where the row has no
// room for all of their segments (hooks/useSegmentFolds.ts). The icon-only buttons' labels carry their
// text keys (`data-i18n`, as upstream's page wrote them): the stylesheet hides a label beside its
// icon by that, leaving it the button's name.

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { useBoardView } from '../hooks/useBoardView.ts'
import { useCollapse } from '../hooks/useCollapse.ts'
import { useColumnWidths } from '../hooks/useColumnWidths.ts'
import { useNextAttention } from '../hooks/useNextAttention.ts'
import { useScrolled } from '../hooks/useScrolled.ts'
import { useSegmentFolds } from '../hooks/useSegmentFolds.ts'
import type { SegmentPicks } from '../hooks/useSegmentPicks.ts'
import type { SettingsMenu } from '../hooks/useSettingsMenu.ts'
import type { SetupNoteState } from '../hooks/useSetupNote.ts'
import { useToolbarCollapse } from '../hooks/useToolbarCollapse.ts'
import { useToolbarFit } from '../hooks/useToolbarFit.ts'
import type { ToolbarMenu } from '../hooks/useToolbarMore.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { litLanes } from '../models/lane-picks.ts'
import { presenceSwitch } from '../models/presence.ts'
import { pickedProfile, profileOptions } from '../models/profiles.ts'
import { openMine, proposedCount } from '../models/todos.ts'
import {
  attentionCount,
  columnHeads,
  documentTitle,
  laneOptions,
  scheduleBadge,
  summaryParts,
} from '../models/toolbar.ts'
import { filterCount, filterText } from '../models/toolbar-collapse.ts'
import { moreAlert, moreEntries, TOOLBAR_PRIORITY } from '../models/toolbar-fit.ts'
import { toolbarEntries } from '../models/toolbar-menu.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { BackupNote } from './BackupNote.tsx'
import { ColumnsHead } from './ColumnsHead.tsx'
import { CalendarButton } from './calendar/CalendarButton.tsx'
import { classNames } from './class-names.ts'
import {
  AlarmIcon,
  ArchiveIcon,
  FilterIcon,
  GearIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
  TasksIcon,
  TeamIcon,
  TimeIcon,
} from './icons.tsx'
import { Lanes } from './Lanes.tsx'
import { Limits } from './Limits.tsx'
import { LiveDot } from './LiveDot.tsx'
import { NextAttention } from './NextAttention.tsx'
import { PresenceSwitch } from './PresenceSwitch.tsx'
import { ProfileSwitch } from './ProfileSwitch.tsx'
import { SetupNote } from './SetupNote.tsx'
import { Summary } from './Summary.tsx'
import { WakeNote } from './wake/WakeNote.tsx'

export interface ToolbarProps {
  /** The usage pill, which the popover is placed under and gives the focus back to. */
  limitsAnchor: RefObject<HTMLButtonElement | null>
  onNewSession?: (from: HTMLElement) => void
  onCategories?: () => void
  onSchedule?: () => void
  /** The archive's panel: sessions taken off the board, to find and bring back (it opens and closes). */
  onArchive?: () => void
  /** The quiet "Setup incomplete" note (hooks/useSetupNote.ts). */
  setup?: SetupNoteState
  /** The backup's note (#233): Settings → Backup… on the board on this computer; none elsewhere. */
  onBackup?: (() => void) | undefined
  /** Opens Settings → Sleep and wake…, from the quiet "Wake stopped" note (components/wake/WakeNote.tsx). */
  onWake?: () => void
  /** Settings, the gear's menu (hooks/useSettingsMenu.ts). */
  settings?: SettingsMenu
  /** The menus of the lanes control and the profile switch folded into pills (hooks/useSegmentPicks.ts). */
  picks?: SegmentPicks
  /** More's menu: the actions that left the row (hooks/useToolbarMore.ts). */
  more?: ToolbarMenu
  /** Tasks (#202): their panel opens and closes; the button shows while the board has them on. */
  onTodos?: () => void
  /** Time (#233): its panel, while the board has time tracking on. */
  onTime?: () => void
  /** The Team panel (#355), while the page offers the team: the button carries the unread count. */
  onTeam?: () => void
  /** The calendar (#328): its panel, while the board has the calendar on. */
  onCalendar?: () => void
}

/** The first filter that can take the focus: the lanes' pill, else a lane, else search (the lanes control folded hides the rest). */
function focusFilters(row: HTMLElement | null): void {
  const first = ['#lanes-pick', '#lanes:not([hidden]) button', '#search']
    .map(selector => row?.querySelector<HTMLElement>(selector))
    .find(el => !!el)
  first?.focus()
}

/** The usage pill's words as a line: its parts (a profile, a window) one after another, as it draws them. */
const usageText = (pill: Element | null): string =>
  Array.from(pill?.children ?? [])
    .map(part => part.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ') ||
  (pill?.textContent?.trim() ?? '')

export function Toolbar({
  limitsAnchor,
  onNewSession,
  onCategories,
  onSchedule,
  onArchive,
  setup,
  onBackup,
  onWake,
  settings,
  picks,
  more,
  onTodos,
  onTime,
  onTeam,
  onCalendar,
}: ToolbarProps) {
  const t = useT()
  const { data, ui, dispatch, canMutate, canEdit, now } = useBoardContext()
  const { visible, categoryOf, anyProfile } = useBoardView()
  const lanes = data && laneOptions(data.categories, visible, ui.filter, categoryOf, t)
  const profiles = data && profileOptions(data.profiles, anyProfile, t)
  const profile = pickedProfile(ui.profile, data?.profiles)
  const fit = useRef<HTMLDivElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const filters = useRef<HTMLDivElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const folded = useSegmentFolds(row, JSON.stringify([lanes, ui.filter, profiles, profile]))
  const scrolled = useScrolled()
  const { rows, over } = useToolbarFit(fit, actions)
  const collapse = useToolbarCollapse(filters, rows)
  useCollapse(filters, collapse.collapsed)
  const openNext = useNextAttention()
  const badge = scheduleBadge(data?.schedules ?? [], now)
  const parts = data && summaryParts(data.items, t)
  const heads = data ? columnHeads(data.columns, visible, ui.filter, categoryOf, t, ui.moves) : []
  useColumnWidths(heads)

  useEffect(() => {
    if (data) document.title = documentTitle(data.items)
  }, [data])

  // The usage popover and the setup list go under their pill, or under More while it is in it (a
  // button out of the row has no place on the page). Set on every draw: a pill drawn anew has its own again.
  const leftOver = TOOLBAR_PRIORITY.filter(id => over.has(id))
  const noteRef = setup?.noteRef
  useLayoutEffect(() => {
    const find = (id: string) => row.current?.querySelector<HTMLButtonElement>(`#${id}`) ?? null
    limitsAnchor.current = over.has('limits') ? moreButton.current : find('limits')
    if (noteRef) noteRef.current = over.has('setup-note') ? moreButton.current : find('setup-note')
  })

  const openTasks = data?.todos ? openMine(data.items) : 0
  /** What More lists for the actions in it (the pill's own words, read when More is pressed). */
  const entriesFor = (usage: string) =>
    moreEntries(
      toolbarEntries(
        {
          canMutate,
          schedule: badge,
          tasks: data?.todos ? { open: openTasks, proposed: proposedCount(data.items) } : null,
          next: data ? attentionCount(visible, ui.filter, categoryOf, ui.viewed) : 0,
          team: onTeam ? { unread: data?.teamUnread ?? 0 } : null,
          usage,
          presence: presenceSwitch(data?.presence, t),
        },
        t,
      ),
      leftOver,
    )
  const alert = moreAlert(entriesFor(''))

  /** An entry of More chosen: what its button does, with More as the place it came from. */
  function pick(id: string, from: HTMLElement): void {
    if (id === 'new-session') onNewSession?.(from)
    else if (id === 'cats-open') onCategories?.()
    else if (id === 'sched-open') onSchedule?.()
    else if (id === 'todos-open') onTodos?.()
    else if (id === 'cal-tb') onCalendar?.()
    else if (id === 'time-open') onTime?.()
    else if (id === 'team-open') onTeam?.()
    else if (id === 'archive-open') onArchive?.()
    else if (id === 'next-attention') openNext()
    else if (id === 'limits') dispatch({ type: 'limits', open: !ui.limitsOpen })
    // Presence's buttons and the quiet notes act on state of their own: the button is pressed.
    else row.current?.querySelector<HTMLElement>(`#${id}`)?.click()
  }

  const filtersOn = {
    lanes: ui.filter.length ? (lanes ?? []).filter(l => litLanes(ui.filter).includes(l.id)).map(l => l.title) : [],
    profile: profile === 'all' ? null : (profiles?.find(p => p.id === profile)?.title ?? null),
    query: ui.query.trim(),
  }
  const filterLabel = filterText(filtersOn)
  const peek = filterLabel ? t('tb.filtersOn', { text: filterLabel }) : t('tb.filters')

  return (
    <header className={classNames('toolbar', scrolled && 'scrolled', collapse.collapsed && 'folded')}>
      {/* The row's own width: the page's, less a side panel lying over the board (--over-*). */}
      <div className="toolbar-fit" ref={fit}>
        <div className="toolbar-row" ref={row}>
          {/* The name of the page is for screen readers; the summary hides in a narrower toolbar. */}
          <div className="titles">
            <h1 className="sr-only">{t('tb.title')}</h1>
            <Summary parts={parts} />
          </div>
          <div className="controls">
            <div
              className="toolbar-filters"
              id="toolbar-filters"
              ref={filters}
              data-folded={collapse.collapsed ? '' : undefined}
            >
              <Lanes
                options={lanes}
                picked={ui.filter}
                onPick={id => dispatch({ type: 'toggleLane', id })}
                folded={folded.has('lanes')}
                picks={picks}
              />
              {profiles && (
                <ProfileSwitch
                  options={profiles}
                  picked={profile}
                  onPick={id => dispatch({ type: 'profile', id })}
                  folded={folded.has('profiles')}
                  picks={picks}
                />
              )}
              <label className="search">
                <SearchIcon />
                <input
                  id="search"
                  type="search"
                  placeholder={t('tb.search')}
                  autoComplete="off"
                  spellCheck={false}
                  value={ui.query}
                  onChange={e => dispatch({ type: 'query', text: e.currentTarget.value })}
                />
              </label>
            </div>
            <div className="toolbar-actions" ref={actions}>
              {/* The filters, folded: one button with how many are on; it opens them again. */}
              <button
                type="button"
                className={classNames('pill-toggle icon-only', filterCount(filtersOn) > 0 && 'on')}
                id="toolbar-peek"
                hidden={!collapse.collapsed}
                aria-expanded={!collapse.collapsed}
                aria-controls="toolbar-filters"
                title={peek}
                aria-label={peek}
                onClick={e => {
                  collapse.open()
                  // From the keys: the focus goes to the filters, which the button leaves.
                  if (e.detail === 0) requestAnimationFrame(() => focusFilters(row.current))
                }}
              >
                <FilterIcon />
                <span className="n">{filterCount(filtersOn) || ''}</span>
              </button>
              {/* New sessions go through herdr: they wait for fresh data like going to a session does. */}
              <button
                type="button"
                className="pill-toggle icon-only new-session"
                id="new-session"
                disabled={!canMutate}
                title={t(canMutate ? 'launch.toolbarHint' : 'mobile.readOnly')}
                onClick={e => onNewSession?.(e.currentTarget)}
              >
                <PlusIcon />
                <span data-i18n="launch.toolbar">{t('launch.toolbar')}</span>
              </button>
              <button
                type="button"
                className="pill-toggle icon-only"
                id="cats-open"
                title={t('tb.catsTitle')}
                onClick={() => onCategories?.()}
              >
                <TagIcon />
                <span data-i18n="tb.cats">{t('tb.cats')}</span>
              </button>
              <button
                type="button"
                className={badge.due ? 'pill-toggle icon-only due' : 'pill-toggle icon-only'}
                id="sched-open"
                title={t('tb.schedTitle')}
                onClick={() => onSchedule?.()}
              >
                <AlarmIcon />
                <span data-i18n="tb.sched">{t('tb.sched')}</span>
                <span className="n" id="sched-count">
                  {badge.count || ''}
                </span>
              </button>
              {data?.todos && (
                <button
                  type="button"
                  className="pill-toggle icon-only"
                  id="todos-open"
                  title={t('todo.openHint')}
                  onClick={() => onTodos?.()}
                >
                  <TasksIcon />
                  <span>{t('todo.open')}</span>
                  <span className="n">{openTasks || ''}</span>
                  {proposedCount(data.items) > 0 && (
                    <span className="n confirm" title={t('todo.toConfirmHint')}>
                      {t('todo.toConfirm', { n: proposedCount(data.items) })}
                    </span>
                  )}
                </button>
              )}
              {onTeam && (
                <button
                  type="button"
                  className={(data?.teamUnread ?? 0) > 0 ? 'pill-toggle icon-only unread' : 'pill-toggle icon-only'}
                  id="team-open"
                  title={
                    (data?.teamUnread ?? 0) > 0 ? t('team.unread', { n: data?.teamUnread ?? 0 }) : t('team.openHint')
                  }
                  onClick={() => onTeam()}
                >
                  <TeamIcon />
                  <span>{t('team.title')}</span>
                  <span className="n">{data?.teamUnread || ''}</span>
                </button>
              )}
              {data?.calendar && <CalendarButton onOpen={() => onCalendar?.()} />}
              {data?.time && (
                <button
                  type="button"
                  className="pill-toggle icon-only"
                  id="time-open"
                  title={t('time.openHint')}
                  onClick={() => onTime?.()}
                >
                  <TimeIcon />
                  <span>{t('time.open')}</span>
                </button>
              )}
              <button
                type="button"
                className="pill-toggle icon-only"
                id="archive-open"
                title={t('archive.openHint')}
                onClick={() => onArchive?.()}
              >
                <ArchiveIcon />
                <span data-i18n="archive.open">{t('archive.open')}</span>
              </button>
              <NextAttention />
              <PresenceSwitch />
              {setup && <SetupNote setup={setup} />}
              <BackupNote onOpen={onBackup} />
              {onWake && <WakeNote onOpen={onWake} />}
              <Limits anchor={limitsAnchor} />
              {/* What left the row. It is there (its attribute hides it) so its width is known. */}
              <button
                type="button"
                className="pill-toggle icon-only toolbar-more"
                id="toolbar-more"
                ref={moreButton}
                data-over=""
                aria-haspopup="menu"
                aria-expanded={more?.expanded ?? false}
                title={t(alert ? 'tb.moreAlert' : 'tb.more')}
                aria-label={t(alert ? 'tb.moreAlert' : 'tb.more')}
                onClick={e => {
                  const from = e.currentTarget
                  const usage = usageText(row.current?.querySelector('#limits') ?? null)
                  more?.open(from, e.detail === 0, entriesFor(usage), id => pick(id, from))
                }}
              >
                <MoreIcon />
                <span className="more-dot" aria-hidden="true" hidden={!alert} />
              </button>
              <button
                type="button"
                className="pill-toggle icon-only"
                id="settings"
                aria-haspopup="menu"
                aria-expanded={settings?.expanded ?? false}
                title={t('set.hint')}
                onClick={e => settings?.open(e.currentTarget, e.detail === 0)}
              >
                <GearIcon />
                <span data-i18n="set.title">{t('set.title')}</span>
              </button>
              <LiveDot />
            </div>
          </div>
        </div>
      </div>
      <p id="connection-state" role="status" hidden={canMutate}>
        {t(canEdit ? 'mobile.readOnly' : 'live.off')}
      </p>
      <ColumnsHead heads={heads} only={ui.column} />
    </header>
  )
}
