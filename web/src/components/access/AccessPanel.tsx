// The Remote access panel, opened from Settings → Remote access… on the local board only (never on
// a page through Tailscale or the domain), built like the Phones panel: the board through the
// owner's own domain, its Tunnel part (TunnelSection.tsx), then its Login (LoginSection.tsx) and
// Active logins (LoginsSection.tsx) parts. Its view is the local-only GET /api/access
// (hooks/useAccess.ts), fetched on opening and again whenever the payload's accessRev changes;
// every change is a POST to the same local-only route, and what the board refuses is toasted.
import { useState } from 'react'
import type { AccessView } from '../../../../src/core/access.ts'
import type { TestStep } from '../../../../src/core/tunnel.ts'
import { type AccessSend, useAccess } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type AccessAsk, loginAsk, tunnelAsk } from '../../models/access.ts'
import { Panel } from '../panel/Panel.tsx'
import { LoginSection } from './LoginSection.tsx'
import { LoginsSection } from './LoginsSection.tsx'
import { TunnelSection } from './TunnelSection.tsx'

export interface AccessPanelProps {
  open: boolean
  onClose(): void
}

export interface AccessBodyProps {
  view: AccessView
  send: AccessSend
  steps: TestStep[] | null
  testing: boolean
}

export function AccessPanel({ open, onClose }: AccessPanelProps) {
  const t = useT()
  const { view, send, steps, testing } = useAccess(open)
  return (
    <Panel
      id="access-sheet"
      kind="access"
      open={open}
      onClose={onClose}
      title={
        <>
          <h2>{t('access.title')}</h2>
          <p className="sheet-meta">{t('access.about')}</p>
        </>
      }
    >
      {view ? (
        // Drawn anew as the panel closes: what it had open or asked goes, the code's secret with it.
        <AccessBody key={open ? 'open' : 'closed'} view={view} send={send} steps={steps} testing={testing} />
      ) : (
        <div className="sheet-body cats-body access-body">
          <p className="sheet-meta">{t('access.loading')}</p>
        </div>
      )}
    </Panel>
  )
}

/** The panel's body for a given view (what the tests draw). */
export function AccessBody({ view, send, steps, testing }: AccessBodyProps) {
  // What the panel has open or asks before it sends (a new key, a new domain, the password form,
  // the code's setup, a second click to remove or end): one thing at a time.
  const [ask, setAsk] = useState<AccessAsk>(null)
  return (
    <div className="sheet-body cats-body access-body">
      <TunnelSection view={view} send={send} steps={steps} testing={testing} ask={tunnelAsk(ask)} onAsk={setAsk} />
      <LoginSection view={view} send={send} ask={loginAsk(ask)} onAsk={setAsk} />
      <LoginsSection view={view} send={send} ask={loginAsk(ask)} onAsk={setAsk} />
    </div>
  )
}
