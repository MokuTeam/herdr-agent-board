// What the quick look shows of a file or folder (the old page's files.js render, folder, code,
// table, empty): images (they zoom, zoom.ts), video and audio from the raw bytes; a PDF, a Word
// document and a spreadsheet drawn by the board's own viewers (web/src/viewers/, #176); Markdown
// rendered or as source; CSV as a table,
// its rows drawn as they scroll into view; code and text in numbered lines (the line it was opened
// at lit); folders as a list to walk through; and why there is nothing to show.
import { memo, type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLatest } from '../../hooks/useLatest.ts'
import { useViewer } from '../../hooks/useViewer.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  codeLines,
  dateText,
  type IconName,
  iconName,
  inFolder,
  isTable,
  rawUrl,
  sizeText,
  widestCandidates,
} from '../../models/files.ts'
import { markdown } from '../../models/markdown.ts'
import type { FileLook, LookMode } from '../../models/quick-look.ts'
import type { ZoomState } from '../../models/zoom.ts'
import { classNames } from '../class-names.ts'
import { FileIcon } from './FileChip.tsx'
import {
  besideApp,
  loadViewer,
  OFFICE_TEXTS,
  type OfficeKind,
  type OfficeModule,
  PDF_TEXTS,
  type PdfModule,
  type PdfViewer,
  pdfAssets,
  type ViewerLook,
  viewerLook,
} from './viewers.ts'
import type { ImageZoom } from './zoom.ts'

/** Nothing to show, and why; `onOpen` adds the button that opens it with the system. */
export function LookEmpty({ icon, text, onOpen }: { icon: IconName; text: string; onOpen?: (() => void) | undefined }) {
  const t = useT()
  return (
    <div className="ql-empty">
      <FileIcon name={icon} />
      <p>{text}</p>
      {onOpen && (
        <button type="button" className="button primary" data-ql="open" onClick={onOpen}>
          {t('ql.open')}
        </button>
      )}
    </div>
  )
}

export interface PreviewProps {
  data: FileLook
  mode: LookMode
  /** The run's token for the raw bytes. */
  token: string | null
  /** A folder's entry: the quick look goes there. */
  onGo?: ((path: string) => void) | undefined
  /** Open it with the system. */
  onOpen?: (() => void) | undefined
  /** An image loaded: its own size goes in the footer, and it zooms. */
  onImage?: ((img: HTMLImageElement) => void) | undefined
  /** The image is no longer drawn: its zoom goes. */
  onImageGone?: ((img: HTMLImageElement) => void) | undefined
  /** A PDF read: how many pages, for the footer. */
  onPages?: ((count: number) => void) | undefined
  /** A viewer that zooms (a PDF's pages) is on show: `attach` hands it the footer's zoom bar. */
  onZoomable?: ((el: Element, attach: (onChange: (z: ZoomState) => void) => ImageZoom) => void) | undefined
  /** That viewer is no longer drawn: its zoom goes. */
  onZoomGone?: ((el: Element) => void) | undefined
}

