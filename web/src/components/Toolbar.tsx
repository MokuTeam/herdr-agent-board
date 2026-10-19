// The toolbar, one compact row: the title with the board's summary under it while the row has
// room (else in the title's tooltip), the lanes control, the profile switch (two or more profiles
// shown), search, categories and the schedule as small buttons named by their tooltips, Settings
// (the gear), the usage pill and the live dot; the read-only banner and the column heads under
// it. A narrower window takes two rows, a phone three (the stylesheet). The icon-only buttons'
// labels carry their text keys (`data-i18n`, as upstream's page wrote them): the stylesheet hides
// a label beside its icon by that, leaving it the button's name.
import { type RefObject, useEffect } from 'react'
import { useBoardView } from '../hooks/useBoardView.ts'
import { useColumnWidths } from '../hooks/useColumnWidths.ts'
import { useScrolled } from '../hooks/useScrolled.ts'
import type { SettingsMenu } from '../hooks/useSettingsMenu.ts'
import type { SetupNoteState } from '../hooks/useSetupNote.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { pickedProfile, profileOptions } from '../models/profiles.ts'
import { columnHeads, documentTitle, laneOptions, scheduleBadge, summaryParts, summaryText } from '../models/toolbar.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { ColumnsHead } from './ColumnsHead.tsx'
import { AlarmIcon, GearIcon, PlusIcon, SearchIcon, TagIcon } from './icons.tsx'
import { Lanes } from './Lanes.tsx'
import { Limits } from './Limits.tsx'
import { LiveDot } from './LiveDot.tsx'
import { NextAttention } from './NextAttention.tsx'
import { ProfileSwitch } from './ProfileSwitch.tsx'
import { SetupNote } from './SetupNote.tsx'
import { Summary } from './Summary.tsx'

export interface ToolbarProps {
  /** The usage pill, which the popover is placed under and gives the focus back to. */
  limitsAnchor: RefObject<HTMLButtonElement | null>
  onNewSession?: (from: HTMLElement) => void
  onCategories?: () => void
  onSchedule?: () => void
  /** The quiet "Setup incomplete" note (hooks/useSetupNote.ts). */
  setup?: SetupNoteState
  /** Settings, the gear's menu (hooks/useSettingsMenu.ts). */
  settings?: SettingsMenu
}

export function Toolbar({ limitsAnchor, onNewSession, onCategories, onSchedule, setup, settings }: ToolbarProps) {
  const t = useT()
  const { data, ui, dispatch, canMutate, canEdit, now } = useBoardContext()
  const { visible, categoryOf, anyProfile } = useBoardView()
  const profiles = data && profileOptions(data.profiles, anyProfile, t)
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
        <div className="toolbar-row">
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
              options={data && laneOptions(data.categories, visible, ui.filter, categoryOf, t)}
              picked={ui.filter}
              onPick={id => dispatch({ type: 'filter', id })}
            />
            {profiles && (
              <ProfileSwitch
                options={profiles}
                picked={pickedProfile(ui.profile, data?.profiles)}
                onPick={id => dispatch({ type: 'profile', id })}
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
            {setup && <SetupNote setup={setup} />}
            <Limits anchor={limitsAnchor} />
            <LiveDot />
          </div>
        </div>
      </div>
      <p id="connection-state" role="status" hidden={canMutate}>
        {t(canEdit ? 'mobile.readOnly' : 'live.off')}
      </p>
      <ColumnsHead heads={heads} />
    </header>
  )
}
