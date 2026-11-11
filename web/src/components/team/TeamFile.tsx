// A file on a thread's line (#371): its name and size, how far it is, and once this board has it, a
// picture inline or a download link. The address is the board's own uploads route, which shows only
// raster images inline and offers everything else as a download; nothing here opens or runs it.
// The attach button, drag and drop and previews in the composer come with #370's composer.
import { useT } from '../../i18n/I18nProvider.tsx'
import type { ThreadLine } from '../../models/team.ts'

type LineFile = NonNullable<ThreadLine['file']>

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** A size as people read it: bytes, KB or MB. */
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`
  return `${Math.round(n / 104857.6) / 10} MB`
}

export function TeamFile({ file }: { file: LineFile }) {
  const t = useT()
  const name = file.name ?? t('team.file.unnamed')
  const shown = file.url && (file.state === 'ready' || file.state === 'up' || file.state === 'uploading')
  const status =
    file.state === 'pending'
      ? t('team.file.pending')
      : file.state === 'uploading'
        ? t('team.file.uploading')
        : file.state === 'failed'
          ? t('team.file.failed', { why: file.why ?? '' })
          : file.state === 'refused'
            ? t('team.file.refused', { why: file.why ?? '' })
            : file.state === 'draft'
              ? t('team.file.draft')
              : null
  const pct = file.progress !== undefined ? t('team.file.progress', { pct: Math.floor(file.progress * 100) }) : null
  const parts = [file.size !== undefined ? fileSize(file.size) : null, status, pct].filter(Boolean).join(' · ')
  return (
    <div className="team-file" data-file-state={file.state}>
      {shown && IMAGE.test(file.url ?? '') && (
        <a href={file.url} target="_blank" rel="noreferrer">
          <img src={file.url} alt={name} style={{ maxWidth: '100%', maxHeight: 240, display: 'block' }} />
        </a>
      )}
      <p className="hint">
        {shown ? (
          <a href={file.url} download={name} title={t('team.file.open')}>
            {name}
          </a>
        ) : (
          <span>{name}</span>
        )}
        {parts && ` · ${parts}`}
      </p>
    </div>
  )
}
