// The changes of a session's checkout in the quick look (the old page's files.js changes): the
// changed files on the left, their diff on the right; a file's name in the list scrolls to its
// diff, the button by it opens the file itself. Read by the server (git status and diff against HEAD).
import { useRef, useState } from 'react'
import type { Translator } from '../../../../src/core/types.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type ChangedFile, changedFiles, type DiffLine } from '../../models/diff.ts'
import { clockOf, iconName, inCheckout, kindOfName } from '../../models/files.ts'
import type { ChangesLook } from '../../models/quick-look.ts'
import { reducedMotion } from '../../models/spring.ts'
import { FileIcon } from '../files/FileChip.tsx'
import { LookEmpty } from '../files/Preview.tsx'

/** A file's state by its letter: untracked ones (`??`) say N. */
const letterOf = (f: ChangedFile) => (f.code === '??' ? 'N' : f.code)

/** What the footer says under the changes. */
export function changesFoot(d: ChangesLook, t: Translator): string[] {
  if (!d.available) return []
  const read = t('changes.read', { time: clockOf(d.collectedAt ?? 0, t.lang) })
  const files = changedFiles(d.status, d.diff)
  if (!files.length) return [read]
  const added = files.reduce((s, f) => s + (f.diff?.added ?? 0), 0)
  const removed = files.reduce((s, f) => s + (f.diff?.removed ?? 0), 0)
  return [
    t('changes.files', { n: files.length }),
    `+${added} −${removed}`,
    read,
    ...(d.truncated ? [t('changes.truncated')] : []),
    t('changes.scope'),
  ]
}

export interface ChangesProps {
  data: ChangesLook
  /** A file's button: the quick look opens it. */
  onOpen?: ((path: string) => void) | undefined
}

export function Changes({ data, onOpen }: ChangesProps) {
  const t = useT()
  const [current, setCurrent] = useState<number | null>(null)
  const diff = useRef<HTMLDivElement>(null)
  if (!data.available) return <LookEmpty icon="changes" text={t('changes.unavailable')} />
  const files = changedFiles(data.status, data.diff)
  if (!files.length) return <LookEmpty icon="clean" text={t('changes.clean')} />
  const root = data.root ?? ''
  const jump = (i: number) => {
    setCurrent(i)
    diff.current
      ?.querySelector(`.ql-dfile[data-i="${i}"]`)
      ?.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' })
  }
  return (
    <div className="ql-changes">
      <nav className="ql-files">
        {files.map((f, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: the files in git's order; a new read draws them anew
            key={i}
            type="button"
            className="ql-file"
            data-jump={i}
            title={f.from ? `${f.from} → ${f.path}` : f.path}
            aria-current={current === null ? undefined : current === i}
            onClick={() => jump(i)}
          >
            <Badge file={f} />
            <FilePath path={f.path} />
            <Count file={f} />
          </button>
        ))}
      </nav>
      <div className="ql-diff" ref={diff}>
        {files.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above
          <section key={i} className="ql-dfile" data-i={i}>
            <header>
              <Badge file={f} />
              <FilePath path={f.path} />
              <Count file={f} />
              {f.code !== 'D' && (
                <button
                  type="button"
                  className="icon-button"
                  data-go={inCheckout(root, f.path)}
                  title={t('changes.openFile')}
                  aria-label={t('changes.openFile')}
                  onClick={() => onOpen?.(inCheckout(root, f.path))}
                >
                  <FileIcon name={iconName(kindOfName(f.path))} />
                </button>
              )}
            </header>
            <Lines file={f} />
          </section>
        ))}
      </div>
    </div>
  )
}

function Badge({ file }: { file: ChangedFile }) {
  const t = useT()
  const letter = letterOf(file)
  return (
    <span className={`st st-${letter}`} title={t(`changes.st.${letter}`)}>
      {letter}
    </span>
  )
}

/** A path as git gives it: its folder dimmed, its name in bold. */
function FilePath({ path }: { path: string }) {
  const i = path.lastIndexOf('/')
  return (
    <span className="p">
      {i >= 0 && <span className="dir">{path.slice(0, i + 1)}</span>}
      <b>{i < 0 ? path : path.slice(i + 1)}</b>
    </span>
  )
}

function Count({ file }: { file: ChangedFile }) {
  const d = file.diff
  if (!d || d.binary) return null
  return (
    <span className="cnt">
      {d.added > 0 && <i className="a">+{d.added}</i>}
      {d.removed > 0 && <i className="r">−{d.removed}</i>}
    </span>
  )
}

function Lines({ file }: { file: ChangedFile }) {
  const t = useT()
  const d = file.diff
  if (d?.binary) return <p className="ql-dnote">{t('changes.binary')}</p>
  if (d?.lines.length)
    return (
      <div className="ql-dlines">
        <div className="ql-dl">
          {d.lines.map((l, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines in their order
            <Line key={n} line={l} />
          ))}
        </div>
      </div>
    )
  return <p className="ql-dnote">{t(file.code === '??' ? 'changes.untracked' : 'changes.noDiff')}</p>
}

function Line({ line }: { line: DiffLine }) {
  const bare = line.kind === 'hunk' || line.kind === 'note'
  return (
    <div className={`dl ${line.kind}`}>
      <span className="o">{bare ? null : line.old}</span>
      <span className="n">{bare ? null : line.new}</span>
      <span className="x">{bare ? line.text : line.text || ' '}</span>
    </div>
  )
}