export function Preview({
  data: d,
  mode,
  token,
  onGo,
  onOpen,
  onImage,
  onImageGone,
  onPages,
  onZoomable,
  onZoomGone,
}: PreviewProps): ReactNode {
  const t = useT()
  if (d.error === 'missing') return <LookEmpty icon="missing" text={t('ql.missing', { path: d.path ?? '' })} />
  if (d.error) return <LookEmpty icon="file" text={d.error === 'denied' ? t('ql.denied') : d.error} />
  if (d.dir) return <Folder path={d.path ?? ''} entries={d.entries ?? []} onGo={onGo} />
  const src = rawUrl(d.path ?? '', token)
  if (d.kind === 'image') return <LookImage src={src} alt={d.name ?? ''} onLoad={onImage} onGone={onImageGone} />
  if (d.kind === 'pdf')
    return (
      <PdfLook
        src={src}
        size={d.size}
        name={d.name ?? ''}
        onOpen={onOpen}
        onPages={onPages}
        onZoomable={onZoomable}
        onZoomGone={onZoomGone}
      />
    )
  if (d.kind === 'document' || d.kind === 'spreadsheet')
    return <OfficeLook kind={d.kind} src={src} name={d.name ?? ''} size={d.size} onOpen={onOpen} />
  if (d.kind === 'video')
    return (
      <div className="ql-media">
        {/* biome-ignore lint/a11y/useMediaCaption: the user's own files have no captions to give */}
        <video controls preload="metadata" src={src} />
      </div>
    )
  if (d.kind === 'audio')
    return (
      <div className="ql-media audio">
        <FileIcon name="audio" />
        {/* biome-ignore lint/a11y/useMediaCaption: the user's own files have no captions to give */}
        <audio controls preload="metadata" src={src} />
      </div>
    )
  // A CSV's rows come without its text (adapters/files.ts csvPreview): the table is all it shows.
  if (isTable(d)) return <Table rows={d.rows ?? []} />
  if (typeof d.text === 'string') {
    if (d.kind === 'markdown' && mode === 'view')
      return (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags
        <article className="md ql-md" dangerouslySetInnerHTML={{ __html: markdown(d.text, { soft: true }) }} />
      )
    return <Code text={d.text} line={d.line} />
  }
  return <LookEmpty icon={iconName(d.kind === 'binary' ? 'file' : d.kind)} text={t('ql.noPreview')} onOpen={onOpen} />
}

/** An image on its stage, which zoom.ts sizes and moves it in once it loaded. */
function LookImage({
  src,
  alt,
  onLoad,
  onGone,
}: {
  src: string
  alt: string
  onLoad?: ((img: HTMLImageElement) => void) | undefined
  onGone?: ((img: HTMLImageElement) => void) | undefined
}) {
  const ref = useRef<HTMLImageElement>(null)
  const gone = useLatest(onGone)
  useEffect(() => {
    const img = ref.current
    return () => {
      if (img) gone.current?.(img)
    }
  }, [gone])
  return (
    <div className="ql-media ql-stage">
      <img ref={ref} className="checker" src={src} alt={alt} onLoad={e => onLoad?.(e.currentTarget)} />
    </div>
  )
}

function Code({ text, line }: { text: string; line: number | null }) {
  return (
    <div className="ql-code">
      {codeLines(text).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines in their order
        <div key={i} className={classNames('ql-ln', i + 1 === line && 'hit')} data-n={i + 1}>
          {l || '\u200b'}
        </div>
      ))}
    </div>
  )
}

interface PdfLookProps {
  src: string
  size?: number | null | undefined
  name: string
  onOpen?: (() => void) | undefined
  onPages?: ((count: number) => void) | undefined
  onZoomable?: PreviewProps['onZoomable']
  onZoomGone?: PreviewProps['onZoomGone']
}

/**
 * A PDF drawn by the board (viewers/pdf.ts, imported when one is opened): "loading" over it until
 * its pages are laid out, which also gives the footer their count and the zoom bar its zoom;
 * broken or with a password, why, with the button that opens it with the system. Without the
 * viewer (its script did not build: PDF.js not installed), the browser's own PDF viewer in a
 * frame, as before.
 */
function PdfLook({ src, size, name, onOpen, onPages, onZoomable, onZoomGone }: PdfLookProps) {
  const t = useT()
  const latest = useLatest({ t, onPages, onZoomable, onZoomGone })
  const { host, state } = useViewer(
    `${src} ${size}`,
    () => loadViewer<PdfModule>('pdf'),
    (pdf, el, report) => {
      const viewer: PdfViewer = pdf.mount(el, {
        url: src,
        size,
        worker: besideApp('pdf.worker.js'),
        assets: pdfAssets(),
        pageLabel: (n, total) => latest.current.t('ql.pageOf', { n, total }),
        onPages: count => {
          report.ready()
          latest.current.onPages?.(count)
          latest.current.onZoomable?.(el, onChange => viewer.zoom(onChange))
        },
        onFail: why => report.fail(why),
      })
      return {
        destroy() {
          latest.current.onZoomGone?.(el)
          viewer.destroy()
        },
      }
    },
  )
  return (
    <ViewerShown
      look={viewerLook(state, PDF_TEXTS)}
      host={host}
      hostClass="ql-pdf"
      icon="pdf"
      src={src}
      name={name}
      onOpen={onOpen}
    />
  )
}

