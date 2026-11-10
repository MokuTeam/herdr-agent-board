// The owner's confirmation window (#224), on http://localhost:<port>/?confirm=<id> (main.tsx draws
// it there instead of the board). It shows what the board holds back, in the board's own words
// (GET /api/team/confirm/<id>: names from the roster, the text as it will go), and does it once the
// owner signs with a passkey: navigator.credentials.get, or .create for a passkey being added
// (the first one, or a later one after an assertion by one there is). The answer goes to POST
// /api/team/confirm/<id>, and what the action answered to the page that opened this window
// (models/team-confirm.ts), which is all it ever learns.
import { useEffect, useState } from 'react'
import type { Translator } from '../../../../src/core/types.ts'
import { isReply, postJson, type Reply, replyOf } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { assertionJson, attestationJson, creationOptions, requestOptions } from '../../models/passkey.ts'
import { confirmed } from '../../models/team-confirm.ts'

/** Where passkeys are made and used (navigator.credentials). */
export type PasskeyCredentials = Pick<CredentialsContainer, 'get' | 'create'>

/** What the window says is being confirmed, from the board's description of the action. */
export interface ConfirmLines {
  title: string
  /** One line per thing the change does: every field of it, none left out. */
  items?: string[]
  /** The text that goes out, shown as it will go. */
  text?: string
  note?: string
}

/** The lines that say what is being confirmed, from the board's description of the action. */
export function confirmLines(a: Reply, t: Translator): ConfirmLines {
  const who = typeof a.who === 'string' ? a.who : null
  const unlocks = t('team.confirm.unlocks')
  switch (a.kind) {
    case 'send': {
      const where = [
        typeof a.thread === 'string' ? t('team.confirm.thread', { title: a.thread }) : null,
        typeof a.link === 'string' ? t('team.confirm.link', { link: a.link }) : null,
      ].filter((x): x is string => x !== null)
      return {
        title: who ? t('team.confirm.send', { who }) : t('team.confirm.sendTeam'),
        ...(typeof a.text === 'string' && { text: a.text }),
        ...(where.length && { items: where }),
        note: unlocks,
      }
    }
    case 'draft':
      return {
        title: who ? t('team.confirm.draft', { who }) : t('team.confirm.draftTeam'),
        ...(typeof a.text === 'string' && { text: a.text }),
        note: unlocks,
      }
    case 'trust':
      return {
        title: t('team.confirm.trust', { who: who ?? '' }),
        ...(typeof a.fingerprint === 'string' && { note: t('team.fingerprint', { fingerprint: a.fingerprint }) }),
      }
    case 'agents': {
      const items: string[] = []
      if (a.allOn === true) items.push(t('team.confirm.item.allOn'))
      if (typeof a.listener === 'string') items.push(t('team.confirm.item.listener', { session: a.listener }))
      if (a.on === true) items.push(t('team.confirm.item.on'))
      if (a.on === false) items.push(t('team.confirm.item.off'))
      if (Array.isArray(a.lanes))
        items.push(
          a.lanes.length
            ? t('team.confirm.item.lanes', { lanes: a.lanes.map(String).join(', ') })
            : t('team.confirm.item.noLanes'),
        )
      if (typeof a.loop === 'number') items.push(t('team.confirm.item.loop', { n: a.loop }))
      if (a.loop === null) items.push(t('team.confirm.item.loopDefault'))
      if (a.muted === true) items.push(t('team.confirm.item.muted'))
      if (a.muted === false) items.push(t('team.confirm.item.unmuted'))
      const title = who
        ? t('team.confirm.agentsFor', { who })
        : a.team === true
          ? t('team.confirm.agentsTeam')
          : t('team.confirm.agentsBoard')
      return { title, items: items.length ? items : [t('team.confirm.unknown')] }
    }
    case 'passkey-add':
      return { title: t('team.confirm.add') }
    case 'passkey-remove':
      return { title: t('team.confirm.remove', { label: typeof a.label === 'string' ? a.label : '' }) }
    default:
      return { title: t('team.confirm.unknown') }
  }
}

interface Read {
  action: Reply
  step: 'get' | 'create'
  options: unknown
}
const isRead = (v: unknown): v is Read =>
  isReply(v) && isReply(v.action) && (v.step === 'get' || v.step === 'create') && isReply(v.options)

