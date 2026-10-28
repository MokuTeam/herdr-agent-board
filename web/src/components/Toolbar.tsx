// The toolbar, one compact row: the title with the board's summary under it while the row has
// room (else in the title's tooltip), the lanes control, the profile switch (two or more profiles
// shown), search, categories, the schedule and the archive as small buttons named by their tooltips, Settings
// (the gear), the presence switch while presence is on (#172), "Wake stopped" beside "Setup incomplete" when it is so, the usage pill and the live
// dot; the read-only banner and the column heads under it. A narrower window takes two rows, a
// phone three (the stylesheet). The lanes control and the
// profile switch each fold into a pill where the row has no room for all of their segments
// (hooks/useSegmentFolds.ts). The icon-only buttons' labels carry their text keys (`data-i18n`,
// as upstream's page wrote them): the stylesheet hides a label beside its icon by that, leaving
// it the button's name.

import { type RefObject, useEffect, useRef } from 'react'
import { useBoardView } from '../hooks/useBoardView.ts'
import { useColumnWidths } from '../hooks/useColumnWidths.ts'
import { useScrolled } from '../hooks/useScrolled.ts'
import { useSegmentFolds } from '../hooks/useSegmentFolds.ts'
import type { SegmentPicks } from '../hooks/useSegmentPicks.ts'
import type { SettingsMenu } from '../hooks/useSettingsMenu.ts'
import type { SetupNoteState } from '../hooks/useSetupNote.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { pickedProfile, profileOptions } from '../models/profiles.ts'
import { openMine } from '../models/todos.ts'
import { columnHeads, documentTitle, laneOptions, scheduleBadge, summaryParts, summaryText } from '../models/toolbar.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { BackupNote } from './BackupNote.tsx'
import { ColumnsHead } from './ColumnsHead.tsx'
import { AlarmIcon, ArchiveIcon, GearIcon, PlusIcon, SearchIcon, TagIcon, TasksIcon } from './icons.tsx'
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
  /** Tasks (#202): their panel opens and closes; the button shows while the board has them on. */
  onTodos?: () => void
}

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
  onTodos,
}: ToolbarProps) {
  const t = useT()
  const { data, ui, dispatch, canMutate, canEdit, now } = useBoardContext()
  const { visible, categoryOf, anyProfile } = useBoardView()
  const lanes = data && laneOptions(data.categories, visible, ui.filter, categoryOf, t)
  const profiles = data && profileOptions(data.profiles, anyProfile, t)
  const profile = pickedProfile(ui.profile, data?.profiles)
  const row = useRef<HTMLDivElement>(null)
  const folded = useSegmentFolds(row, JSON.stringify([lanes, ui.filter, profiles, profile]))
  const scrolled = useScrolled()
  const badge = scheduleBadge(data?.schedules ?? [], now)
  const parts = data && summaryParts(data.items, t)
  const heads = data ? columnHeads(data.columns, visible, ui.filter, categoryOf, t, ui.moves) : []
  useColumnWidths(heads)

  useEffect(() => {
    if (data) document.title = documentTitle(data.items)
  }, [data])

  return (
    <header className={scrolled ? 'toolbar scrolled' : 'toolbar'}>
      {/* The row's own width: the page's, less a side panel lying over the board (--over-*). */}
      <div className="toolbar-fit">
        <div className="toolbar-row" ref={row}>
          {/* The summary hides in a narrower toolbar: its words are the title's tooltip too. */}
          <div className="titles" title={parts ? summaryText(parts) : undefined}>
            <h1>{t('tb.title')}</h1>
            <Summary parts={parts} />
          </div>
          <div className="controls">
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
                <span className="n">{openMine(data.items) || ''}</span>
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
            <NextAttention />
            <PresenceSwitch />
            {setup && <SetupNote setup={setup} />}
            <BackupNote onOpen={onBackup} />
            {onWake && <WakeNote onOpen={onWake} />}
            <Limits anchor={limitsAnchor} />
            <LiveDot />
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
