// What the quick look shows of a file or folder (the old page's files.js render, folder, code,
// table, empty): images, PDF, video and audio from the raw bytes; Markdown rendered or as source;
// CSV as a table; code and text in numbered lines (the line it was opened at lit); folders as a
// list to walk through; and why there is nothing to show.
import type { ReactNode } from 'react'
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
} from '../../models/files.ts'
import { markdown } from '../../models/markdown.ts'
import type { FileLook, LookMode } from '../../models/quick-look.ts'
import { classNames } from '../class-names.ts'
import { FileIcon } from './FileChip.tsx'

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
  /** An image loaded: its own size goes in the footer. */
  onImage?: ((width: number, height: number) => void) | undefined
}

export function Preview({ data: d, mode, token, onGo, onOpen, onImage }: PreviewProps): ReactNode {
  const t = useT()
  if (d.error === 'missing') return <LookEmpty icon="missing" text={t('ql.missing', { path: d.path ?? '' })} />
  if (d.error) return <LookEmpty icon="file" text={d.error === 'denied' ? t('ql.denied') : d.error} />
  if (d.dir) return <Folder path={d.path ?? ''} entries={d.entries ?? []} onGo={onGo} />
  const src = rawUrl(d.path ?? '', token)
  if (d.kind === 'image')
    return (
      <div className="ql-media checker">
        <img src={src} alt="" onLoad={e => onImage?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
      </div>
    )
  if (d.kind === 'pdf') return <iframe className="ql-frame" src={src} title={d.name ?? ''} />
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
  if (typeof d.text === 'string') {
    if (d.kind === 'markdown' && mode === 'view')
      return (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags
        <article className="md ql-md" dangerouslySetInnerHTML={{ __html: markdown(d.text, { soft: true }) }} />
      )
    if (isTable(d)) return <Table rows={d.rows ?? []} />
    return <Code text={d.text} line={d.line} />
  }
  return <LookEmpty icon={iconName(d.kind === 'binary' ? 'file' : d.kind)} text={t('ql.noPreview')} onOpen={onOpen} />
}

function Code({ text, line }: { text: string; line: number | null }) {
  return (
    <div className="ql-code">
      {codeLines(text).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines in their order
        <div key={i} className={classNames('ql-ln', i + 1 === line && 'hit')} data-n={i + 1}>
          {l || '​'}
        </div>
      ))}
    </div>
  )
}

function Table({ rows }: { rows: string[][] }) {
  const [first = [], ...rest] = rows
  return (
    <div className="ql-table">
      <table>
        <thead>
          <tr>
            {first.map((c, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a row's cells in their order
              <th key={n}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rest.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows in their order
            <tr key={i}>
              {r.map((c, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: as above
                <td key={n}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

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
