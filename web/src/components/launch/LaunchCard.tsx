// A session on its way, on the board: the card of a launch that is not a session yet (inside the
// board's <article class="card launch-card">), and the lines a launch adds to a card — how it
// goes, or why it failed and what to do. Their buttons are the board's card clicks
// (hooks/useLaunch.ts launchCards reads their data-launch).
import type { LaunchView, Translator } from '../../../../src/core/types.ts'
import { failureHint, launchWhere, needsYou, retries, stepText } from '../../models/launch.ts'
import { WaitIcon, WarnIcon } from '../icons.tsx'

/** What a card's launch lines need besides the launch: the texts, the command's name, the buttons pressed. */
export interface LaunchLook {
  t: Translator
  /** The command's name for its step ("Starting with {name}…"). */
  launcher: string
  /** A trust or close button was pressed for this launch as it is now: it stays off. */
  pressed(what: 'trust' | 'closeTab', l: LaunchView): boolean
}

/** The card of a launch that is not a session on the board yet ("back": one back from the archive). */
export function LaunchCard({ launch: l, look }: { launch: LaunchView; look: LaunchLook }) {
  const { t } = look
  return (
    <>
      <div className="card-top">
        {needsYou(l) ? (
          <span className="dot" style={{ '--c': 'var(--orange)' }} />
        ) : (
          <span className="dot work launching" style={{ '--c': 'var(--green)' }} />
        )}
        <span className="name">{l.name}</span>
        <span className="age">{t(l.resume ? 'archive.returnLabel' : l.fork ? 'fork.label' : 'launch.new')}</span>
      </div>
      <div className="said" title={l.cwd}>
        {launchWhere(l, t)}
      </div>
      <LaunchNote launch={l} look={look} />
    </>
  )
}

/** How a launch goes, or why it failed and what to do. */
export function LaunchNote({ launch: l, look }: { launch: LaunchView; look: LaunchLook }) {
  const { t } = look
  const go = l.pane ? (
    <button type="button" className="button" data-launch="focus" data-id={l.id}>
      {t('card.focus')}
    </button>
  ) : null
  if (l.state === 'failed')
    return (
      <div className="launch-note failed">
        <Why text={l.error || t('launch.failed')} />
        <div className="ln-hint">{t(failureHint(l))}</div>
        <div className="ln-actions">
          {retries(l) && (
            <button type="button" className="button" data-launch="retry" data-id={l.id}>
              {t('launch.retry')}
            </button>
          )}
          {go}
          <button type="button" className="button plain" data-launch="dismiss" data-id={l.id}>
            {t('launch.dismiss')}
          </button>
        </div>
      </div>
    )
  if (l.state === 'trust') {
    // Claude stopped at "Do you trust this folder?": the folder, and the two ways on.
    const busy = l.step === 'trusting'
    return (
      <div className="launch-note waiting trust">
        <Why text={t('launch.trust.title')} />
        <div className="ln-folder" title={l.cwd}>
          {l.cwd}
        </div>
        <div className="ln-hint">{t('launch.trust.hint')}</div>
        <div className="ln-actions">
          <button
            type="button"
            className="button primary"
            data-launch="trust"
            data-id={l.id}
            disabled={busy || look.pressed('trust', l)}
          >
            {t(busy ? 'launch.step.trusting' : 'launch.trust.go')}
          </button>
          <button
            type="button"
            className="button"
            data-launch="closeTab"
            data-id={l.id}
            disabled={busy || look.pressed('closeTab', l)}
          >
            {t('launch.trust.close')}
          </button>
          {go}
        </div>
      </div>
    )
  }
  if (l.state === 'waiting')
    return (
      <div className="launch-note waiting">
        <Why text={t('launch.step.dialog')} />
        <div className="ln-hint">{t('launch.hint.dialog')}</div>
        <div className="ln-actions">{go}</div>
      </div>
    )
  return (
    <div className="launch-note">
      <span className="ln-spin">
        <WaitIcon />
      </span>
      <span>{stepText(l, t, look.launcher)}</span>
    </div>
  )
}

function Why({ text }: { text: string }) {
  return (
    <div className="ln-why">
      <WarnIcon />
      <span>{text}</span>
    </div>
  )
}