interface ViewerShownProps {
  look: ViewerLook
  host: RefObject<HTMLDivElement | null>
  hostClass: string
  icon: IconName
  src: string
  name: string
  onOpen?: (() => void) | undefined
}

/**
 * A viewer's element, with "loading" over it until it draws; when it cannot, why, with the button
 * that opens the file with the system; with no viewer for a PDF, the browser's own in a frame.
 */
export function ViewerShown({ look, host, hostClass, icon, src, name, onOpen }: ViewerShownProps) {
  const t = useT()
  if (look.frame) return <iframe className="ql-frame" src={src} title={name} />
  return (
    <>
      <div className={hostClass} ref={host} hidden={!!look.empty} />
      {look.wait && <div className="ql-wait">{t('loading')}</div>}
      {look.empty && <LookEmpty icon={icon} text={t(look.empty)} onOpen={onOpen} />}
    </>
  )
}

// Larger than this, a document or a spreadsheet is not read here: a phone would run short of
// memory (a workbook takes ten times its size once read). The quick look says so instead.
const VIEW_LIMIT: Record<OfficeKind, number> = { document: 20 << 20, spreadsheet: 10 << 20 }

interface OfficeLookProps {
  kind: OfficeKind
  src: string
  name: string
  size?: number | null | undefined
  onOpen?: (() => void) | undefined
}

/**
 * A Word document or a spreadsheet, read in a worker and drawn by its viewer (viewers/document.ts,
 * viewers/spreadsheet.ts, imported when one is opened): too big, said so without reading it;
 * else as its viewer has it (ViewerShown): "loading" until it is drawn, and broken, with a
 * password or without its viewer, why, with the button that opens it with the system.
 */
function OfficeLook(props: OfficeLookProps) {
  const t = useT()
  if ((props.size ?? 0) > VIEW_LIMIT[props.kind])
    return <LookEmpty icon={props.kind} text={t('ql.tooBig')} onOpen={props.onOpen} />
  return <OfficeRead {...props} />
}

function OfficeRead({ kind, src, name, onOpen }: OfficeLookProps) {
  const t = useT()
  const latest = useLatest({ t })
  const { host, state } = useViewer(
    `${kind} ${src}`,
    () => loadViewer<OfficeModule>(kind),
    (office, el, report) =>
      office.mount(el, {
        url: src,
        name,
        worker: besideApp(`${kind}-worker.js`),
        lang: latest.current.t.lang,
        truncated: latest.current.t('ql.truncated'),
        onReady: () => report.ready(),
        onFail: why => report.fail(why),
      }),
  )
  return (
    <ViewerShown
      look={viewerLook(state, OFFICE_TEXTS)}
      host={host}
      hostClass={`ql-${kind}`}
      icon={kind}
      src={src}
      name={name}
      onOpen={onOpen}
    />
  )
}

// A CSV's rows are drawn this many at a time, the next block as the last comes near the view: a
// table of many thousand rows opens at once.
const ROWS_AT_ONCE = 300

