// The quick look over the board (the old page's files.js root): its head with the kind's icon,
// the name, the folders above to walk to and the tools (preview or source for Markdown, open with
// the system, read the changes again, show in its folder, copy the path), what it shows, and a
// footer of what it is. It lives in <body> itself, beside the page (hooks/useModalFocus.ts); its
// motion, focus and keys are hooks/useQuickLook.ts's.
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Translator } from '../../../../src/core/types.ts'
import type { LookRefs, QuickLookEngine } from '../../hooks/useQuickLook.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { actionsOff, bodyClass, crumbs, type LookHead, lookIcon, parentOf, previewFoot } from '../../models/files.ts'
import {
  idOf,
  isChangesLook,
  isFileLook,
  type LookData,
  type LookMode,
  type LookTarget,
  type LookView,
} from '../../models/quick-look.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { useStore } from '../../state/store.ts'
import { Changes, changesFoot } from '../sheet/Changes.tsx'
import { FileIcon } from './FileChip.tsx'
import { History, historyFoot } from './History.tsx'
import { Preview } from './Preview.tsx'

export interface LookHandlers {
  back(): void
  close(): void
  refresh(): void
  mode(mode: LookMode): void
  act(how: 'open' | 'reveal' | 'copy'): void
  go(path: string): void
  search(query: string): void
  upgrade(root: HTMLElement, cwd: string): void
}

/** An image's own size, for the one it was read from. */
export interface ImageSize {
  data: LookData
  width: number
  height: number
}

export interface QuickLookViewProps {
  view: LookView
  /** Open and reveal need the board. */
  canEdit: boolean
  /** The run's token for the raw bytes (the board's fsToken). */
  token: string | null
  image?: ImageSize | null
  onImage?: (size: ImageSize) => void
  refs?: Partial<LookRefs>
  on?: Partial<LookHandlers>
}

const showsMarkdown = (view: LookView): boolean =>
  !view.hidden && !view.loading && view.top?.kind !== 'history' && view.data?.kind === 'markdown'

function bodyClassOf(view: LookView): string {
  if (view.hidden) return 'ql-body'
  if (view.top?.kind === 'history') return 'ql-body k-history'
  if (view.loading || !view.data) return 'ql-body loading'
  return bodyClass(view.data)
}

/** The footer: what it is, how big, how many, when it was read or changed. */
export function footOf(view: LookView, t: Translator, image: ImageSize | null = null): string {
  const d = view.data
  if (view.hidden || !view.top) return ''
  if (view.top.kind === 'history') return historyFoot(view.top, t)
  if (view.loading || !d) return ''
  if (isChangesLook(d)) return changesFoot(d, t).join(' · ')
  if (!isFileLook(d)) return ''
  const foot = previewFoot(d, t)
  const own = image?.data === d && d.kind === 'image' && !d.error && !d.dir
  return (own ? [`${image.width} × ${image.height}`, ...foot] : foot).join(' · ')
}

