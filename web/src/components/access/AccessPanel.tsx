// The Remote access panel, opened from Settings → Remote access… on the local board only (never on
// a page through Tailscale or the domain), built like the Phones panel: the board through the
// owner's own domain, in four tabs. Tunnel (TunnelSection.tsx): where it stands, On or Off, Test
// connection, the board's address, its other settings and keys folded. Server (ServerSetup.tsx):
// the server's login once, shared by every server action on every tab, then the tunnel on the
// server and the board on the server, each in its card. Sync (ServerSync, ProfileSync.tsx): the
// Claude profiles with the board on the server. Login & devices (LoginSection.tsx,
// LoginsSection.tsx): the board's own login, its passkeys, the active logins and failed sign-ins.
// Every tab stays drawn while the panel is open, the others hidden: what one has typed or open
// stays as it was when it is picked again. The tab last picked is this browser's
// (models/access-tabs.ts). Its view is the local-only GET /api/access (hooks/useAccess.ts),
// fetched on opening and again whenever the payload's accessRev changes; every change is a POST to
// the same local-only route, and what the board refuses is toasted.
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import type { AccessView } from '../../../../src/core/access.ts'
import type { TestStep } from '../../../../src/core/tunnel.ts'
import { type AccessSend, useAccess } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { type AccessAsk, loginAsk, tunnelAsk } from '../../models/access.ts'
import { ACCESS_TABS, type AccessTab, loadTab, saveTab } from '../../models/access-tabs.ts'
import { savesTracker } from '../../models/server-setup.ts'
import { classNames } from '../class-names.ts'
import { Panel } from '../panel/Panel.tsx'
import { LoginSection } from './LoginSection.tsx'
import { LoginsSection } from './LoginsSection.tsx'
import { ServerSetupBody, ServerSync, useServerSetup } from './ServerSetup.tsx'
import { TunnelEntry, TunnelSection } from './TunnelSection.tsx'

export interface AccessPanelProps {
  open: boolean
  onClose(): void
}

export interface AccessBodyProps {
  view: AccessView
  send: AccessSend
  steps: TestStep[] | null
  testing: boolean
  /** The tab it opens on; the one last picked in this browser when none is given. */
  tab?: AccessTab
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
export function AccessBody({ view, send, steps, testing, tab: first }: AccessBodyProps) {
  const t = useT()
  // What the panel has open or asks before it sends (a new key, a new domain, the password form,
  // the code's setup, a second click to remove or end): one thing at a time.
  const [ask, setAsk] = useState<AccessAsk>(null)
  const [tab, setTab] = useState<AccessTab>(() => first ?? loadTab())
  // The settings' saves on their way, which the Server tab's Set up waits for, whichever tab made them.
  const [saves] = useState(savesTracker)
  const keep = useServerSetup(view, send, saves)

  const pick = (next: AccessTab): void => {
    setTab(next)
    saveTab(next)
  }
  /** The arrows, Home and End move between the tabs, as a tab list's do. */
  const keyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = ACCESS_TABS.indexOf(tab)
    const to =
      e.key === 'ArrowRight'
        ? (at + 1) % ACCESS_TABS.length
        : e.key === 'ArrowLeft'
          ? (at + ACCESS_TABS.length - 1) % ACCESS_TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? ACCESS_TABS.length - 1
              : -1
    const next = ACCESS_TABS[to]
    if (!next) return
    e.preventDefault()
    pick(next)
    ;(e.currentTarget.querySelector(`#access-tab-${next}`) as HTMLElement | null)?.focus()
  }
  const pane = (name: AccessTab, children: ReactNode) => (
    <div
      role="tabpanel"
      id={`access-pane-${name}`}
      aria-labelledby={`access-tab-${name}`}
      className={classNames('access-pane', `access-pane-${name}`)}
      hidden={tab !== name}
    >
      {children}
    </div>
  )
  // The server and its port: the tunnel's settings, at the top of the Server tab's login.
  const serverFields = (
    <div className="access-pair">
      <TunnelEntry view={view} send={send} saves={saves} field="host" label={t('server.panel.host')} />
      <TunnelEntry view={view} send={send} saves={saves} field="sshPort" label={t('server.panel.sshPort')} />
    </div>
  )

  return (
    <div className="sheet-body cats-body access-body">
      <div className="access-tabs" role="tablist" aria-label={t('access.title')} onKeyDown={keyDown}>
        {ACCESS_TABS.map(name => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`access-tab-${name}`}
            aria-controls={`access-pane-${name}`}
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            className={classNames('access-tab', tab === name && 'active')}
            onClick={() => pick(name)}
          >
            {t(`access.tab.${name}`)}
          </button>
        ))}
      </div>
      {pane(
        'tunnel',
        <TunnelSection
          view={view}
          send={send}
          steps={steps}
          testing={testing}
          ask={tunnelAsk(ask)}
          onAsk={setAsk}
          saves={saves}
        />,
      )}
      {pane(
        'server',
        <section className="access-server">
          <ServerSetupBody
            view={view}
            send={send}
            steps={steps}
            testing={testing}
            fields={serverFields}
            saves={saves}
            state={keep.state}
            onState={keep.onState}
            now={keep.now}
          />
        </section>,
      )}
      {pane(
        'sync',
        <section className="access-sync-tab">
          <ServerSync view={view} send={send} state={keep.state} />
        </section>,
      )}
      {pane(
        'login',
        <>
          <LoginSection view={view} send={send} ask={loginAsk(ask)} onAsk={setAsk} />
          <LoginsSection view={view} send={send} ask={loginAsk(ask)} onAsk={setAsk} />
        </>,
      )}
    </div>
  )
}