type State =
  | { at: 'reading' }
  | { at: 'ready'; read: Read; busy: boolean; note: string | null }
  | { at: 'done' }
  | { at: 'gone'; why: string }

export function ConfirmScreen({
  id,
  credentials = () => navigator.credentials,
}: {
  id: string
  credentials?: () => PasskeyCredentials
}) {
  const t = useT()
  const [state, setState] = useState<State>({ at: 'reading' })
  const path = `/api/team/confirm/${id}`

  async function read(): Promise<void> {
    const res = await fetch(path, { cache: 'no-store' }).catch(() => null)
    const value = res ? await replyOf(res) : null
    if (res?.ok && isRead(value)) return setState({ at: 'ready', read: value, busy: false, note: null })
    const error = isReply(value) ? value.error : null
    setState({ at: 'gone', why: error === 'passkey' ? t('team.confirm.noPasskey') : t('team.confirm.gone') })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, when the window opens
  useEffect(() => {
    void read()
  }, [])

  async function sign(r: Read): Promise<void> {
    setState({ at: 'ready', read: r, busy: true, note: null })
    let body: Record<string, unknown>
    try {
      if (r.step === 'create') {
        const options = creationOptions(r.options)
        const cred = options && ((await credentials().create({ publicKey: options })) as PublicKeyCredential | null)
        if (!cred) throw new Error('none')
        body = attestationJson(cred)
      } else {
        const options = requestOptions(r.options)
        const cred = options && ((await credentials().get({ publicKey: options })) as PublicKeyCredential | null)
        if (!cred) throw new Error('none')
        body = assertionJson(cred)
      }
    } catch {
      return setState({ at: 'ready', read: r, busy: false, note: t('team.confirm.notSigned') })
    }
    const res = await postJson(path, body).catch(() => null)
    const value = res ? await replyOf(res) : {}
    const reply = isReply(value) ? value : {}
    // A passkey add confirmed by one there is: next, the new passkey.
    if (res?.ok && reply.done === false) return read()
    if (!res || reply.done !== true) {
      // The confirmation was refused (offline, a wrong passkey, too late): a fresh read gives a
      // fresh challenge to try again with, or says the action is gone.
      if (res?.status === 404) return setState({ at: 'gone', why: t('team.confirm.gone') })
      const note = t('team.confirm.refused', { why: String(reply.error ?? 'offline') })
      await read()
      return setState(s => (s.at === 'ready' ? { ...s, note } : s))
    }
    // Confirmed: what the action answered goes to the page that asked, the unlock with it.
    const { unlock, ...rest } = reply
    confirmed({ id, status: res.status, reply: rest, ...(typeof unlock === 'string' && { unlock }) }, location.port)
    // Confirmed, but the board could not do it (the person gone from the team, say): said here,
    // and the window stays for the owner to read.
    if (!res.ok)
      return setState({ at: 'gone', why: t('team.confirm.failed', { why: String(reply.error ?? res.status) }) })
    setState({ at: 'done' })
    setTimeout(() => window.close(), 800)
  }

  if (state.at === 'reading') return <p className="phone-note">{t('team.confirm.reading')}</p>
  if (state.at === 'gone') return <p className="phone-note">{state.why}</p>
  if (state.at === 'done') return <p className="phone-note">{t('team.confirm.done')}</p>
  const lines = confirmLines(state.read.action, t)
  return (
    <main className="team-confirm">
      <h1 className="team-confirm-title">{lines.title}</h1>
      {lines.items && (
        <ul className="team-confirm-items">
          {lines.items.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {lines.text !== undefined && <pre className="team-confirm-text">{lines.text}</pre>}
      {lines.note && <p className="team-confirm-note">{lines.note}</p>}
      {state.note && (
        <p className="team-confirm-note" role="alert">
          {state.note}
        </p>
      )}
      <div className="team-confirm-actions">
        <button type="button" className="button primary" disabled={state.busy} onClick={() => void sign(state.read)}>
          {state.read.step === 'create' ? t('team.confirm.create') : t('team.confirm.sign')}
        </button>
        <button type="button" className="button" onClick={() => window.close()}>
          {t('team.confirm.cancel')}
        </button>
      </div>
    </main>
  )
}
