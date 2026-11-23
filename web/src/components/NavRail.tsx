// Collapsible left navigation rail (#651, Hybrid B+C header): holds Board, all Places panels
// (Decisions, Threads, Team, Tasks, Calendar, Schedule, Time, Categories, Archive), and Settings
// at the foot. 52px icon rail by default (expandable to 196px with labels and action counts),
// becoming a slide-over drawer on phone widths (<= 760px).
import { type ReactNode, useEffect, useLayoutEffect } from 'react'
import { useT } from '../i18n/I18nProvider.tsx'
import { teamBadge } from '../models/team.ts'
import { openMine, proposedCount } from '../models/todos.ts'
import { scheduleBadge } from '../models/toolbar.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { classNames } from './class-names.ts'
import {
  AlarmIcon,
  ArchiveIcon,
  BoardIcon,
  CalendarIcon,
  CloseIcon,
  DecisionsIcon,
  GearIcon,
  SidebarIcon,
  TagIcon,
  TasksIcon,
  TeamIcon,
  ThreadsIcon,
  TimeIcon,
} from './icons.tsx'

export type RailPlace =
  | 'board'
  | 'decisions'
  | 'threads'
  | 'team'
  | 'todos'
  | 'calendar'
  | 'schedule'
  | 'time'
  | 'categories'
  | 'archive'
  | 'settings'

export interface NavRailProps {
  expanded: boolean
  onToggleExpand(): void
  drawerOpen: boolean
  onCloseDrawer(): void
  activePlace: RailPlace
  onBoard(): void
  onDecisions?: (() => void) | undefined
  onThreads?: (() => void) | undefined
  onTeam?: (() => void) | undefined
  onTodos?: (() => void) | undefined
  onCalendar?: (() => void) | undefined
  onSchedule(): void
  onTime?: (() => void) | undefined
  onCategories(): void
  onArchive(): void
  onSettings(): void
  /** True when setup, backup, or wake has a warning. */
  systemAlert?: boolean
}

export const RAIL_STORAGE_KEY = 'board.rail'

interface RailItemProps {
  id?: string
  icon: ReactNode
  label: string
  active: boolean
  expanded: boolean
  /** Action count shown in amber when `alert` is true, else muted when expanded. */
  count?: number
  alert?: boolean
  kbd?: string
  title?: string
  onClick(): void
}

function RailItem({ id, icon, label, active, expanded, count, alert, kbd, title, onClick }: RailItemProps) {
  const showCount = (count ?? 0) > 0
  return (
    <button
      type="button"
      id={id}
      className={classNames('rail-item', active && 'on', alert && 'alert')}
      aria-current={active ? 'page' : undefined}
      title={title ?? label}
      onClick={onClick}
    >
      <span className="rail-icon">{icon}</span>
      <span className="rail-label">{label}</span>
      {!expanded && alert && <span className="rail-dot" aria-hidden="true" />}
      {showCount && <span className={classNames('rail-count', alert && 'warn')}>{count}</span>}
      {!showCount && alert && expanded && <span className="rail-dot inline" aria-hidden="true" />}
      {kbd && <span className="kbd rail-kbd">{kbd}</span>}
    </button>
  )
}

