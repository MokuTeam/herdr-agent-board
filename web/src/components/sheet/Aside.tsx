// Side questions in the session panel (hooks/useAside.ts): the switch in the message box that
// sends the next question aside, and the answers in cards over the box, newest nearest to it.
// A card says what was asked, the answer (or that it is on its way, or why there is none), and
// that it went as a request of its own, with its price and its context; closing it forgets it.
// Nothing of it goes into the session's conversation.
import { type ReactNode, useContext, useLayoutEffect, useRef, useState } from 'react'
import { type Aside, type AsideControls, useAside } from '../../hooks/useAside.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { asideQuestion, dollars, kilo } from '../../models/aside.ts'
import { markdown } from '../../models/markdown.ts'
import { BoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'

/** What the message box does about side questions (components/sheet/Composer.tsx). */
export interface AsideBox {
  /** The board can ask the open session aside (a Claude session, Claude Code on its PATH). */
  can: boolean
  /** The switch is on. */
  on: boolean
  /** The side question the box holds ('' while empty), or null: the text is a message to the session. */
  question: string | null
  toggle(): void
  /** Send the box's side question, if it holds one; false: it holds a message for the session. */
  submit(): boolean
  /** The answers for the open session. */
  deck: ReactNode
}

/**
 * The open session's side questions, for the message box (`text` and `setText` are its own): its
 * switch, what it would send aside, and the cards. Off where the board cannot ask aside, so the
 * box is as it was there.
 */
export function useAsideBox(text: string, setText: (text: string) => void): AsideBox {
  const board = useContext(BoardContext)
  const controls = useAside()
  const key = board?.ui.open ?? null
  const it = key ? board?.data?.items.find(i => i.key === key) : undefined
  const can = !!key && !!board?.data?.aside && !!it?.session && it.agent === 'claude'
  const [on, setOn] = useState(false)
  // Another session in the panel: its box starts as a message box.
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setOn(false)
  }
  const question = can ? asideQuestion(text, on) : null
  const list = controls.of(key)
  return {
    can,
    on: can && on,
    question,
    toggle: () => setOn(was => !was),
    submit() {
      if (question === null) return false
      if (question && key) {
        void controls.ask(key, question)
        setText('')
        setOn(false)
      }
      return true
    },
    deck: key && list.length ? <AsideDeck sessionKey={key} list={list} controls={controls} /> : null,
  }
}

/** A speech bubble with a question in it, set to one side. */
export const AsideIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H10l-3.5 2.5V14h-2A1.5 1.5 0 0 1 3 12.5V6a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M8.6 7.7a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9v.2M10 11.9v.1" />
  </svg>
)

/** The message box's switch: the next message goes aside. */
export function AsideToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const t = useT()
  return (
    <button
      type="button"
      className={classNames('aside-toggle', on && 'on')}
      id="aside-toggle"
      aria-pressed={on}
      title={t('aside.toggleHint')}
      aria-label={t('aside.toggle')}
      onClick={onToggle}
    >
      <AsideIcon />
    </button>
  )
}

/** The side questions asked of the session `sessionKey`, oldest first. */
export function AsideDeck({
  sessionKey,
  list,
  controls,
}: {
  sessionKey: string
  list: readonly Aside[]
  controls: Pick<AsideControls, 'close' | 'again'>
}) {
  const deck = useRef<HTMLElement>(null)
  const last = list.at(-1)
  // A new one, or one answered: the newest in sight, by the box.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new question or its answer is when to look
  useLayoutEffect(() => {
    const el = deck.current
    if (el) el.scrollTop = el.scrollHeight
  }, [last?.id, last?.state])
  if (!list.length) return null
  return (
    <section className="aside-deck" ref={deck}>
      {list.map(a => (
        <AsideCard
          key={a.id}
          aside={a}
          onClose={() => controls.close(sessionKey, a.id)}
          onAgain={() => controls.again(sessionKey, a.id)}
        />
      ))}
    </section>
  )
}

function AsideCard({ aside: a, onClose, onAgain }: { aside: Aside; onClose: () => void; onAgain: () => void }) {
  const t = useT()
  const asking = a.state === 'asking'
  const meta = [
    a.costUsd === null ? t('aside.costNone') : t('aside.cost', { cost: `$${dollars(a.costUsd)}` }),
    a.tokens?.context ? t('aside.tokens', { n: kilo(a.tokens.context) }) : '',
    a.tokens?.cached ? t('aside.cached', { n: kilo(a.tokens.cached) }) : '',
    a.ms ? t('aside.seconds', { s: Math.max(1, Math.round(a.ms / 1000)) }) : '',
  ].filter(Boolean)
  return (
    <article className="aside-card" data-state={a.state} aria-busy={asking}>
      <header className="aside-head">
        <span className="aside-glyph">
          <AsideIcon />
        </span>
        <span className="aside-label">{t('aside.label')}</span>
        <span className="aside-q" title={a.question}>
          {a.question}
        </span>
        <button
          type="button"
          className="aside-close"
          title={t(asking ? 'aside.cancel' : 'aside.close')}
          aria-label={t(asking ? 'aside.cancel' : 'aside.close')}
          onClick={onClose}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 6 8 8M14 6l-8 8" />
          </svg>
        </button>
      </header>
      {asking && (
        <p className="aside-wait" role="status">
          {t('aside.asking')}
        </p>
      )}
      {a.state === 'answered' && (
        <>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags */}
          <div className="md aside-answer" dangerouslySetInnerHTML={{ __html: markdown(a.text) }} />
          <footer className="aside-meta" title={t('aside.costHint')}>
            {meta.join(' · ')}
          </footer>
        </>
      )}
      {a.state === 'failed' && (
        <p className="aside-error" role="alert">
          <span>{a.error}</span>
          <button type="button" className="aside-again" onClick={onAgain}>
            {t('aside.again')}
          </button>
        </p>
      )}
    </article>
  )
}
