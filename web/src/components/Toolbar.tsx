// The toolbar: title and summary, the lanes control, search, the toggles and panels, the usage
// pill and the live dot, the read-only banner and the column heads.
import { type RefObject, useEffect } from 'react'
import { useBoardView } from '../hooks/useBoardView.ts'
import { useScrolled } from '../hooks/useScrolled.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { columnHeads, documentTitle, laneOptions, scheduleBadge, summaryParts } from '../models/toolbar.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { ColumnsHead } from './ColumnsHead.tsx'
import { AlarmIcon, MoonIcon, PlusIcon, SearchIcon, TagIcon } from './icons.tsx'
import { Lanes } from './Lanes.tsx'
import { LanguageButton } from './LanguageButton.tsx'
import { Limits } from './Limits.tsx'
import { LiveDot } from './LiveDot.tsx'
import { NextAttention } from './NextAttention.tsx'
import { Summary } from './Summary.tsx'

export interface ToolbarProps {
  /** The usage pill, which the popover is placed under and gives the focus back to. */
  limitsAnchor: RefObject<HTMLButtonElement | null>
  onNewSession?: (from: HTMLElement) => void
  onCategories?: () => void
  onSchedule?: () => void
}

export function Toolbar({ limitsAnchor, onNewSession, onCategories, onSchedule }: ToolbarProps) {
  const t = useT()
  const { data, ui, dispatch, canMutate, canEdit, now } = useBoardContext()
  const { visible, categoryOf } = useBoardView()
  const scrolled = useScrolled()
  const badge = scheduleBadge(data?.schedules ?? [], now)

  useEffect(() => {
    if (data) document.title = documentTitle(data.items)
  }, [data])

  return (
    <header className={scrolled ? 'toolbar scrolled' : 'toolbar'}>
      <div className="toolbar-row">
        <div className="titles">
          <h1>{t('tb.title')}</h1>
          <Summary parts={data && summaryParts(data.items, t)} />
        </div>
        <div className="controls">
          {/* New sessions go through herdr: they wait for fresh data like going to a session does. */}
          <button
            type="button"
            className="pill-toggle new-session"
            id="new-session"
            disabled={!canMutate}
            title={t(canMutate ? 'launch.toolbarHint' : 'mobile.readOnly')}
            onClick={e => onNewSession?.(e.currentTarget)}
          >
            <PlusIcon />
            <span>{t('launch.toolbar')}</span>
          </button>
          <Lanes
            options={data && laneOptions(data.categories, visible, ui.filter, categoryOf, t)}
            picked={ui.filter}
            onPick={id => dispatch({ type: 'filter', id })}
          />
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
            className="pill-toggle"
            id="sleepers"
            aria-pressed={ui.sleepers}
            title={t('tb.sleepersTitle')}
            onClick={() => dispatch({ type: 'toggleSleepers' })}
          >
            <MoonIcon />
            <span>{t('tb.sleepers')}</span>
          </button>
          <button
            type="button"
            className="pill-toggle"
            id="cats-open"
            title={t('tb.catsTitle')}
            onClick={() => onCategories?.()}
          >
            <TagIcon />
            <span>{t('tb.cats')}</span>
          </button>
          <button
            type="button"
            className={badge.due ? 'pill-toggle due' : 'pill-toggle'}
            id="sched-open"
            title={t('tb.schedTitle')}
            onClick={() => onSchedule?.()}
          >
            <AlarmIcon />
            <span>{t('tb.sched')}</span>
            <span className="n" id="sched-count">
              {badge.count || ''}
            </span>
          </button>
          <LanguageButton />
          <NextAttention />
          <Limits anchor={limitsAnchor} />
          <LiveDot />
        </div>
      </div>
      <p id="connection-state" role="status" hidden={canMutate}>
        {t(canEdit ? 'mobile.readOnly' : 'live.off')}
      </p>
      <ColumnsHead heads={data ? columnHeads(data.columns, visible, ui.filter, categoryOf, t) : []} />
    </header>
  )
}