function Table({ rows }: { rows: string[][] }) {
  const [first = []] = rows
  const blocks = useMemo(() => {
    const out: string[][][] = []
    for (let i = 1; i < rows.length; i += ROWS_AT_ONCE) out.push(rows.slice(i, i + ROWS_AT_ONCE))
    return out
  }, [rows])
  const [shown, setShown] = useState(1)
  const more = useRef<HTMLDivElement>(null)
  const table = useRef<HTMLTableElement>(null)
  // A table drawn block by block gets its columns' widths once its first block is drawn, wide
  // enough for the widest values anywhere in it, and keeps them: a wider row in a later block
  // does not move the columns, as the automatic layout would. The last one takes what room is left.
  const [widths, setWidths] = useState<number[] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first draw of a file's table is when to measure
  useLayoutEffect(() => {
    const el = table.current
    if (!el || blocks.length < 2) return void setWidths(null)
    setWidths(measureColumns(el, widestCandidates(rows)))
  }, [rows])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new block drawn is when to look again
  useEffect(() => {
    const el = more.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const seen = new IntersectionObserver(([e]) => e?.isIntersecting && setShown(n => n + 1), {
      root: el.closest('.ql-body'),
      rootMargin: '0px 0px 800px 0px',
    })
    seen.observe(el)
    return () => seen.disconnect()
  }, [shown])
  return (
    <div className="ql-table">
      <table
        ref={table}
        className={widths ? 'fixed' : undefined}
        style={widths ? { width: widths.reduce((a, b) => a + b, 0) } : undefined}
      >
        {widths && (
          <colgroup>
            {widths.map((w, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the columns in their order
              <col key={n} style={n < widths.length - 1 ? { width: w } : undefined} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {first.map((c, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells in their order
              <th key={n}>{c}</th>
            ))}
          </tr>
        </thead>
        {blocks.length ? (
          blocks.slice(0, shown).map((block, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the blocks of rows in their order
            <Rows key={i} rows={block} />
          ))
        ) : (
          <tbody />
        )}
      </table>
      {shown < blocks.length && <div className="ql-more" ref={more} />}
    </div>
  )
}

/**
 * Each column's width for the whole file, as the browser lays it out (the cells' font, their
 * figures, padding and widest): rows of each column's widest values (widestCandidates) put in
 * for a moment, the table at its own width, the header's widths read, all put back. At most as
 * wide as a cell may be.
 */
export function measureColumns(table: HTMLTableElement, candidates: string[][]): number[] {
  const body = table.tBodies[0]
  const heads = [...table.querySelectorAll('th')]
  const probes: HTMLTableRowElement[] = []
  for (let k = 0; body && k < Math.max(0, ...candidates.map(c => c.length)); k++) {
    const tr = table.ownerDocument.createElement('tr')
    for (let i = 0; i < heads.length; i++) {
      const td = table.ownerDocument.createElement('td')
      td.textContent = candidates[i]?.[k] ?? ''
      tr.append(td)
    }
    body.append(tr)
    probes.push(tr)
  }
  // At its own width for the measure: fitted to the window, the columns would come out squeezed.
  const width = table.style.width
  table.style.width = 'max-content'
  // Layout widths (offsetWidth, a pixel more for its rounding), not the box on screen: the quick
  // look is still growing open, scaled, when its table is first drawn.
  const widths = heads.map(th => Math.min(420, th.offsetWidth + 1))
  table.style.width = width
  for (const tr of probes) tr.remove()
  return widths
}

/** A block of a table's rows: drawn once, not again as the next blocks come. */
const Rows = memo(function Rows({ rows }: { rows: string[][] }) {
  return (
    <tbody>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows in their order
        <tr key={i}>
          {r.map((c, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: as above
            <td key={n}>{c}</td>
          ))}
        </tr>
      ))}
    </tbody>
  )
})

function Folder({
  path,
  entries,
  onGo,
}: {
  path: string
  entries: NonNullable<FileLook['entries']>
  onGo?: ((path: string) => void) | undefined
}) {
  const t = useT()
  if (!entries.length) return <LookEmpty icon="dir" text={t('ql.emptyFolder')} />
  return (
    // biome-ignore lint/a11y/useSemanticElements: the page's markup as it was (the stylesheet lays out .ql-list)
    <div className="ql-list" role="list">
      {entries.map(e => (
        // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: the page's markup as it was: a row of the list that walks to it
        // biome-ignore lint/a11y/useSemanticElements: as above
        <button
          key={e.name}
          type="button"
          className={classNames('ql-row', e.dir && 'dir')}
          role="listitem"
          data-go={inFolder(path, e.name)}
          onClick={() => onGo?.(inFolder(path, e.name))}
        >
          <FileIcon name={iconName(e.dir ? 'dir' : e.kind)} />
          <span className="n">{e.name}</span>
          <span className="m">{e.mtime ? dateText(e.mtime, t.lang) : ''}</span>
          <span className="s">{e.dir ? '' : sizeText(e.size, t)}</span>
        </button>
      ))}
    </div>
  )
}
