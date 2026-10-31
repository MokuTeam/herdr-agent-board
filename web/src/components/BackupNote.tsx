// The backup's note in the toolbar (#233): there only while something is wrong with the backup of
// the board's database (the payload's `backup.problem`: a short code, never an ssh error's text,
// which stays on this computer), on every page, a phone's and the remote page's too. A click opens
// Settings → Backup… on the board on this computer; elsewhere the note says what is wrong, and
// the backup is put right on the computer itself.
import { useT } from '../i18n/I18nProvider.tsx'
import { backupNoteText } from '../models/backup.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

export function BackupNote({ onOpen }: { onOpen?: (() => void) | undefined }) {
  const t = useT()
  const { data, toast } = useBoardContext()
  const problem = data?.backup?.problem
  if (!problem) return null
  const text = backupNoteText(problem, t)
  return (
    <button
      type="button"
      className="setup-note backup-note-bar"
      id="backup-note"
      title={text}
      aria-label={text}
      onClick={() => (onOpen ? onOpen() : toast(text, true))}
    >
      <span className="setup-dot" aria-hidden="true" />
      <span>{t('backup.noteLabel')}</span>
    </button>
  )
}
