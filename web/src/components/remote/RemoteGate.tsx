// The board in a phone's browser (src/core/pwa.ts) before the board itself: a browser that is
// not paired asks for access and waits until the computer approves it (Settings → Phones…), as
// the app does; then its cookie carries the token and the board shows. Through the owner's own
// domain (src/core/tunnel.ts) hello says `auth: 'login'` instead: the login screen
// (LoginScreen.tsx) until this browser is signed in. No connection to the computer: a screen that
// says what to check, and tries again by itself.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Translator } from '../../../../src/core/types.ts'
import { useLanguage, useT } from '../../i18n/I18nProvider.tsx'
import { passkeysHere } from '../../models/passkey.ts'
import {
  type CheckResult,
  type Gate,
  gateAfter,
  helloOf,
  keepAuth,
  keepLanguage,
  keptAuth,
  type PairStep,
  type PhoneHello,
  pairName,
  pollStep,
  standalone,
  UNPAIRED,
} from '../../models/remote-page.ts'
import { Store, useStore } from '../../state/store.ts'
import { LoginCard, type LoginDeps, type LoginFlow, type LoginState, loginFlow } from './LoginScreen.tsx'

/** Where the gate stands, and what the last hello said. */
export interface GateNow {
  gate: Gate
  hello: PhoneHello | null
}

export interface GateFlow {
  view: Store<GateNow>
  /** The login screen's own steps. */
  login: LoginFlow
  /** Asks the board what this browser may see (GET /api/hello). */
  check(): Promise<void>
  /** Checks now, and again as the page comes back or hears it was unpaired; offline, every so often. Returns how to stop. */
  start(): () => void
}

const POLL_MS = 1500
const RETRY_MS = 15_000

/** The gate's steps: hello asked, and what its answer opens. */
export function gateFlow(deps: { follow(lang: string): void; credentials?: LoginDeps['credentials'] }): GateFlow {
  const view = new Store<GateNow>({ gate: 'checking', hello: null })
  const login = loginFlow({ signedIn: () => void check(), ...(deps.credentials && { credentials: deps.credentials }) })

  const gateOf = (h: PhoneHello): Gate => {
    if (h.auth === 'pair') return h.paired ? 'board' : 'pair'
    if (!h.signedIn) {
      // Not signed in, or no longer (Sign out, a login ended on the computer): from the start,
      // unless this is the login screen already up, with what was typed into it.
      if (view.get().gate !== 'login' || login.view.get().step !== 'start') login.reset()
      return 'login'
    }
    // Signed in: the board, unless the offer of a passkey is still up (its next code is read in
    // another app, and the page shown again asks hello again).
    return login.offering() ? 'login' : 'board'
  }

  // While started: the board on show stays through a check that got no answer or a refusal, and
  // the next check comes by itself (gateAfter, #108).
  let started = false
  let retry: ReturnType<typeof setTimeout> | undefined

  const check = async (): Promise<void> => {
    let res: Response | null = null
    let h: PhoneHello | null = null
    try {
      res = await fetch('/api/hello', { cache: 'no-store' })
      h = helloOf(await res.json().catch(() => null))
    } catch {}
    clearTimeout(retry)
    if (!h) {
      const result: CheckResult = res?.status === 403 ? 'refused' : 'unreachable'
      const next = gateAfter(view.get().gate, result)
      if (next === 'board' && started) retry = setTimeout(() => void check(), RETRY_MS / 3)
      return view.set({ gate: next, hello: view.get().hello })
    }
    if (h.language) {
      keepLanguage(h.language)
      deps.follow(h.language)
    }
    keepAuth(h.auth)
    // Before the board draws: what it offers on the computer's screen reads it (deskPage).
    document.documentElement.toggleAttribute?.('data-desk', h.desk)
    if (h.device) document.documentElement.setAttribute?.('data-device', h.device)
    else document.documentElement.removeAttribute?.('data-device')
    view.set({ gate: gateOf(h), hello: h })
  }

  return {
    view,
    login,
    check,
    start() {
      started = true
      void check()
      // Unpaired on the computer while the page was away, the stream said so, or Sign out: ask again.
      const visible = () => {
        if (!document.hidden) void check()
      }
      const again = () => void check()
      addEventListener(UNPAIRED, again)
      addEventListener('online', again)
      addEventListener('pageshow', again)
      document.addEventListener('visibilitychange', visible)
      const timer = setInterval(() => {
        if (view.get().gate === 'offline') void check()
      }, RETRY_MS)
      return () => {
        started = false
        clearTimeout(retry)
        removeEventListener(UNPAIRED, again)
        removeEventListener('online', again)
        removeEventListener('pageshow', again)
        document.removeEventListener('visibilitychange', visible)
        clearInterval(timer)
      }
    },
  }
}

