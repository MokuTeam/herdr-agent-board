// The session's helpers above its conversation in the sheet (the old page's app.js
// renderHelpersStrip): the ones at work with what each does now and a running clock, else the
// newest one in a line. A row opens the helper's conversation, "All" the whole list (the helpers
// window, hooks/useHelpers.ts). A redraw keeps the focus on what opens the same thing
// (hooks/useKeepFocus.ts).
import type { MouseEvent, ReactNode } from 'react'
import type { PublicHelper, WorkflowRun } from '../../../../src/core/helpers.ts'
import { useKeepFocus } from '../../hooks/useKeepFocus.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { ago } from '../../models/card.ts'
import { helperTitle } from '../../models/helper-model.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { ChevGlyph } from '../icons.tsx'
import { HelperRow, KindIcon, RunRow, StatusMark } from './HelperRows.tsx'

export interface HelpersStripProps {
  helpers: readonly PublicHelper[]
  workflows: readonly WorkflowRun[]
  /** A helper's conversation, grown from `el`. */
  onHelper(id: string, el: HTMLElement): void
  /** The list, at a workflow run's agents (`run`) or from the top. */
  onList(run: string | null, el: HTMLElement): void
}

export function HelpersStrip({ helpers: list, workflows: runs, onHelper, onList }: HelpersStripProps) {
  const t = useT()
  const keepFocus = useKeepFocus()
  const shown = list.length > 0 || runs.length > 0
  return (
    <section
      className="sheet-helpers"
      id="sheet-helpers"
      aria-labelledby="sheet-helpers-title"
      hidden={!shown}
      {...keepFocus}
    >
      {shown && <Strip helpers={list} workflows={runs} onHelper={onHelper} onList={onList} t={t} />}
    </section>
  )
}

function Strip({
  helpers: list,
  workflows: runs,
  onHelper,
  onList,
  t,
}: HelpersStripProps & { t: ReturnType<typeof useT> }) {
  const { now } = useBoardContext()
  const running = list.filter(h => h.status === 'running')
  const own = running.filter(h => !h.workflow)
  const liveRuns = runs.filter(w => w.status === 'running')
  const done = list.length - running.length
  const sum = [running.length && t('helpers.running', { n: running.length }), done && t('helpers.done', { n: done })]
    .filter(Boolean)
    .join(' · ')
  const more = own.length - 4
  const from = (open: (el: HTMLElement) => void) => (e: MouseEvent<HTMLElement>) => open(e.currentTarget)
  let rows: ReactNode = (
    <>
      {liveRuns.map(w => (
        <RunRow key={`run-${w.id}`} w={w} onOpen={el => onList(w.id, el)} />
      ))}
      {own.slice(0, 4).map(h => (
        <HelperRow key={h.id} h={h} onOpen={el => onHelper(h.id, el)} />
      ))}
      {more > 0 && (
        <button type="button" className="helper-more" data-helpers-all="" onClick={from(el => onList(null, el))}>
          {t('helpers.more', { n: more })}
        </button>
      )}
    </>
  )
  if (!liveRuns.length && !own.length) {
    // The newest of the session's own helpers or workflow runs (not an agent inside a run).
    const last = [...list.filter(h => !h.workflow), ...runs].sort(
      (a, b) => (b.endedAt ?? b.activity ?? 0) - (a.endedAt ?? a.activity ?? 0),
    )[0]
    const helper = last && 'kind' in last ? last : null
    rows = last && (
      <button
        type="button"
        className="helper-last"
        data-helper={helper ? last.id : undefined}
        data-run-open={helper ? undefined : last.id}
        onClick={from(el => (helper ? onHelper(last.id, el) : onList(last.id, el)))}
      >
        <KindIcon kind={helper ? helper.kind : 'workflow'} color={helper?.color} />
        <span>
          {t('helpers.last', {
            title: helper ? helperTitle(helper) : last.name || last.id,
            when: ago(last.endedAt ?? last.activity, now, t),
          })}
        </span>
        <StatusMark status={last.status} />
      </button>
    )
  }
  return (
    <>
      <header className="helpers-head">
        <h3 id="sheet-helpers-title">{t('helpers.title')}</h3>
        <span className="helpers-sum">{sum}</span>
        <button
          type="button"
          className="helpers-all"
          data-helpers-all=""
          title={t('helpers.allHint')}
          onClick={from(el => onList(null, el))}
        >
          {t('helpers.all')}
          <ChevGlyph />
        </button>
      </header>
      <div className="helper-rows">{rows}</div>
    </>
  )
}
