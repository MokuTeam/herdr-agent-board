// The quiet setup note in the toolbar: there only while something the board needs does not work
// on this computer (hooks/useSetupNote.ts). A click opens the list (SetupPop.tsx).

import type { SetupNoteState } from '../hooks/useSetupNote.ts'
import { useT } from '../i18n/I18nProvider.tsx'

export function SetupNote({ setup }: { setup: SetupNoteState }) {
  const t = useT()
  const label = t('setup.incomplete')
  return (
    <button
      type="button"
      className="setup-note"
      id="setup-note"
      aria-haspopup="dialog"
      aria-expanded={setup.open}
      aria-controls="setup-pop"
      hidden={!setup.shown}
      ref={setup.noteRef}
      onClick={setup.toggle}
      {...(setup.shown && { title: t('setup.incompleteHint'), 'aria-label': label })}
    >
      {setup.shown && (
        <>
          <span className="setup-dot" aria-hidden="true" />
          <span>{label}</span>
        </>
      )}
    </button>
  )
}
