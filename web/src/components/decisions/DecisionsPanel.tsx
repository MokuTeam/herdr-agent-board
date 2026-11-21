// The Decisions panel (#487): one queue of what waits on the owner across lanes, answered right
// there. First what went by default since the panel was last opened (the question and what the
// session went with), kept on show while the panel stays open; then the open questions in the
// queue's order (a running default first, soonest first; then the oldest first), each with its
// session, lane and thread, its options (the recommended one marked), how long it has waited, when
// its default goes and Hold, and a field for the owner's own words. The board's own asks (a secret
// request) are answered in their own form: Open goes to the session. What went by default is seen
// up to the newest one the panel showed (one that went after the page's last board stays unseen).
import { useEffect, useState } from 'react'
import type { DefaultedView } from '../../../../src/core/decisions.ts'
import type { DecisionsUi } from '../../hooks/useDecisions.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { askedText, seenUpTo } from '../../models/decisions.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { MoonGlyph } from '../icons.tsx'
import { Panel } from '../panel/Panel.tsx'
import { DecisionButtons, OwnAnswer } from './DecisionButtons.tsx'

export interface DecisionsPanelProps {
  open: boolean
  onClose(): void
  decisions: DecisionsUi
}

/** `now` with those of `more` it lacks, by id: what went by default stays while the panel is open. */
const merged = (now: readonly DefaultedView[], more: readonly DefaultedView[]): DefaultedView[] => [
  ...now,
  ...more.filter(d => !now.some(x => x.id === d.id)),
]

export function DecisionsPanel({ open, onClose, decisions }: DecisionsPanelProps) {
  const t = useT()
  const { data, now, dispatch } = useBoardContext()
  const queue = data?.decisions
  const items = queue?.items ?? []
  // What went by default when the panel opened, and since: the next board no longer carries it.
  const [went, setWent] = useState<DefaultedView[]>([])
  const defaulted = queue?.defaulted ?? []
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening, with what the board had then
  useEffect(() => {
    if (open) setWent(defaulted)
  }, [open])
  const shown = open ? merged(went, defaulted) : defaulted
  const newest = seenUpTo(shown)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on show, up to what the panel shows
  useEffect(() => {
    if (open && newest > 0) decisions.seen(newest)
  }, [open, newest])
  const goTo = (key: string) => dispatch({ type: 'open', key })
  const laneTitle = (id: string | undefined) => (id ? (data?.categories.find(c => c.id === id)?.title ?? id) : '')
  const itemOf = (key: string) => data?.items.find(i => i.key === key)

  return (
    <Panel
      id="decisions-sheet"
      kind="decisions"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('dec.title')}</h2>
          <p className="sheet-meta">{t('dec.about')}</p>
        </>
      }
    >
      <div className="sheet-body decisions-body">
        {shown.length > 0 && (
          <section className="dec-went">
            <h3 className="dec-section">{t('dec.wentTitle')}</h3>
            {shown.map(d => (
              <div key={d.id} className="dec-row went">
                <div className="dec-who">
                  <button type="button" className="dec-session" onClick={() => goTo(d.key)} title={t('dec.goToHint')}>
                    {d.who}
                  </button>
                </div>
                <p className="dec-q">{d.question}</p>
                <p className="dec-answer">{t('dec.went', { answer: d.answer })}</p>
              </div>
            ))}
          </section>
        )}
        {!items.length && (
          <div className="dec-empty">
            <p>{t('dec.empty')}</p>
          </div>
        )}
        {items.map(d => {
          const item = itemOf(d.key)
          return (
            <div
              key={`${d.key}:${d.id ?? ''}`}
              className={classNames('dec-row', d.defaultAt !== null && !d.held && 'timed')}
            >
              <div className="dec-who">
                <button type="button" className="dec-session" onClick={() => goTo(d.key)} title={t('dec.goToHint')}>
                  {item?.sleeping && <MoonGlyph />}
                  <span>{d.who}</span>
                </button>
                {d.lane && <span className="dec-lane">{laneTitle(d.lane)}</span>}
                {d.thread && <span className="dec-thread">{t('dec.thread', { key: d.thread })}</span>}
                <span className="dec-age">{askedText(d.askedAt, now, t)}</span>
              </div>
              <p className="dec-q">{d.question}</p>
              {d.board ? (
                <div className="dec-board">
                  <span className="hint">{t('dec.boardAsk')}</span>
                  <button type="button" className="mini" onClick={() => goTo(d.key)} title={t('dec.goToHint')}>
                    {t('dec.goTo')}
                  </button>
                </div>
              ) : (
                <>
                  {d.id && (
                    <DecisionButtons
                      decisions={decisions}
                      choice={{
                        sessionKey: d.key,
                        id: d.id,
                        options: d.options,
                        recommend: d.recommend,
                        defaultAt: d.defaultAt,
                        held: d.held,
                      }}
                    />
                  )}
                  <OwnAnswer
                    onSend={text => {
                      if (d.id) return decisions.answer(d.key, d.id, { text })
                      return item ? decisions.message(item, text) : Promise.resolve(false)
                    }}
                  />
                </>
              )}
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
