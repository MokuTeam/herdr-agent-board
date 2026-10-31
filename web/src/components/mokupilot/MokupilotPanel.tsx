// Settings → MokuPilot…, a panel like Phones… and Sleep and wake…, always offered so the mode can
// be changed whether a call is offered or not (with "mokupilot": false it says so): where "Call in
// MokuPilot" starts the call, three choices with a line each (src/core/mokupilot-mode.ts): Auto,
// This machine, The computer you're viewing from. Under Auto, where a call from this very browser
// starts right now and what decided it, as the board answers GET /api/mokupilot; under the link,
// what MokuPilot on the viewer's computer needs. A choice goes to the board at once (POST
// /api/mokupilot), and the panel asks again.
import { useCallback, useEffect, useState } from 'react'
import { api, errorText } from '../../api/client.ts'
import { useLatest } from '../../hooks/useLatest.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  isMokupilotView,
  MOKUPILOT_MODES,
  type MokupilotMode,
  type MokupilotView,
  nowLine,
  whyLine,
} from '../../models/mokupilot.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { Panel } from '../panel/Panel.tsx'

export interface MokupilotPanelProps {
  open: boolean
  onClose(): void
}

export function MokupilotPanel({ open, onClose }: MokupilotPanelProps) {
  const t = useT()
  const { canEdit, toast } = useBoardContext()
  const latest = useLatest({ t, toast })
  const [view, setView] = useState<MokupilotView | null>(null)
  const [saving, setSaving] = useState(false)

  const ask = useCallback(async () => {
    try {
      setView(await api.get('/api/mokupilot', isMokupilotView, { cache: 'no-store' }))
    } catch (err) {
      const { t, toast } = latest.current
      toast(errorText(err, t), true)
    }
  }, [latest])

  // Asked each time it opens: the answer is this browser's, and the mode may have changed by hand.
  useEffect(() => {
    if (open) void ask()
  }, [open, ask])

  const choose = async (mode: MokupilotMode) => {
    if (view?.mode === mode) return
    setSaving(true)
    try {
      await api.post('/api/mokupilot', { mode })
    } catch (err) {
      const { t, toast } = latest.current
      toast(errorText(err, t), true)
    }
    await ask()
    setSaving(false)
  }

  return (
    <Panel
      id="mokupilot-sheet"
      kind="mokupilot"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('mokupilot.title')}</h2>
          <p className="sheet-meta">{t('mokupilot.about')}</p>
        </>
      }
    >
      <MokupilotBody view={view} disabled={!canEdit || !view || saving} onChoose={mode => void choose(mode)} />
    </Panel>
  )
}

export interface MokupilotBodyProps {
  /** GET /api/mokupilot's answer; null while the board is asked. */
  view: MokupilotView | null
  disabled: boolean
  onChoose(mode: MokupilotMode): void
}

/** MokuPilot missing on the board's computer is a warning only when a call from this browser would
 *  start there: This machine is chosen, or Auto picks it. Otherwise it is a plain note. */
function missingMatters(view: MokupilotView): boolean {
  return view.mode === 'local' || (view.mode === 'auto' && view.auto.resolved === 'local')
}

/** The three choices, each with its line; under Auto where a call from this browser starts now. */
export function MokupilotBody({ view, disabled, onChoose }: MokupilotBodyProps) {
  const t = useT()
  return (
    <div className="sheet-body cats-body mokupilot-body">
      {view?.off && <p className="sheet-meta mokupilot-off">{t('mokupilot.offNote')}</p>}
      <div className="mokupilot-modes" role="radiogroup" aria-label={t('mokupilot.about')}>
        {MOKUPILOT_MODES.map(mode => (
          <label className="mokupilot-mode" key={mode} data-mode={mode}>
            <input
              type="radio"
              name="mokupilot-mode"
              value={mode}
              checked={view?.mode === mode}
              disabled={disabled || !!view?.off}
              onChange={() => onChoose(mode)}
            />
            <span className="mokupilot-mode-text">
              <strong>{t(`mokupilot.mode.${mode}`)}</strong>
              <span className="sheet-meta">{t(`mokupilot.mode.${mode}Line`)}</span>
              {mode === 'auto' && (
                <span className="mokupilot-now" data-resolved={view?.auto.resolved ?? ''}>
                  {nowLine(view, t)}
                  {view && <span className="sheet-meta mokupilot-why">{whyLine(view, t)}</span>}
                </span>
              )}
              {mode === 'link' && <span className="sheet-meta mokupilot-note">{t('mokupilot.linkNote')}</span>}
              {mode === 'local' && view?.here === 'missing' && (
                <span className={`sheet-meta ${missingMatters(view) ? 'mokupilot-missing' : 'mokupilot-note'}`}>
                  {t(missingMatters(view) ? 'mokupilot.hereMissing' : 'mokupilot.hereMissingFine')}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