export function NavRail({
  expanded,
  onToggleExpand,
  drawerOpen,
  onCloseDrawer,
  activePlace,
  onBoard,
  onDecisions,
  onThreads,
  onTeam,
  onTodos,
  onCalendar,
  onSchedule,
  onTime,
  onCategories,
  onArchive,
  onSettings,
  systemAlert = false,
}: NavRailProps) {
  const t = useT()
  const { data, now } = useBoardContext()

  // Keep --rail-w in sync on <html> so .page aligns cleanly beside the rail on desktop.
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.style.setProperty('--rail-w', expanded ? '196px' : '52px')
    return () => {
      document.documentElement.style.removeProperty('--rail-w')
    }
  }, [expanded])

  // Escape closes the phone drawer when open.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCloseDrawer()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [drawerOpen, onCloseDrawer])

  const sched = scheduleBadge(data?.schedules ?? [], now)
  const openTasks = data?.todos ? openMine(data.items) : 0
  const toConfirm = data?.todos ? proposedCount(data.items) : 0
  const team = teamBadge(data)
  const decisionsWaiting = data?.decisions?.items.length ?? 0
  const decisionsDefaulted = data?.decisions?.defaulted.length ?? 0
  const threadsNeeds = data?.threads?.needsOwner ?? 0
  const calFailing = (data?.calendar?.failing ?? 0) > 0

  const pick = (fn?: () => void) => () => {
    fn?.()
    if (drawerOpen) onCloseDrawer()
  }

  return (
    <>
      {drawerOpen && <div className="rail-scrim" aria-hidden="true" onClick={onCloseDrawer} />}
      <nav
        className={classNames('nav-rail', expanded && 'expanded', drawerOpen && 'drawer-open')}
        id="nav-rail"
        aria-label={t('nav.navigation')}
        data-expanded={expanded ? '' : undefined}
        data-drawer={drawerOpen ? 'open' : undefined}
      >
        <div className="rail-head">
          <button
            type="button"
            className="rail-item rail-toggle-btn"
            id="rail-expand"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'nav.collapse' : 'nav.expand')}
            title={t(expanded ? 'nav.collapse' : 'nav.expand')}
            onClick={onToggleExpand}
          >
            <span className="rail-icon">
              <SidebarIcon />
            </span>
            <span className="rail-label rail-brand">{t('tb.title')}</span>
          </button>
          <button type="button" className="rail-drawer-close" aria-label={t('nav.closeMenu')} onClick={onCloseDrawer}>
            <CloseIcon />
          </button>
        </div>

        <div className="rail-group">
          <RailItem
            id="nav-board"
            icon={<BoardIcon />}
            label={t('nav.board')}
            active={activePlace === 'board'}
            expanded={expanded || drawerOpen}
            count={data?.items.length ?? 0}
            onClick={pick(onBoard)}
          />
          {onDecisions && data?.decisions && (
            <RailItem
              id="decisions-open"
              icon={<DecisionsIcon />}
              label={t('dec.open')}
              active={activePlace === 'decisions'}
              expanded={expanded || drawerOpen}
              count={decisionsWaiting}
              alert={decisionsWaiting + decisionsDefaulted > 0}
              title={
                decisionsDefaulted > 0
                  ? t('dec.defaultedHint')
                  : decisionsWaiting > 0
                    ? t('dec.needsHint', { n: decisionsWaiting })
                    : t('dec.openHint')
              }
              onClick={pick(onDecisions)}
            />
          )}
          {onThreads && data?.threads && (
            <RailItem
              id="threads-open"
              icon={<ThreadsIcon />}
              label={t('wt.title')}
              active={activePlace === 'threads'}
              expanded={expanded || drawerOpen}
              count={threadsNeeds}
              alert={threadsNeeds > 0}
              title={threadsNeeds > 0 ? t('wt.needsHint', { n: threadsNeeds }) : t('wt.openHint')}
              onClick={pick(onThreads)}
            />
          )}
          {onTeam && (
            <RailItem
              id="team-open"
              icon={<TeamIcon />}
              label={t('team.title')}
              active={activePlace === 'team'}
              expanded={expanded || drawerOpen}
              count={team.count}
              alert={team.count > 0}
              title={
                team.waiting > 0
                  ? t('team.waitingHint', { n: team.waiting })
                  : team.unread > 0
                    ? t('team.unread', { n: team.unread })
                    : t('team.openHint')
              }
              onClick={pick(onTeam)}
            />
          )}
          {data?.todos && (
            <RailItem
              id="todos-open"
              icon={<TasksIcon />}
              label={t('todo.open')}
              active={activePlace === 'todos'}
              expanded={expanded || drawerOpen}
              count={openTasks}
              alert={toConfirm > 0}
              title={t('todo.openHint')}
              onClick={pick(onTodos)}
            />
          )}
        </div>

        <hr className="rail-sep" />

        <div className="rail-group">
          {data?.calendar && (
            <RailItem
              id="calendar-open"
              icon={<CalendarIcon />}
              label={t('cal.open')}
              active={activePlace === 'calendar'}
              expanded={expanded || drawerOpen}
              alert={calFailing}
              title={calFailing ? t('cal.someFailing') : t('cal.openHint')}
              onClick={pick(onCalendar)}
            />
          )}
          <RailItem
            id="sched-open"
            icon={<AlarmIcon />}
            label={t('tb.sched')}
            active={activePlace === 'schedule'}
            expanded={expanded || drawerOpen}
            count={sched.count}
            alert={sched.due}
            title={t('tb.schedTitle')}
            onClick={pick(onSchedule)}
          />
          {data?.time && (
            <RailItem
              id="time-open"
              icon={<TimeIcon />}
              label={t('time.open')}
              active={activePlace === 'time'}
              expanded={expanded || drawerOpen}
              title={t('time.openHint')}
              onClick={pick(onTime)}
            />
          )}
          <RailItem
            id="cats-open"
            icon={<TagIcon />}
            label={t('tb.cats')}
            active={activePlace === 'categories'}
            expanded={expanded || drawerOpen}
            title={t('tb.catsTitle')}
            onClick={pick(onCategories)}
          />
          <RailItem
            id="archive-open"
            icon={<ArchiveIcon />}
            label={t('archive.open')}
            active={activePlace === 'archive'}
            expanded={expanded || drawerOpen}
            title={t('archive.openHint')}
            onClick={pick(onArchive)}
          />
        </div>

        <div className="rail-foot">
          <hr className="rail-sep" />
          <RailItem
            id="settings"
            icon={<GearIcon />}
            label={t('set.title')}
            active={activePlace === 'settings'}
            expanded={expanded || drawerOpen}
            alert={systemAlert}
            kbd=","
            title={t('set.hint')}
            onClick={pick(onSettings)}
          />
        </div>
      </nav>
    </>
  )
}