export function QuickLookView({ view, canEdit, token, image = null, onImage, refs = {}, on = {} }: QuickLookViewProps) {
  const t = useT()
  // The past sessions say so in the page's language as it is now (the old page's relabel drew them again).
  const head = view.top?.kind === 'history' && !view.hidden ? { ...view.head, name: t('history.title') } : view.head
  const off = actionsOff(view.data, canEdit)
  const label = (key: string) => ({ title: t(key), 'aria-label': t(key) })
  return (
    <div className="ql" hidden={view.hidden} ref={refs.layer}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the dimmed board around it closes it with a click; Esc does with keys */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
      <div className="ql-scrim" ref={refs.scrim} onClick={() => on.close?.()} />
      <section
        className="ql-win"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ql-name"
        tabIndex={-1}
        ref={refs.win}
      >
        <header className="ql-head">
          <button
            type="button"
            className="icon-button ql-back"
            hidden={view.depth < 2}
            {...label('ql.back')}
            onClick={() => on.back?.()}
          >
            <FileIcon name="back" />
          </button>
          <span className="ql-icon">
            <FileIcon name={lookIcon(head)} />
          </span>
          <div className="ql-titles">
            <h3 id="ql-name">{head.name ?? ''}</h3>
            <Crumbs head={head} onGo={on.go} />
          </div>
          <div className="ql-tools">
            <div className="ql-mode" hidden={!showsMarkdown(view)}>
              {(['view', 'source'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  data-mode={mode}
                  aria-pressed={view.mode === mode}
                  onClick={() => on.mode?.(mode)}
                >
                  {t(mode === 'view' ? 'ql.view' : 'ql.source')}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="button primary ql-open"
              disabled={off.open}
              onClick={() => on.act?.('open')}
            >
              {t('ql.open')}
            </button>
            <button
              type="button"
              className="icon-button ql-refresh"
              hidden={view.top?.kind !== 'changes'}
              {...label('changes.refresh')}
              onClick={() => on.refresh?.()}
            >
              <FileIcon name="refresh" />
            </button>
            <button
              type="button"
              className="icon-button ql-reveal"
              {...label('ql.reveal')}
              disabled={off.reveal}
              onClick={() => on.act?.('reveal')}
            >
              <FileIcon name="reveal" />
            </button>
            <button
              type="button"
              className="icon-button ql-copy"
              {...label('ql.copy')}
              disabled={off.copy}
              onClick={() => on.act?.('copy')}
            >
              <FileIcon name="copy" />
            </button>
          </div>
          <button type="button" className="icon-button ql-close" {...label('sheet.close')} onClick={() => on.close?.()}>
            <FileIcon name="close" />
          </button>
        </header>
        <div className={bodyClassOf(view)} ref={refs.body}>
          <LookBody view={view} token={token} onImage={onImage} on={on} />
        </div>
        <footer className="ql-foot">{footOf(view, t, image)}</footer>
      </section>
    </div>
  )
}

/** The folders above, each a step to walk to; scrolled to the end, where the name is. */
function Crumbs({ head, onGo }: { head: LookHead; onGo?: ((path: string) => void) | undefined }) {
  const nav = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (nav.current) nav.current.scrollLeft = nav.current.scrollWidth
  })
  return (
    <nav className="ql-path" ref={nav}>
      {crumbs(head.path, head.kind).map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the folders in their order
        <Fragment key={i}>
          {i > 0 && <span>›</span>}
          <button type="button" data-go={c.path} onClick={() => onGo?.(c.path)}>
            {c.name}
          </button>
        </Fragment>
      ))}
    </nav>
  )
}

interface LookBodyProps {
  view: LookView
  token: string | null
  onImage?: ((size: ImageSize) => void) | undefined
  on: Partial<LookHandlers>
}

function LookBody({ view, token, onImage, on }: LookBodyProps) {
  const t = useT()
  const top: LookTarget | null = view.top
  if (view.hidden || !top) return null
  if (top.kind === 'history') return <History key={idOf(top)} target={top} onSearch={on.search} upgrade={on.upgrade} />
  const d = view.data
  if (view.loading || !d) return <div className="ql-wait">{t('loading')}</div>
  if (isChangesLook(d)) return <Changes key={idOf(d)} data={d} onOpen={on.go} />
  if (!isFileLook(d)) return null
  return (
    <Preview
      data={d}
      mode={view.mode}
      token={token}
      onGo={on.go}
      onOpen={() => on.act?.('open')}
      onImage={(width, height) => onImage?.({ data: d, width, height })}
    />
  )
}

/** The page's quick look, in <body> beside the page. */
export function QuickLook({ engine }: { engine: QuickLookEngine }) {
  const view = useStore(engine.view)
  const { canEdit, data } = useBoardContext()
  const [image, setImage] = useState<ImageSize | null>(null)
  const { refs } = engine
  // Just opened: drawn now, it grows out of where it came from.
  useLayoutEffect(() => engine.grow())
  // What it shows drawn anew: the line it was opened at a third down, else the top; a Markdown
  // file's paths become chips.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are when it was drawn anew, not what it reads
  useLayoutEffect(() => {
    const body = refs.body.current
    if (!body || view.hidden || view.loading || !view.data || view.top?.kind === 'history') return
    const hit = body.querySelector<HTMLElement>('.ql-ln.hit')
    if (hit)
      requestAnimationFrame(() => {
        body.scrollTop = hit.offsetTop - body.clientHeight / 3
      })
    else body.scrollTop = 0
    if (showsMarkdown(view) && view.mode === 'view') engine.upgrade(body, parentOf(view.data.path ?? ''))
  }, [view.data, view.mode, view.loading, view.hidden])
  if (typeof document === 'undefined') return null
  return createPortal(
    <QuickLookView
      view={view}
      canEdit={canEdit}
      token={data?.fsToken ?? null}
      image={image}
      onImage={setImage}
      refs={refs}
      on={{
        back: engine.back,
        close: engine.close,
        refresh: () => engine.nav.refresh(),
        mode: engine.setMode,
        act: engine.act,
        go: engine.go,
        search: query => engine.nav.search(query),
        upgrade: engine.upgrade,
      }}
    />,
    document.body,
  )
}
