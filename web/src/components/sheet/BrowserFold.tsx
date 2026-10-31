// An agent's own browser in the session panel: a "Browser" fold above the conversation, only while
// the session's browser runs (the payload's `desktop`), so what the agent writes and what it does
// are seen together. Folded, nothing is shown and nothing streams; open, its display comes over the
// board (hooks/useDesktop.ts). One button shows it full size over the whole board, Esc or × brings
// it back, and × on the fold closes it. It is only watched until "Take control": then the mouse
// and keys go to it while the agent's own actions wait, with a plain warning that the agent sees
// what is typed there; "Give back", or leaving the view, hands it back. What the agent asks the
// owner to do there (browser_ask_owner) is said at the browser itself, folded or open, and full
// size, while it asks.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Item } from '../../../../src/core/types.ts'
import { errorText } from '../../api/client.ts'
import { type DesktopControl, setDesktopControl } from '../../api/desktop.ts'
import { useDesktop } from '../../hooks/useDesktop.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { ChevGlyph, CloseGlyph, ExpandGlyph } from '../icons.tsx'

export interface BrowserFoldProps {
  item: Item
  /** The fold is open (an opening from the card's mark opens it: the board's `browser`). */
  open: boolean
  onOpen(open: boolean): void
}

export function BrowserFold({ item, open, onOpen }: BrowserFoldProps) {
  const t = useT()
  const { canMutate, toast } = useBoardContext()
  const desktop = item.desktop
  const running = !!desktop?.running
  const on = open && running
  // The board's answer to a hand-over holds until the payload moves on from what it said before;
  // then the payload's word is the board's (it may have handed it back since: a view gone, a restart).
  const [said, setSaid] = useState<{ from: DesktopControl; to: DesktopControl } | null>(null)
  const boardSays = desktop?.control ?? 'agent'
  const control = said?.from === boardSays ? said.to : boardSays
  useEffect(() => {
    if (said && said.from !== boardSays) setSaid(null)
  }, [said, boardSays])
  const owner = control === 'owner'
  const [asking, setAsking] = useState(false)
  const [full, setFull] = useState(false)
  const view = useDesktop(item.key, on, owner)
  const [foldHost, setFoldHost] = useState<HTMLElement | null>(null)
  const [fullHost, setFullHost] = useState<HTMLElement | null>(null)

  // The picture where it shows: in the fold, or full size.
  useLayoutEffect(() => {
    const host = full ? fullHost : foldHost
    if (host && view.canvas && view.canvas.parentNode !== host) host.appendChild(view.canvas)
  }, [view.canvas, full, foldHost, fullHost])
  // Folded, or the panel closed: full size goes too.
  useEffect(() => {
    if (!on) setFull(false)
  }, [on])
  // Esc brings full size back, before the panel, the board or the display hear it.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setFull(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [full])
  // Control taken here and the view left: given back, so the agent's browser does not wait on no one.
  const took = useRef(false)
  const key = item.key
  useEffect(() => {
    if (!on) return
    return () => {
      if (!took.current) return
      took.current = false
      void setDesktopControl(key, 'agent').catch(() => {})
    }
  }, [on, key])

  if (!desktop || !running) return null

  async function hand(to: DesktopControl, from: DesktopControl): Promise<void> {
    setAsking(true)
    try {
      const now = await setDesktopControl(key, to)
      took.current = now === 'owner'
      setSaid({ from, to: now })
      if (now === 'owner') view.canvas?.focus()
    } catch (err) {
      toast(errorText(err, t), true)
    } finally {
      setAsking(false)
    }
  }

  const tools = (where: 'fold' | 'full') => (
    <div className="desk-tools">
      <span className={classNames('desk-who', owner && 'you')}>{t(owner ? 'desk.you' : 'desk.agent')}</span>
      <button
        type="button"
        className="button"
        data-desk="control"
        title={owner ? undefined : t('desk.takeHint')}
        disabled={asking || !canMutate || (!owner && view.state !== 'live')}
        onClick={() => void hand(owner ? 'agent' : 'owner', desktop.control)}
      >
        {t(owner ? 'desk.give' : 'desk.take')}
      </button>
      {where === 'fold' && (
        <button
          type="button"
          className="icon-button desk-tool"
          data-desk="full"
          title={t('desk.full')}
          aria-label={t('desk.full')}
          onClick={() => setFull(true)}
        >
          <ExpandGlyph />
        </button>
      )}
      <button
        type="button"
        className="icon-button desk-tool"
        data-desk="close"
        title={t(where === 'fold' ? 'desk.close' : 'desk.back')}
        aria-label={t(where === 'fold' ? 'desk.close' : 'desk.back')}
        onClick={() => (where === 'fold' ? onOpen(false) : setFull(false))}
      >
        <CloseGlyph />
      </button>
    </div>
  )
  const status = view.state === 'connecting' ? t('desk.connecting') : view.why
  const again = (view.state === 'closed' || view.state === 'failed') && (
    <button type="button" className="button" data-desk="retry" onClick={view.retry}>
      {t('detail.retry')}
    </button>
  )
  const warn = owner && (
    <p className="desk-warn" role="note">
      {t('desk.warn')}
    </p>
  )
  // The board's word while the ask stands (the agent working on or not); a board before it said
  // the card's question while the card asks.
  const asked = desktop.ask || (desktop.asks ? item.question : '')
  const asks = asked ? (
    <p className="desk-asks" role="status">
      <b>{t('desk.asks')}:</b> {asked}
    </p>
  ) : null
  return (
    <section className={classNames('desk', open && 'open', owner && 'owner')} aria-label={t('desk.title')}>
      <div className="desk-bar">
        <button type="button" className="desk-fold" data-desk="fold" aria-expanded={open} onClick={() => onOpen(!open)}>
          <ChevGlyph />
          <span>{t('desk.title')}</span>
          {desktop.profile && <span className="desk-profile">{desktop.profile}</span>}
        </button>
        {open && tools('fold')}
      </div>
      {asks}
      {open && (
        <>
          {warn}
          <div className="desk-view">
            {(full || status) && (
              <p className="desk-status" role="status">
                {full ? t('desk.shownFull') : status}
                {!full && again}
              </p>
            )}
            <div className="desk-host" ref={setFoldHost} />
          </div>
        </>
      )}
      {full &&
        createPortal(
          <div
            className={classNames('desk-full', owner && 'owner')}
            role="dialog"
            aria-modal="true"
            aria-label={`${t('desk.title')} · ${item.name}`}
          >
            <div className="desk-bar">
              <span className="desk-name">
                {t('desk.title')} · {item.name}
              </span>
              {tools('full')}
            </div>
            {asks}
            {warn}
            <div className="desk-view">
              {status && (
                <p className="desk-status" role="status">
                  {status}
                  {again}
                </p>
              )}
              <div className="desk-host" ref={setFullHost} />
            </div>
          </div>,
          document.body,
        )}
    </section>
  )
}
