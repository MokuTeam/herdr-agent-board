// The Hybrid B+C header (#651):
// - Row 1 (46px desktop / 48px phone): search, quiet Profile & Device dropdowns, promoted imminent
//   call chip, Away journal trigger, composite Status & Usage readout, Next (N), primary + New (Shift+N).
//   On phone, a menu button at the left opens the navigation rail drawer.
// - Row 2 (36px): flat typographic lane tabs (1 click per lane, +N more overflow on desktop, horizontal
//   scroll strip on phone) + quiet board summary at far right on wide desktop. Folds smoothly on scroll
//   (useToolbarCollapse + useCollapse), surfacing a compact restore button (#toolbar-peek) in Row 1.
// - Below Row 2: connection banner, optional workdesk line, and the 5 column heads.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useBoardView } from '../hooks/useBoardView.ts'
import { useCollapse } from '../hooks/useCollapse.ts'
import { useColumnWidths } from '../hooks/useColumnWidths.ts'
import { useScrolled } from '../hooks/useScrolled.ts'
import type { SegmentPicks } from '../hooks/useSegmentPicks.ts'
import type { SettingsMenu } from '../hooks/useSettingsMenu.ts'
import type { SetupNoteState } from '../hooks/useSetupNote.ts'
import { useToolbarCollapse } from '../hooks/useToolbarCollapse.ts'
import type { ToolbarMenu } from '../hooks/useToolbarMore.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { deviceOptions, pickedDevice } from '../models/devices.ts'
import { litLanes } from '../models/lane-picks.ts'
import { pickedProfile, profileOptions } from '../models/profiles.ts'
import { adminHere } from '../models/remote-page.ts'
import { columnHeads, documentTitle, laneOptions, summaryParts } from '../models/toolbar.ts'
import { filterCount, filterText } from '../models/toolbar-collapse.ts'
import { isWakeView, noteShown } from '../models/wake.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { ColumnsHead } from './ColumnsHead.tsx'
import { CalendarButton } from './calendar/CalendarButton.tsx'
import { classNames } from './class-names.ts'
import { DeviceSwitch } from './devices/DeviceSwitch.tsx'
import { NodeMasterBanner } from './devices/NodeMasterBanner.tsx'
import { CloseIcon, FilterIcon, JournalIcon, MenuIcon, PlusIcon, SearchIcon } from './icons.tsx'
import { Lanes } from './Lanes.tsx'
import { NextAttention } from './NextAttention.tsx'
import { ProfileSwitch } from './ProfileSwitch.tsx'
import { StatusControl } from './StatusControl.tsx'
import { Summary } from './Summary.tsx'

export interface ToolbarProps {
  /** The status/usage button, which the popover is placed under and gives focus back to. */
  limitsAnchor: RefObject<HTMLButtonElement | null>
  onNewSession?: (from: HTMLElement) => void
  onCategories?: () => void
  onSchedule?: () => void
  onArchive?: () => void
  setup?: SetupNoteState
  onBackup?: (() => void) | undefined
  onWake?: () => void
  settings?: SettingsMenu
  picks?: SegmentPicks
  more?: ToolbarMenu
  onTodos?: () => void
  onTime?: () => void
  onTeam?: () => void
  onThreads?: () => void
  onDecisions?: () => void
  onCalendar?: () => void
  journal?: { label: string; open: boolean; onToggle: () => void }
  /** Phone drawer toggle for the left navigation rail. */
  onOpenDrawer?: () => void
  /** True when any Place or system alert needs attention (dot on phone drawer button). */
  railAlert?: boolean
}

function focusFilters(container: HTMLElement | null): void {
  const first = ['#lanes button:not([hidden])', '#lanes-pick', '#search']
    .map(selector => container?.querySelector<HTMLElement>(selector))
    .find(el => !!el)
  first?.focus()
}

