// The toolbar's quiet "Wake stopped" (#119), beside "Setup incomplete" and drawn as it is: only
// while wake is on and has not run for more than a minute (models/wake.ts noteShown); a press
// opens Settings → Sleep and wake…. Never on a phone, which cannot change it.
import { useT } from '../../i18n/I18nProvider.tsx'
import { remotePage } from '../../models/remote-page.ts'
import { isWakeView, noteShown } from '../../models/wake.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'

export function WakeNote({ onOpen }: { onOpen(): void }) {
  const t = useT()
  const { data, now } = useBoardContext()
  if (remotePage() || !noteShown(isWakeView(data?.wake) ? data.wake : undefined, now)) return null
  return (
    <button
      type="button"
      className="setup-note wake-note"
      id="wake-note"
      title={t('wake.stoppedHint')}
      onClick={onOpen}
    >
      <span className="setup-dot" aria-hidden="true" />
      <span>{t('wake.stopped')}</span>
    </button>
  )
}
