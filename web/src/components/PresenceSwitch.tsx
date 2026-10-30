// The toolbar's presence switch (#172): "At the computer" or "Away", a press flips it; "On a call"
// (#276), a press ends it. In mode 'suggest' detection's offer shows beside it as a second button;
// where MokuPilot runs, a phone button beside it puts the user on a call by hand. Only while
// presence is on (models/presence.ts), so a board that never turned it on shows nothing new. On a
// phone too: the phone is where the user says they left.
import { useState } from 'react'
import type { PresenceState } from '../../../src/core/presence.ts'
import { api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { presenceBody, presenceSwitch } from '../models/presence.ts'
import { remotePage } from '../models/remote-page.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { PhoneIcon } from './icons.tsx'

export function PresenceSwitch() {
  const t = useT()
  const { data, toast } = useBoardContext()
  const [busy, setBusy] = useState(false)
  const view = presenceSwitch(data?.presence, t)
  if (!view) return null
  const send = async (state: PresenceState) => {
    setBusy(true)
    try {
      await api.post('/api/presence', presenceBody(state, remotePage()))
    } catch (err) {
      toast(errorText(err, t), true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className="setup-note presence-switch"
        id="presence-switch"
        data-state={view.state}
        aria-pressed={view.state !== 'here'}
        disabled={busy}
        title={view.hint}
        onClick={() => void send(view.next)}
      >
        <span className="setup-dot" aria-hidden="true" />
        <span>{view.label}</span>
      </button>
      {view.offer && (
        <button
          type="button"
          className="setup-note presence-offer"
          id="presence-offer"
          disabled={busy}
          onClick={() => view.offer && void send(view.offer.state)}
        >
          {view.offer.text}
        </button>
      )}
      {view.call && (
        <button
          type="button"
          className="setup-note presence-call"
          id="presence-call"
          disabled={busy}
          title={view.call}
          aria-label={view.call}
          onClick={() => void send('call')}
        >
          <PhoneIcon />
        </button>
      )}
    </>
  )
}
