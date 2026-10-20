// The terminal window over the board (the old page's terminal.js root): its head with the
// session's name, its folder or "the session's own terminal", the switch between the two
// terminals and "Open in herdr"; the dark screen with what it says when there is nothing to show
// and a paste that asks first; the phone's row of keys; and the footer with what the keys do and
// "Close the shell". It lives in <body> itself, beside the page (hooks/useModalFocus.ts); its
// motion, stream, rows and keys are hooks/useTerminal.ts's.
import { type MouseEvent, type PointerEvent, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import type { Item } from '../../../../src/core/types.ts'
import { useMediaQuery } from '../../hooks/useMediaQuery.ts'
import type { TerminalEngine, TermRefs, TermView } from '../../hooks/useTerminal.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { PHONE_QUERY } from '../../models/panel-motion.ts'
import { agentName, footStatus, KEY_ROW, type StatePanel, statePanel, type TermTarget } from '../../models/terminal.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { useStore } from '../../state/store.ts'
import { classNames } from '../class-names.ts'
import { Turn } from '../icons.tsx'

/** The terminal's icon: a window with a prompt (the sheet's Terminal button has it too). */
export const TermIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.6" />
    <path d="m6 8.2 2.6 2.1L6 12.4M10.4 12.6h3.6" />
  </svg>
)
const HerdrIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M7 4.5h8.5V13M15 5 5 15" />
  </svg>
)
const CloseIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m5.5 5.5 9 9m0-9-9 9" />
  </svg>
)
const Spin = () => (
  <Turn spinning>
    <svg className="spin" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3a7 7 0 1 1-7 7" />
    </svg>
  </Turn>
)

export interface TermHandlers {
  /** The dimmed board or the close button. */
  close(): void
  pickTarget(target: TermTarget): void
  toHerdr(): void
  closeShell(): void
  clickScreen(e: { target: unknown; preventDefault(): void }): void
  stateDo(what: 'start' | 'retry' | 'wake'): void
  settlePaste(yes: boolean): void
  sendKey(key: string): void
}

export interface TerminalViewProps {
  view: TermView
  /** The session on show (none: it left the board). */
  item: Item | null
  canMutate: boolean
  /** The board has a shell open for the session. */
  hasShell: boolean
  /** The pointer is a finger. */
  coarse: boolean
  /** A phone's width. */
  narrow: boolean
  refs?: Partial<TermRefs>
  on?: Partial<TermHandlers>
}

/** What the screen says when there is nothing (yet) to show, with the button that goes on from there. */
function StateView({
  panel,
  canMutate,
  onDo,
}: {
  panel: StatePanel
  canMutate: boolean
  onDo?: ((what: 'start' | 'retry' | 'wake') => void) | undefined
}) {
  const t = useT()
  const primary = (what: 'start' | 'wake', text: string) => (
    <button type="button" className="button primary" data-do={what} disabled={!canMutate} onClick={() => onDo?.(what)}>
      {text}
    </button>
  )
  switch (panel.kind) {
    case 'connecting':
      return (
        <p>
          <Spin />
          {t('term.connecting')}
        </p>
      )
    case 'starting':
      return (
        <p>
          <Spin />
          {t('term.starting', { path: panel.path })}
        </p>
      )
    case 'none':
      return (
        <>
          <p>{t('term.noShell', { path: panel.path })}</p>
          {primary('start', t('term.start'))}
          {!canMutate && <small>{t('mobile.readOnly')}</small>}
        </>
      )
    case 'missing':
      return <p>{t('term.missing')}</p>
    case 'gone':
      return (
        <>
          <p>{t('term.gone')}</p>
          {primary('start', t('term.reopen'))}
        </>
      )
    case 'goneAgent':
      return <p>{t('term.goneAgent')}</p>
    case 'asleep':
      return (
        <>
          <p>{t('term.asleep', { name: panel.name })}</p>
          {primary('wake', t('sheet.wake'))}
        </>
      )
    case 'error':
      return (
        <>
          <p>{panel.text}</p>
          <button type="button" className="button" data-do="retry" onClick={() => onDo?.('retry')}>
            {t('term.retry')}
          </button>
        </>
      )
  }
}

