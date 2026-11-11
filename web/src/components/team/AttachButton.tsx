// The Team box's paper clip (#371): picks files to go with the next message. A paste into the box
// and a drop on the thread take files too (TeamThread.tsx).
import { useRef } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'

export function AttachButton({ disabled, onFiles }: { disabled: boolean; onFiles(files: File[]): void }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        className="team-icon-button"
        data-attach
        disabled={disabled}
        title={t('team.attach')}
        aria-label={t('team.attachLabel')}
        onClick={() => input.current?.click()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10.5 4.5L5.4 9.6a1.5 1.5 0 0 0 2.1 2.1l5.3-5.3a3 3 0 0 0-4.2-4.2L3.3 7.5a4.5 4.5 0 0 0 6.4 6.4L13 10.6" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={e => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </>
  )
}
