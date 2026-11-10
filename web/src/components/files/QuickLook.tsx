// The quick look over the board (the old page's files.js root): its head with the kind's icon,
// the name, the folders above to walk to and the tools (preview or source for Markdown, open with
// the system, read the changes again, show in its folder, copy the path), what it shows, and a
// footer of what it is, with the scale of an image or a PDF's pages and a button in to 100% or
// back to fit. It lives in <body> itself, beside the page (hooks/useModalFocus.ts); its motion,
// focus, keys and zoom are hooks/useQuickLook.ts's.
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Translator } from '../../../../src/core/types.ts'
import type { LookRefs, QuickLookEngine } from '../../hooks/useQuickLook.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  actionsOff,
  bodyClass,
  crumbs,
  type LookHead,
  lookIcon,
  NO_ZOOM,
  parentOf,
  previewFoot,
  type ZoomFoot,
  zoomBar,
} from '../../models/files.ts'
import { type PathMap, remoteTools } from '../../models/local-paths.ts'
import {
  type FileLook,
  idOf,
  isChangesLook,
  isFileLook,
  type LookData,
  type LookMode,
  type LookTarget,
  type LookView,
} from '../../models/quick-look.ts'
import { remotePage } from '../../models/remote-page.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { localPaths } from '../../state/local-paths.ts'
import { Store, useStore } from '../../state/store.ts'
import { Changes, changesFoot } from '../sheet/Changes.tsx'
import { FileIcon } from './FileChip.tsx'
import { History, historyFoot } from './History.tsx'
import { Preview, type PreviewProps } from './Preview.tsx'

export interface LookHandlers {
  back(): void
  close(): void
  refresh(): void
  mode(mode: LookMode): void
  act(how: 'open' | 'reveal' | 'copy' | 'local'): void
  go(path: string): void
  search(query: string): void
  upgrade(root: HTMLElement, cwd: string): void
  /** The zoom bar's button. */
  zoom(): void
}

/** An image's own size, for the one it was read from. */
export interface ImageSize {
  data: LookData
  width: number
  height: number
}

/** A PDF's pages, for the one they were read from. */
export interface PageCount {
  data: LookData
  pages: number
}

export interface QuickLookViewProps {
  view: LookView
  /** Open and reveal need the board. */
  canEdit: boolean
  /** The run's token for the raw bytes (the board's fsToken). */
  token: string | null
  /**
   * The board on another device (models/remote-page.ts): its server folder → folder here list, for
   * Download and the path here; none at the computer, where neither is offered.
   */
  local?: readonly PathMap[] | null
  image?: ImageSize | null
  pages?: PageCount | null
  /** An image loaded (it zooms), and gone. */
  onImage?: (img: HTMLImageElement, data: FileLook) => void
  onImageGone?: (img: HTMLImageElement) => void
  /** A PDF read, how many pages; its viewer zooms, and is gone. */
  onPages?: (pages: number, data: FileLook) => void
  onZoomable?: PreviewProps['onZoomable']
  onZoomGone?: PreviewProps['onZoomGone']
  /** The zoom of the image on show, for the footer: only the footer draws again as it changes. */
  zoom?: Store<ZoomFoot>
  refs?: Partial<LookRefs>
  on?: Partial<LookHandlers>
}

const NOTHING_ZOOMED = new Store(NO_ZOOM)

const showsMarkdown = (view: LookView): boolean =>
  !view.hidden && !view.loading && view.top?.kind !== 'history' && view.data?.kind === 'markdown'

function bodyClassOf(view: LookView): string {
  if (view.hidden) return 'ql-body'
  if (view.top?.kind === 'history') return 'ql-body k-history'
  if (view.loading || !view.data) return 'ql-body loading'
  return bodyClass(view.data)
}

/** The footer: what it is, how big, how many, when it was read or changed. */
export function footOf(
  view: LookView,
  t: Translator,
  image: ImageSize | null = null,
  pages: PageCount | null = null,
): string {
  const d = view.data
  if (view.hidden || !view.top) return ''
  if (view.top.kind === 'history') return historyFoot(view.top, t)
  if (view.loading || !d) return ''
  if (isChangesLook(d)) return changesFoot(d, t).join(' · ')
  if (!isFileLook(d)) return ''
  const foot = previewFoot(d, t)
  const plain = !d.error && !d.dir
  if (image?.data === d && d.kind === 'image' && plain) foot.unshift(`${image.width} × ${image.height}`)
  if (pages?.data === d && d.kind === 'pdf' && plain) foot.unshift(t('ql.pages', { n: pages.pages }))
  return foot.join(' · ')
}