/** The board once this browser is paired or signed in; the pairing, login or offline screen until then. */
export function RemoteGate({ children }: { children: ReactNode }) {
  const t = useT()
  const { follow } = useLanguage()
  const followRef = useRef(follow)
  followRef.current = follow
  const [gate] = useState(() => gateFlow({ follow: lang => followRef.current(lang) }))
  const now = useStore(gate.view)
  const login = useStore(gate.login.view)
  useEffect(() => gate.start(), [gate])
  return (
    <GateView now={now} login={login} on={gate} t={t}>
      {children}
    </GateView>
  )
}

export interface GateViewProps {
  now: GateNow
  login: LoginState
  on: Pick<GateFlow, 'check' | 'login'>
  t: Translator
  children: ReactNode
}

/** What the gate shows for where it stands. */
export function GateView({ now, login, on, t, children }: GateViewProps) {
  const { gate, hello } = now
  if (gate === 'board') return children
  if (gate === 'checking') return <div className="phone-screen" aria-busy="true" />
  if (gate === 'pair') return <PairScreen computer={hello?.name || hello?.host || ''} onPaired={on.check} />
  if (gate === 'login')
    return (
      <main className="phone-screen">
        <div className="phone-card">
          <AppIcon />
          <LoginCard state={login} t={t} passkeys={passkeysHere()} on={on.login} />
        </div>
        {!standalone() && <p className="phone-foot">{t('pair.install')}</p>}
      </main>
    )
  return (
    <OfflineScreen
      refused={gate === 'refused'}
      domain={keptAuth() === 'login'}
      computer={hello?.name ?? ''}
      onRetry={on.check}
    />
  )
}

function AppIcon() {
  return <img className="phone-icon" src="icon.svg" alt="" width={72} height={72} />
}

function PairScreen({ computer, onPaired }: { computer: string; onPaired: () => void }) {
  const t = useT()
  const [state, setState] = useState<PairStep>({ step: 'idle' })
  const name = computer || t('offline.computer')

  useEffect(() => {
    if (state.step !== 'waiting') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/remote/pair/${state.id}`, { cache: 'no-store' })
        const next = pollStep(await res.json())
        if (stopped) return
        if (next?.step === 'paired') return onPaired()
        if (next) return setState(next)
      } catch {
        // A moment without the network: the request still waits on the computer.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [state, onPaired])

  async function ask() {
    setState({ step: 'asking' })
    try {
      const res = await fetch('/api/remote/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify({ name: pairName(navigator.userAgent) }),
      })
      const body = (await res.json().catch(() => ({}))) as { id?: unknown; error?: unknown }
      if (res.status === 202 && typeof body.id === 'string') return setState({ step: 'waiting', id: body.id })
      if (res.status === 429) return setState({ step: 'busy' })
      setState({ step: 'failed', why: String(body.error ?? res.status) })
    } catch (err) {
      setState({ step: 'failed', why: err instanceof Error ? err.message : String(err) })
    }
  }

  const waiting = state.step === 'waiting' || state.step === 'asking'
  const note =
    state.step === 'denied'
      ? t('pair.denied', { computer: name })
      : state.step === 'expired'
        ? t('pair.expired')
        : state.step === 'busy'
          ? t('pair.busy')
          : state.step === 'failed'
            ? t('pair.failed', { why: state.why })
            : null
  return (
    <main className="phone-screen">
      <div className="phone-card">
        <AppIcon />
        <h1>{waiting ? t('pair.waiting') : t('pair.title')}</h1>
        <p>{waiting ? t('pair.waitingHow', { computer: name }) : t('pair.about', { computer: name })}</p>
        {note && (
          <p className="phone-note" role="status">
            {note}
          </p>
        )}
        {waiting ? (
          <>
            <span className="phone-spinner" role="progressbar" aria-label={t('pair.waiting')} />
            <button type="button" className="button phone-action" onClick={() => setState({ step: 'idle' })}>
              {t('pair.cancel')}
            </button>
          </>
        ) : (
          <button type="button" className="button primary phone-action" onClick={() => void ask()}>
            {state.step === 'idle' ? t('pair.ask') : t('pair.again')}
          </button>
        )}
      </div>
      {!standalone() && <p className="phone-foot">{t('pair.install')}</p>}
    </main>
  )
}

/** No connection, or not let in; through the domain (`domain`) the texts say nothing of Tailscale. */
function OfflineScreen({
  refused,
  domain,
  computer,
  onRetry,
}: {
  refused: boolean
  domain: boolean
  computer: string
  onRetry: () => void
}) {
  const t = useT()
  const about = refused
    ? t(domain ? 'login.refused' : 'pair.refused')
    : domain
      ? t('offline.aboutDomain')
      : t('offline.about', { computer: computer || t('offline.computer') })
  return (
    <main className="phone-screen">
      <div className="phone-card">
        <AppIcon />
        <h1>{t('offline.title')}</h1>
        <p>{about}</p>
        <button type="button" className="button primary phone-action" onClick={onRetry}>
          {t('offline.retry')}
        </button>
      </div>
    </main>
  )
}
