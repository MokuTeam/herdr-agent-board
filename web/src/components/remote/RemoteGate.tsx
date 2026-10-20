// The board in a phone's browser (src/core/pwa.ts) before the board itself: a browser that is
// not paired asks for access and waits until the computer approves it (Settings → Phones…), as
// the app does; then its cookie carries the token and the board shows. No connection to the
// computer: a screen that says what to check, and tries again by itself.
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useLanguage, useT } from '../../i18n/I18nProvider.tsx'
import {
  type CheckResult,
  type Gate,
  gateAfter,
  helloOf,
  keepLanguage,
  type PairStep,
  type PhoneHello,
  pairName,
  pollStep,
  UNPAIRED,
} from '../../models/remote-page.ts'

const POLL_MS = 1500
const RETRY_MS = 15_000

/** The board once this browser is paired; the pairing or offline screen until then. */
export function RemoteGate({ children }: { children: ReactNode }) {
  const { follow } = useLanguage()
  const [gate, setGate] = useState<Gate>('checking')
  const [hello, setHello] = useState<PhoneHello | null>(null)
  const followRef = useRef(follow)
  followRef.current = follow
  const gateRef = useRef(gate)
  gateRef.current = gate
  const retryCheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const check = useCallback(async () => {
    let result: CheckResult = 'unreachable'
    try {
      const res = await fetch('/api/hello', { cache: 'no-store' })
      const h = helloOf(await res.json().catch(() => null))
      if (h) {
        setHello(h)
        if (h.language) {
          keepLanguage(h.language)
          followRef.current(h.language)
        }
        result = h.paired ? 'paired' : 'unpaired'
      } else if (res.status === 403) result = 'refused'
    } catch {}
    const next = gateAfter(gateRef.current, result)
    // The board stayed through a check that got no answer: the next one comes by itself.
    clearTimeout(retryCheck.current)
    if (next === 'board' && (result === 'unreachable' || result === 'refused'))
      retryCheck.current = setTimeout(() => void check(), RETRY_MS / 3)
    gateRef.current = next
    setGate(next)
  }, [])

  useEffect(() => {
    void check()
    // Unpaired on the computer while the page was away, or the stream said so: ask again.
    const visible = () => {
      if (!document.hidden) void check()
    }
    const again = () => void check()
    addEventListener(UNPAIRED, again)
    addEventListener('online', again)
    addEventListener('pageshow', again)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(retryCheck.current)
      removeEventListener(UNPAIRED, again)
      removeEventListener('online', again)
      removeEventListener('pageshow', again)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [check])

  useEffect(() => {
    if (gate !== 'offline') return
    const timer = setInterval(() => void check(), RETRY_MS)
    return () => clearInterval(timer)
  }, [gate, check])

  if (gate === 'board') return children
  if (gate === 'checking') return <div className="phone-screen" aria-busy="true" />
  if (gate === 'pair') return <PairScreen computer={hello?.name || hello?.host || ''} onPaired={check} />
  return <OfflineScreen refused={gate === 'refused'} computer={hello?.name ?? ''} onRetry={check} />
}

function AppIcon() {
  return <img className="phone-icon" src="icon.svg" alt="" width={72} height={72} />
}

const standalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

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

function OfflineScreen({ refused, computer, onRetry }: { refused: boolean; computer: string; onRetry: () => void }) {
  const t = useT()
  return (
    <main className="phone-screen">
      <div className="phone-card">
        <AppIcon />
        <h1>{t('offline.title')}</h1>
        <p>{refused ? t('pair.refused') : t('offline.about', { computer: computer || t('offline.computer') })}</p>
        <button type="button" className="button primary phone-action" onClick={onRetry}>
          {t('offline.retry')}
        </button>
      </div>
    </main>
  )
}