export function TerminalView({
  view,
  item,
  canMutate,
  hasShell,
  coarse,
  narrow,
  refs = {},
  on = {},
}: TerminalViewProps) {
  const t = useT()
  const shell = view.target === 'shell'
  const live = view.status === 'live'
  const canInput = canMutate && live && !!item && !(view.target === 'agent' && item.sleeping)
  const panel = statePanel(view, item, t)
  const foot = footStatus({ ...view, canMutate, coarse }, item, t)
  const cwd = item?.cwd ?? ''
  const label = (key: string) => ({ title: t(key), 'aria-label': t(key) })
  const target = (which: TermTarget, text: string) => {
    const pressed = view.target === which
    return (
      // biome-ignore lint/a11y/useSemanticElements: the switch's two buttons say both, as the old page's (and the quick look's mode switch) did
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: as above
      <button
        type="button"
        data-target={which}
        role="radio"
        aria-pressed={pressed}
        aria-checked={pressed}
        disabled={which === 'agent' ? !item?.pane : !item?.cwd}
        onClick={() => on.pickTarget?.(which)}
      >
        {text}
      </button>
    )
  }
  const onKeyRowDown = (e: PointerEvent<HTMLDivElement>) => {
    // A key of the row must not take the focus from the field: the phone's keyboard stays up.
    if (e.target instanceof Element && e.target.closest('button')) e.preventDefault()
  }
  const onScreenClick = (e: MouseEvent<HTMLDivElement>) =>
    on.clickScreen?.({ target: e.target, preventDefault: () => e.preventDefault() })
  return (
    <div className="ql term" hidden={view.hidden} ref={refs.layer}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the dimmed board around it closes it with a click; Esc does with keys */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
      <div className="ql-scrim" ref={refs.scrim} onClick={() => on.close?.()} />
      <section
        className={classNames('ql-win term-win', canInput && 'can-type')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="term-name"
        tabIndex={-1}
        ref={refs.win}
      >
        <header className="ql-head term-head">
          <span className="ql-icon">
            <TermIcon />
          </span>
          <div className="ql-titles">
            <h3 id="term-name">{view.label?.name ?? ''}</h3>
            <p className="term-sub" title={shell ? cwd : ''}>
              {shell ? cwd : t('term.agentSub')}
            </p>
          </div>
          <div className="ql-tools">
            <div className="ql-mode term-target" role="radiogroup">
              {target('agent', agentName(view.label, t))}
              {target('shell', t('term.shell'))}
            </div>
            <button
              type="button"
              className="icon-button term-herdr"
              {...label('term.openHerdr')}
              disabled={!canMutate || (shell ? !hasShell : !item?.pane)}
              onClick={() => on.toHerdr?.()}
            >
              <HerdrIcon />
            </button>
          </div>
          <button
            type="button"
            className="icon-button ql-close term-x"
            {...label('sheet.close')}
            onClick={() => on.close?.()}
          >
            <CloseIcon />
          </button>
        </header>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a click gives the screen the keys; the field under it takes them */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
        <div
          className={classNames('term-screen', view.typing && 'typing', !!panel && view.hasLines && 'dimmed')}
          ref={refs.screen}
          onClick={onScreenClick}
        >
          <div className="term-scroll" ref={refs.scroller}>
            <div className="term-lines" ref={refs.lines} />
          </div>
          <div className="term-state" hidden={!panel}>
            {panel && <StateView panel={panel} canMutate={canMutate} onDo={on.stateDo} />}
          </div>
          <div className="term-paste" hidden={!view.paste} role="alertdialog">
            {view.paste && (
              <>
                <span>{t('term.paste', { n: view.paste.n })}</span>
                <pre>{view.paste.shown}</pre>
                <button
                  type="button"
                  className="button primary"
                  data-paste="yes"
                  onClick={() => on.settlePaste?.(true)}
                >
                  {t('term.pasteYes')}
                </button>
                <button type="button" className="button" data-paste="no" onClick={() => on.settlePaste?.(false)}>
                  {t('term.pasteNo')}
                </button>
              </>
            )}
          </div>
          <textarea
            className="term-input"
            data-own-keys=""
            rows={1}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
            aria-label={t('term.input')}
            // Out of the Tab order while it takes no keys, so Tab and Esc are the window's there.
            tabIndex={canInput ? 0 : -1}
            ref={refs.input}
          />
        </div>
        <div
          className="term-keys"
          role="toolbar"
          aria-label={t('term.keys')}
          hidden={!(coarse || narrow) || !live}
          onPointerDown={onKeyRowDown}
        >
          {KEY_ROW.map(k => (
            <button
              key={k.key}
              type="button"
              data-key={k.key}
              aria-label={k.aria}
              disabled={!canInput}
              onClick={() => on.sendKey?.(k.key)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <footer className="ql-foot term-foot">
          <span className={classNames('term-status', foot.warn && 'warn')}>
            {foot.dot && <span className={classNames('term-dot', view.typing && 'on')} />}
            <span>{foot.text}</span>
          </span>
          <button
            type="button"
            className={classNames('button term-close', view.armed && 'armed')}
            hidden={!shell || !hasShell}
            disabled={!canMutate}
            title={t('term.closeHint')}
            onClick={() => on.closeShell?.()}
          >
            {t(view.armed ? 'term.closeConfirm' : 'term.close')}
          </button>
        </footer>
      </section>
    </div>
  )
}

/** The page's terminal window, in <body> beside the page. */
export function Terminal({ engine }: { engine: TerminalEngine }) {
  const view = useStore(engine.view)
  const { data, canMutate } = useBoardContext()
  const coarse = useMediaQuery('(pointer: coarse)')
  const narrow = useMediaQuery(PHONE_QUERY)
  // Just opened: drawn now, it grows out of where it came from.
  useLayoutEffect(() => engine.grow())
  if (typeof document === 'undefined') return null
  const item = view.key ? (data?.items.find(i => i.key === view.key) ?? null) : null
  return createPortal(
    <TerminalView
      view={view}
      item={item}
      canMutate={canMutate}
      hasShell={!!view.key && (data?.shells ?? []).includes(view.key)}
      coarse={coarse}
      narrow={narrow}
      refs={engine.refs}
      on={{
        close: engine.clickClose,
        pickTarget: engine.pickTarget,
        toHerdr: () => void engine.toHerdr(),
        closeShell: () => void engine.closeShell(),
        clickScreen: engine.clickScreen,
        stateDo: engine.stateDo,
        settlePaste: engine.settlePaste,
        sendKey: engine.sendKey,
      }}
    />,
    document.body,
  )
}
