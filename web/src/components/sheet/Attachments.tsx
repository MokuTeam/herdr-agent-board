// The files that go with the next message, over the message box: a picture's preview or a file
// icon, the name, the size (or that it uploads, or failed), and a button that takes it off.
import { useT } from '../../i18n/I18nProvider.tsx'
import { type Attachment, sizeText } from '../../models/composer.ts'
import { classNames } from '../class-names.ts'
import { FileGlyph } from '../icons.tsx'

export interface AttachmentsProps {
  list: readonly Attachment[]
  onRemove(id: number): void
}

export function Attachments({ list, onRemove }: AttachmentsProps) {
  const t = useT()
  const sizeOf = (a: Attachment) =>
    a.status === 'uploading' ? t('file.uploading') : a.status === 'error' ? t('file.failed') : sizeText(a.size, t)
  return (
    <div className={classNames('attachments', list.length > 0 && 'has')} id="attachments">
      {list.map(a => (
        <div key={a.id} className={`attachment ${a.status}`} data-id={a.id} title={a.name}>
          {a.image ? (
            <img src={a.url} alt="" />
          ) : (
            <span className="file-icon">
              <FileGlyph />
            </span>
          )}
          <span className="att-text">
            <span className="att-name">{a.name}</span>
            <span className="att-size">{sizeOf(a)}</span>
          </span>
          <button
            type="button"
            className="att-remove"
            title={t('file.remove')}
            aria-label={t('file.remove')}
            onClick={() => onRemove(a.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