export function Toolbar({
  limitsAnchor,
  onNewSession,
  setup,
  onWake,
  picks,
  onCalendar,
  journal,
  onOpenDrawer,
  railAlert = false,
}: ToolbarProps) {
  const t = useT()
  const { data, ui, dispatch, canMutate, canEdit, now } = useBoardContext()
  const { visible, categoryOf, anyProfile, anyDevice, lanes: categories } = useBoardView()
  const lanes = data && laneOptions(categories, visible, ui.filter, categoryOf, t)
  const profiles = data && profileOptions(data.profiles, anyProfile, t)
  const profile = pickedProfile(ui.profile, data?.profiles)
  const devices = data && deviceOptions(data.devices, anyDevice, t)
  const device = pickedDevice(ui.device ?? 'all', data?.devices)

  const fit = useRef<HTMLDivElement>(null)
  const filters = useRef<HTMLDivElement>(null)
  const [phoneSearchOpen, setPhoneSearchOpen] = useState(false)
  const scrolled = useScrolled()
  const collapse = useToolbarCollapse(filters, true)
  useCollapse(filters, collapse.collapsed)
  const parts = data && summaryParts(data.items, t)
  const heads = data ? columnHeads(data.columns, visible, ui.filter, categoryOf, t, ui.moves) : []
  useColumnWidths(heads)

  useEffect(() => {
    if (data) document.title = documentTitle(data.items)
  }, [data])

  // Anchor SetupPop under the Status button when setup warnings exist.
  const noteRef = setup?.noteRef
  useLayoutEffect(() => {
    if (noteRef) noteRef.current = limitsAnchor.current
  })

  const wakeDown = adminHere() && noteShown(isWakeView(data?.wake) ? data.wake : undefined, now) && !!onWake
  const alertCount = (setup?.shown ? 1 : 0) + (data?.backup?.problem ? 1 : 0) + (wakeDown ? 1 : 0)

  const activeLaneOptions = ui.filter.length ? (lanes ?? []).filter(l => litLanes(ui.filter).includes(l.id)) : []
  const filtersOn = {
    lanes: activeLaneOptions.map(l => l.title),
    profile: profile === 'all' ? null : (profiles?.find(p => p.id === profile)?.title ?? null),
    query: ui.query.trim(),
    ...(device !== 'all' && { device: devices?.find(d => d.id === device)?.title ?? null }),
  }
  const activeCount = filterCount(filtersOn)
  const filterLabel = filterText(filtersOn)
  const peek = filterLabel ? t('tb.filtersOn', { text: filterLabel }) : t('tb.filters')
  const firstActiveLane = activeLaneOptions[0]

  return (
    <header className={classNames('toolbar', scrolled && 'scrolled', collapse.collapsed && 'folded')}>
      <div className="toolbar-fit" ref={fit}>
        <h1 className="sr-only">{t('tb.title')}</h1>

        {/* Row 1: Slim command bar (46px desktop, 48px phone) */}
        <div className={classNames('tb-top', phoneSearchOpen && 'phone-search-open')}>
          <div className="tb-left">
            {onOpenDrawer && (
              <button
                type="button"
                className="tb-btn tb-icon tb-menu-btn"
                id="rail-toggle"
                aria-label={t('nav.openMenu')}
                title={t('nav.openMenu')}
                onClick={onOpenDrawer}
              >
                <MenuIcon />
                {railAlert && <span className="tb-menu-dot" aria-hidden="true" />}
              </button>
            )}

            <button
              type="button"
              className={classNames('tb-btn tb-peek', activeCount > 0 && 'on')}
              id="toolbar-peek"
              hidden={!collapse.collapsed}
              aria-expanded={!collapse.collapsed}
              aria-controls="toolbar-filters"
              title={peek}
              aria-label={peek}
              onClick={e => {
                collapse.open()
                if (e.detail === 0) requestAnimationFrame(() => focusFilters(fit.current))
              }}
            >
              <FilterIcon />
              {firstActiveLane ? (
                <>
                  {firstActiveLane.color && (
                    <span className="lane-dot" style={{ '--lane': firstActiveLane.color }} aria-hidden="true" />
                  )}
                  <span className="tb-peek-text">
                    {activeLaneOptions.length > 1
                      ? `${firstActiveLane.title} +${activeLaneOptions.length - 1}`
                      : firstActiveLane.title}
                  </span>
                </>
              ) : (
                <span className="n">{activeCount || ''}</span>
              )}
            </button>

            <button
              type="button"
              className="tb-btn tb-icon tb-phone-search-toggle"
              aria-label={t('tb.search')}
              aria-expanded={phoneSearchOpen}
              onClick={() => {
                setPhoneSearchOpen(was => !was)
                requestAnimationFrame(() => document.getElementById('search')?.focus())
              }}
            >
              <SearchIcon />
            </button>

            <label className="search tb-search">
              <SearchIcon />
              <input
                id="search"
                type="search"
                placeholder={t('tb.searchPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                value={ui.query}
                onChange={e => dispatch({ type: 'query', text: e.currentTarget.value })}
              />
              {ui.query ? (
                <button
                  type="button"
                  className="search-clear"
                  aria-label={t('sheet.closeLabel')}
                  onClick={() => dispatch({ type: 'query', text: '' })}
                >
                  <CloseIcon />
                </button>
              ) : (
                <span className="kbd search-kbd" aria-hidden="true">
                  /
                </span>
              )}
            </label>

            {profiles && (
              <div className="tb-pick">
                <ProfileSwitch
                  options={profiles}
                  picked={profile}
                  onPick={id => dispatch({ type: 'profile', id })}
                  folded
                  picks={picks}
                />
              </div>
            )}
            {devices && (
              <div className="tb-pick">
                <DeviceSwitch
                  options={devices}
                  picked={device}
                  onPick={id => dispatch({ type: 'device', id })}
                  folded
                  picks={picks}
                />
              </div>
            )}
          </div>

          <div className="tb-right">
            {data?.calendar && <CalendarButton onOpen={() => onCalendar?.()} onlySoon />}
            {journal && (
              <button
                type="button"
                className={classNames('tb-btn journal-open', journal.open && 'on')}
                id="journal-open"
                aria-expanded={journal.open}
                aria-controls={journal.open ? 'away-strip' : undefined}
                title={t('journal.buttonHint')}
                onClick={() => journal.onToggle()}
              >
                <JournalIcon />
                <span>{journal.label}</span>
              </button>
            )}
            <StatusControl anchor={limitsAnchor} alerts={alertCount} />
            <div className="tb-sep" aria-hidden="true" />
            <NextAttention />
            <button
              type="button"
              className="tb-btn tb-primary new-session"
              id="new-session"
              disabled={!canMutate}
              title={t(canMutate ? 'launch.toolbarHint' : 'mobile.readOnly')}
              onClick={e => onNewSession?.(e.currentTarget)}
            >
              <PlusIcon />
              <span>{t('tb.newShort')}</span>
            </button>
          </div>
        </div>

        {/* Row 2: Flat typographic lane strip (36px, folds smoothly on scroll) */}
        <div
          className="toolbar-filters"
          id="toolbar-filters"
          ref={filters}
          data-picks={1 + (profiles ? 1 : 0) + (devices ? 1 : 0)}
          data-folded={collapse.collapsed ? '' : undefined}
        >
          <Lanes options={lanes} picked={ui.filter} onPick={id => dispatch({ type: 'toggleLane', id })} picks={picks} />
          <Summary parts={parts} />
        </div>
      </div>

      <p id="connection-state" role="status" hidden={canMutate}>
        {t(canEdit ? 'mobile.readOnly' : 'live.off')}
      </p>
      <NodeMasterBanner />
      {data?.workdesk && (
        <p className="workdesk-status" role="status">
          {t('workdesk.status', {
            queue: data.workdesk.queue ?? '-',
            time:
              data.workdesk.polledAt === null
                ? '-'
                : new Date(data.workdesk.polledAt).toLocaleTimeString(t.lang, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hourCycle: 'h23',
                  }),
          })}
          {data.workdesk.problem && <> · {t(`workdesk.problem.${data.workdesk.problem}`)}</>}
        </p>
      )}
      <ColumnsHead heads={heads} only={ui.column} />
    </header>
  )
}