export function QuickLookView({
  view,
  canEdit,
  token,
  local = null,
  image = null,
  pages = null,
  onImage,
  onImageGone,
  onPages,
  onZoomable,
  onZoomGone,
  zoom = NOTHING_ZOOMED,
  refs = {},
  on = {},
}: QuickLookViewProps) {
  const t = useT()
  // The past sessions say so in the page's language as it is now (the old page's relabel drew them again).
  const head = view.top?.kind === 'history' && !view.hidden ? { ...view.head, name: t('history.title') } : view.head
  const off = actionsOff(view.data, canEdit)
  const file = view.data && isFileLook(view.data) && !view.hidden && !view.loading ? view.data : null
  const remote = remoteTools(file, local, token)
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
            <Crumbs head={head} drawn={view.drawn} onGo={on.go} />
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
            {remote.local && (
              <button
                type="button"
                className="icon-button ql-local"
                {...label('ql.copyLocal')}
                onClick={() => on.act?.('local')}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <rect x="2.5" y="3.5" width="15" height="10" rx="1.6" />
                  <path d="M7 16.5h6M10 13.5v3m-1.6-5.9 1.6 1.6 1.6-1.6" />
                </svg>
              </button>
            )}
            {remote.download && (
              <a className="icon-button ql-download" href={remote.download} download {...label('ql.download')}>
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M10 3.5v9m-3.5-3.5 3.5 3.5 3.5-3.5M4 15.5h12" />
                </svg>
              </a>
            )}
          </div>
          <button type="button" className="icon-button ql-close" {...label('sheet.close')} onClick={() => on.close?.()}>
            <FileIcon name="close" />
          </button>
        </header>
        <div className={bodyClassOf(view)} ref={refs.body}>
          <LookBody
            view={view}
            token={token}
            onImage={onImage}
            onImageGone={onImageGone}
            onPages={onPages}
            onZoomable={onZoomable}
            onZoomGone={onZoomGone}
            on={on}
          />
        </div>
        <LookFoot text={footOf(view, t, image, pages)} zoom={zoom} onZoom={on.zoom} />
      </section>
    </div>
  )
}

/**
 * What it is, and for a zoomable image its scale and the button in to 100% or back to fit; with no
 * zoom any more the bar hides, keeping what it showed last.
 */
function LookFoot({ text, zoom, onZoom }: { text: string; zoom: Store<ZoomFoot>; onZoom?: (() => void) | undefined }) {
  const t = useT()
  const { now, last } = useStore(zoom)
  const bar = last ? zoomBar(last, t) : null
  return (
    <footer className="ql-foot look-foot">
      <span className="look-foot-text" title={text}>
        {text}
      </span>
      <span className="ql-zoom" hidden={!now}>
        <span className="ql-zoom-level">{bar?.level}</span>
        <button
          type="button"
          className="ql-zoom-button"
          title={bar?.hint}
          aria-label={bar?.hint}
          onClick={() => onZoom?.()}
        >
          {bar?.label}
        </button>
      </span>
    </footer>
  )
}

interface CrumbsProps {
  head: LookHead
  /** The head's draws so far (LookView.drawn). */
  drawn: number
  onGo?: ((path: string) => void) | undefined
}

/**
 * The folders above, each a step to walk to; scrolled to the end, where the name is, each time the
 * head is drawn (upstream's head(): every step shown, the same file opened again too), not on every
 * render: a scroll would close a menu opened over it.
 */
function Crumbs({ head, drawn, onGo }: CrumbsProps) {
  const nav = useRef<HTMLElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new draw of the head is when to scroll
  useLayoutEffect(() => {
    if (nav.current) nav.current.scrollLeft = nav.current.scrollWidth
  }, [drawn])
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
  onImage?: ((img: HTMLImageElement, data: FileLook) => void) | undefined
  onImageGone?: ((img: HTMLImageElement) => void) | undefined
  onPages?: ((pages: number, data: FileLook) => void) | undefined
  onZoomable?: PreviewProps['onZoomable']
  onZoomGone?: PreviewProps['onZoomGone']
  on: Partial<LookHandlers>
}

function LookBody({ view, token, onImage, onImageGone, onPages, onZoomable, onZoomGone, on }: LookBodyProps) {
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
      key={idOf(d)}
      data={d}
      mode={view.mode}
      token={token}
      onGo={on.go}
      onOpen={() => on.act?.('open')}
      onImage={img => onImage?.(img, d)}
      onImageGone={onImageGone}
      onPages={n => onPages?.(n, d)}
      onZoomable={onZoomable}
      onZoomGone={onZoomGone}
    />
  )
}

/** The page's quick look, in <body> beside the page. */
/** The quick look's paths list on the board at the computer: none. */
const AT_THE_COMPUTER = new Store<PathMap[]>([])

export function QuickLook({ engine }: { engine: QuickLookEngine }) {
  const view = useStore(engine.view)
  const { canEdit, data } = useBoardContext()
  const [image, setImage] = useState<ImageSize | null>(null)
  const [pages, setPages] = useState<PageCount | null>(null)
  // At the computer the kept list is not even read: its own store, always empty, and no tools drawn.
  const maps = useStore(remotePage() ? localPaths() : AT_THE_COMPUTER)
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
      local={remotePage() ? maps : null}
      image={image}
      onImage={(img, d) => {
        const own = engine.imageLoaded(img, d)
        if (own) setImage({ data: d, ...own })
      }}
      onImageGone={engine.imageGone}
      pages={pages}
      onPages={(n, d) => setPages({ data: d, pages: n })}
      onZoomable={engine.zoomable}
      onZoomGone={engine.zoomGone}
      zoom={engine.zoom}
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
        zoom: engine.toggleZoom,
      }}
    />,
    document.body,
  )
}
