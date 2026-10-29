// The board's side of the peer network (#231, core/team.ts): one WebSocket to the team's hub while
// config.json's `team` is set. It joins nothing and launches nothing: what comes in is a question
// from a peer, checked (shape, kind, signature), kept in the inbox, acked with this board's
// signature, and shown; nothing else. This file has no Deps: the herdr adapter, launching, the
// terminals and any process are out of its reach by construction (test/services/
// team-inbound-isolation.test.ts keeps it so). With `team` unset, or not an object with a ws:// or
// wss:// hub, no socket is opened, no timer runs, no file is read or written and view() is null.
import {
  addDraft,
  addInbox,
  addOutbox,
  audit,
  changePins,
  ensureKey,
  type InboxItem,
  markAcked,
  type OutboxItem,
  readAllOutbox,
  readDrafts,
  readInbox,
  readKey,
  readOutbox,
  readPins,
  refuseOut,
  releaseHeld,
  setOutState,
  takeDraft,
} from '../adapters/team-store.ts'
import {
  ackBytes,
  authBytes,
  checkEnvelope,
  checkMessage,
  DEFAULT_TTL_S,
  type Envelope,
  type ErrorCode,
  type Frame,
  fingerprint,
  isMessageId,
  isPeerId,
  MAX_DRAFTS,
  MAX_TEXT,
  type Message,
  type OutState,
  openEnvelope,
  parseFrame,
  type RosterPeer,
  sealEnvelope,
  sign,
  TEAM_PROTOCOL,
  type TeamConfig,
  teamConfig,
  type Via,
  verify,
} from '../core/team.ts'
import { backoffMs } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'
import { type Clock, realClock } from './tunnel.ts'

export type TeamState = 'off' | 'connecting' | 'online' | 'reconnecting' | 'revoked' | 'error'

/** The socket as this service uses it: the global WebSocket's part, so a test can hand in its own. */
export interface WsLike {
  send(text: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
  onerror: ((e: unknown) => void) | null
}

export interface TeamRosterPeer {
  peer: string
  name: string
  online: boolean
  lastSeen: number | null
  fingerprint: string
  pin: 'trusted' | 'changed'
  /** Drafts an agent made for this person that wait for Send or Discard. */
  drafts: number
}

export interface TeamView {
  state: TeamState
  /** error: what went wrong; reconnecting: when the next try is. */
  error?: string
  nextAt?: number
  me: { peer: string | null; fingerprint: string; name: string | null }
  hub: string
  roster: TeamRosterPeer[]
}

/** One line of a thread with a peer, either way. */
export interface ThreadMessage {
  id: string
  /** draft: made by an agent, waiting for the person to press Send (id: the draft's). */
  dir: 'in' | 'out' | 'draft'
  /** null: from a key that changed, not shown until it is trusted. */
  text: string | null
  ts: string
  /** out: how far it got. */
  state?: OutState
  /** out, refused: the hub's error code. */
  code?: ErrorCode
  /** in: from a key that changed, kept back until it is trusted. */
  held?: boolean
  /** in or out: it came from an agent's draft (the mark is in the signed body; it proves no approval, #224). */
  via?: Via
  /**
   * in, via agent: who the sender is called here, from this board's own roster or pins for the verified
   * key (env.from), else the short fingerprint. Never from the message.
   */
  agentOf?: string
}

export type SendResult = { ok: true; id: string } | { ok: false; error: string }

export type DraftResult = { ok: true; id: string } | { ok: false; error: string }

export interface TeamService {
  /** The view, null while `team` is not on in config.json. */
  view(): TeamView | null
  /** The messages with a peer, oldest first; empty while off. */
  thread(peer: string): ThreadMessage[]
  /** A question to a peer in the roster whose key is trusted ('changed' otherwise); kept and sent (again on every reconnect until it is answered by the hub). */
  send(to: string, text: string): Promise<SendResult>
  /** An agent's draft for a person on the roster: kept for the person to Send or Discard, never sent by the service. */
  draft(to: string, text: string): DraftResult
  /** Sends a draft as a question marked `via: "agent"`; the draft stays when the send is refused. */
  sendDraft(id: string): Promise<SendResult>
  /** Drops a draft; false when there is none. */
  discardDraft(id: string): boolean
  /** Releases what was held back from a peer whose key changed, and pins the new key. */
  trust(peer: string): boolean
  /** Changes with every news for the page; null while off. */
  rev(): number | null
  /** config.json changed: connect, reconnect or let go. */
  refresh(): void
  start(): void
  stop(): void
}

interface Options {
  cfg: Pick<Config, 'team'>
  log: (line: string) => void
  /** The board changed: publish it. */
  onChange: () => void
  socket?: (url: string) => WsLike
  clock?: Clock
  random?: () => number
  version?: string
}

/** Up this long: the backoff starts over. */
export const UP_RESETS_MS = 60_000
/** A ping this often while online; no word for DEAD_MS and the connection is dropped. */
export const PING_MS = 30_000
export const DEAD_MS = 75_000
/** The hub says this when the peer is revoked: no retry until config.json changes. */
const CLOSE_REVOKED = 4403
/** The hub says this when it does not know the key: the board is no member (it never joined, or the hub started over). */
const CLOSE_UNKNOWN = 4401
/** Not knowing the key does not mend itself: tried again this rarely, in case the hub was given the key. */
export const UNKNOWN_RETRY_MS = 60_000

const hubUrl = (hub: string): string => `${hub}/v1`

export function createTeam({
  cfg,
  log,
  onChange,
  socket = url => new WebSocket(url) as unknown as WsLike,
  clock = realClock,
  random = Math.random,
  version = 'dev',
}: Options): TeamService {
  let active: TeamConfig | null = null
  let signature = ''
  let state: TeamState = 'off'
  let error: string | undefined
  let nextAt: number | undefined
  let revCount = 0
  let gen = 0
  let attempt = 0
  let ws: WsLike | null = null
  let authed = false
  let me: { peer: string; pkcs8: string } | null = null
  let myName: string | null = null
  let roster: RosterPeer[] = []
  let lastRx = 0
  let retry: unknown
  let upTimer: unknown
  let pinger: unknown

  const config = (): TeamConfig | null => teamConfig(cfg.team)
  const changed = (): void => {
    revCount++
    onChange()
  }
  const setState = (next: TeamState, why?: string): void => {
    if (state === next && error === why) return
    state = next
    error = why
    changed()
  }

  function clearTimers(): void {
    if (retry !== undefined) clock.clearTimeout(retry)
    if (upTimer !== undefined) clock.clearTimeout(upTimer)
    if (pinger !== undefined) clock.clearInterval(pinger)
    retry = upTimer = pinger = undefined
    nextAt = undefined
  }

  function drop(code = 1000, reason?: string): void {
    gen++
    clearTimers()
    authed = false
    const w = ws
    ws = null
    if (w) {
      w.onopen = w.onmessage = w.onclose = w.onerror = null
      try {
        w.close(code, reason)
      } catch {}
    }
  }

  const frame = (f: Frame): void => {
    if (ws) ws.send(JSON.stringify(f))
  }

  function scheduleRetry(why: string | undefined, fixedWait?: number): void {
    attempt++
    const wait = fixedWait ?? backoffMs(attempt, random)
    nextAt = clock.now() + wait
    retry = clock.setTimeout(() => void connect(), wait)
    state = why ? 'error' : 'reconnecting'
    error = why
    changed()
  }

  async function connect(): Promise<void> {
    if (!active) return
    const mine = ++gen
    retry = undefined
    nextAt = undefined
    // While the hub does not know this board the line says so, also while a new try is under way.
    if (!(state === 'error' && error === 'unknown_peer')) setState(attempt > 0 ? 'reconnecting' : 'connecting')
    try {
      const key = await ensureKey()
      if (mine !== gen) return
      me = { peer: key.pub, pkcs8: key.pkcs8 }
      const w = socket(hubUrl(active.hub))
      ws = w
      w.onopen = () => {
        if (mine !== gen) return
        lastRx = clock.now()
        frame({ t: 'hello', v: TEAM_PROTOCOL, peer: key.pub, client: `agent-board/${version}` })
      }
      w.onmessage = e => {
        if (mine !== gen || typeof e.data !== 'string') return
        lastRx = clock.now()
        void onFrame(mine, e.data)
      }
      w.onerror = () => {}
      w.onclose = e => {
        if (mine !== gen) return
        drop()
        if (e.code === CLOSE_REVOKED) {
          log('team: this board was revoked by the hub')
          setState('revoked')
          return
        }
        if (e.code === CLOSE_UNKNOWN) {
          log('team: the hub does not know this board; join with an invite (board team join)')
          scheduleRetry('unknown_peer', UNKNOWN_RETRY_MS)
          return
        }
        scheduleRetry(undefined)
      }
    } catch (err) {
      if (mine !== gen) return
      const why = err instanceof Error ? err.message : String(err)
      log(`team: ${why}`)
      drop()
      scheduleRetry(why)
    }
  }

  async function onFrame(mine: number, text: string): Promise<void> {
    const f = parseFrame(text)
    if (!f) {
      audit('drop', null, { why: 'junk' })
      return
    }
    try {
      await handle(mine, f)
    } catch (err) {
      log(`team: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handle(mine: number, f: Frame): Promise<void> {
    if (!me || !active) return
    switch (f.t) {
      case 'challenge': {
        const sig = await sign(me.pkcs8, authBytes({ hub: f.hub, nonce: f.nonce, peer: me.peer }))
        if (mine === gen) frame({ t: 'auth', sig })
        return
      }
      case 'welcome':
        // Once is enough: a second one would only leak the timers of the first.
        if (authed) return
        authed = true
        myName = f.name
        if (upTimer !== undefined) clock.clearTimeout(upTimer)
        if (pinger !== undefined) clock.clearInterval(pinger)
        upTimer = clock.setTimeout(() => {
          attempt = 0
        }, UP_RESETS_MS)
        pinger = clock.setInterval(() => {
          if (clock.now() - lastRx >= DEAD_MS) {
            log('team: the hub went silent; reconnecting')
            // Not waiting for a close event a dead socket may never send; the socket is let go of
            // here, so its late onclose (cleared by drop) changes nothing.
            drop(4000, 'silent')
            scheduleRetry(undefined)
            return
          }
          frame({ t: 'ping' })
        }, PING_MS)
        setState('online')
        resend()
        return
      case 'roster':
        takeRoster(f.peers)
        return
      case 'presence':
        roster = roster.map(p => (p.peer === f.peer ? { ...p, online: f.online, last_seen: f.at } : p))
        changed()
        return
      case 'state':
        await takeState(f)
        return
      case 'deliver':
        if (authed) await takeDeliver(f.env)
        return
      case 'error':
        log(`team: the hub says ${f.code}${f.id ? ` for ${f.id}` : ''}`)
        audit('hub-error', null, { code: f.code })
        // An error naming a message of ours settles it: it is not sent again on the next connect.
        if (f.id && refuseOut(f.id, f.code, clock.now())) changed()
        return
      case 'ping':
        frame({ t: 'pong' })
        return
      default:
        return
    }
  }

  /** The questions the hub has not settled go again, same id: it answers with their state. */
  function resend(): void {
    for (const list of Object.values(readAllOutbox()))
      for (const i of list) if (i.state === 'queued' || i.state === 'delivered') frame({ t: 'send', env: i.env })
  }

  function takeRoster(peers: RosterPeer[]): void {
    roster = peers.filter(p => p.peer !== me?.peer)
    changePins(pins => {
      for (const p of roster) {
        const known = pins[p.peer]
        if (known) {
          if (known.status === 'trusted') known.name = p.name
        } else if (Object.values(pins).some(x => x.name === p.name))
          pins[p.peer] = { name: p.name, status: 'changed', at: clock.now() }
        else pins[p.peer] = { name: p.name, status: 'trusted', at: clock.now() }
      }
    })
    changed()
  }

  async function takeState(f: Extract<Frame, { t: 'state' }>): Promise<void> {
    const item = Object.values(readAllOutbox())
      .flat()
      .find(i => i.msg.id === f.id)
    if (!item || !me) return
    if (f.state === 'acked') {
      // Acked counts only with the recipient's own signature over it.
      const a = f.ack
      const ok =
        !!a &&
        a.by === item.msg.to &&
        (await verify(a.by, ackBytes({ by: a.by, id: f.id, to: me.peer, ts: a.ts }), a.sig))
      if (!ok) {
        audit('drop', item.msg.to, { why: 'bad_ack', id: f.id })
        setOutState(f.id, 'delivered', f.at)
      } else setOutState(f.id, 'acked', f.at, a)
    } else setOutState(f.id, f.state, f.at)
    changed()
  }

  async function takeDeliver(raw: Envelope): Promise<void> {
    if (!me) return
    // The signature is checked over the payload string as it came; only then is it read.
    const opened = await openEnvelope(raw)
    if (!opened.ok) {
      audit('drop', opened.from ?? null, { why: opened.code, ...(opened.id && { id: opened.id }) })
      log(`team: dropped a message (${opened.code === 'bad_sig' ? 'bad signature' : opened.code})`)
      return
    }
    const msg = opened.msg
    if (msg.to !== me.peer) {
      audit('drop', msg.from, { why: 'bad_sig', id: msg.id })
      log('team: dropped a message (bad signature)')
      return
    }
    const held = readPins()[msg.from]?.status !== 'trusted'
    const fresh = addInbox({
      id: msg.id,
      from: msg.from,
      ts: msg.ts,
      text: msg.body.text,
      receivedAt: clock.now(),
      held,
      ...(msg.body.via && { via: msg.body.via }),
      ackedAt: null,
    })
    if (fresh) {
      audit('inbox', msg.from, { id: msg.id, held })
      changed()
    }
    // Acked again on a redelivery: the first ack may not have got through.
    const ts = new Date(clock.now()).toISOString()
    const sig = await sign(me.pkcs8, ackBytes({ by: me.peer, id: msg.id, to: msg.from, ts }))
    frame({ t: 'ack', id: msg.id, ts, sig })
    markAcked(msg.from, msg.id, clock.now())
  }

  async function sendQuestion(to: string, text: string, via?: Via): Promise<SendResult> {
    if (!config()) return { ok: false, error: 'off' }
    if (!isPeerId(to)) return { ok: false, error: 'peer' }
    const body = text.trim()
    if (!body || body.length > MAX_TEXT) return { ok: false, error: 'text' }
    if (!roster.some(p => p.peer === to)) return { ok: false, error: 'peer' }
    // A key that changed under a pinned name may be someone else's: nothing goes to it until Trust.
    if (readPins()[to]?.status === 'changed') return { ok: false, error: 'changed' }
    const key = await ensureKey()
    const msg: Message = {
      v: TEAM_PROTOCOL,
      id: crypto.randomUUID(),
      from: key.pub,
      to,
      kind: 'question',
      reply_to: null,
      ts: new Date(clock.now()).toISOString(),
      ttl_s: DEFAULT_TTL_S,
      body: via ? { text: body, via } : { text: body },
    }
    // Written once and signed as written; that string is what every hop passes on.
    const env: Envelope = await sealEnvelope(key, msg)
    // What the hub would refuse (shape, the 16 KiB of the payload) is refused here, not queued.
    const wire = checkEnvelope(env)
    if (!wire.ok) return { ok: false, error: wire.code }
    const checked = checkMessage(env.payload, env.from)
    if (!checked.ok) return { ok: false, error: checked.code }
    addOutbox({ env, msg, state: 'queued', at: clock.now() })
    if (authed) frame({ t: 'send', env })
    changed()
    return { ok: true, id: msg.id }
  }

  function begin(): void {
    const c = config()
    signature = c ? `${c.hub}\n${c.name ?? ''}` : ''
    active = c
    attempt = 0
    if (c) void connect()
  }

  return {
    view() {
      const c = config()
      if (!c) return null
      const pins = readPins()
      const drafts = readDrafts()
      const peer = me?.peer ?? readKey()?.pub ?? null
      return {
        state,
        ...(error !== undefined && { error }),
        ...(nextAt !== undefined && { nextAt }),
        me: { peer, fingerprint: peer ? fingerprint(peer) : '', name: myName ?? c.name },
        hub: c.hub,
        roster: roster.map(p => ({
          peer: p.peer,
          name: p.name,
          online: p.online,
          lastSeen: p.last_seen,
          fingerprint: fingerprint(p.peer),
          pin: pins[p.peer]?.status ?? 'trusted',
          drafts: drafts.filter(d => d.to === p.peer).length,
        })),
      }
    },
    thread(peer) {
      if (!config() || !isPeerId(peer)) return []
      const known = roster.find(p => p.peer === peer)?.name ?? readPins()[peer]?.name
      const who = known ?? fingerprint(peer).slice(0, 14).trim()
      const incoming = readInbox(peer).map(
        (i: InboxItem): ThreadMessage => ({
          id: i.id,
          dir: 'in',
          text: i.held ? null : i.text,
          ts: i.ts,
          held: i.held,
          ...(i.via && { via: i.via, agentOf: who }),
        }),
      )
      const outgoing = readOutbox(peer).map(
        (i: OutboxItem): ThreadMessage => ({
          id: i.msg.id,
          dir: 'out',
          text: i.msg.body.text,
          ts: i.msg.ts,
          state: i.state,
          ...(i.code && { code: i.code }),
          ...(i.msg.body.via && { via: i.msg.body.via }),
        }),
      )
      const drafts = readDrafts()
        .filter(d => d.to === peer)
        .map((d): ThreadMessage => ({ id: d.id, dir: 'draft', text: d.text, ts: new Date(d.createdAt).toISOString() }))
      return [...[...incoming, ...outgoing].sort((a, b) => a.ts.localeCompare(b.ts)), ...drafts]
    },
    send: (to, text) => sendQuestion(to, text),
    draft(to, text) {
      if (!config()) return { ok: false, error: 'off' }
      if (!isPeerId(to) || !roster.some(p => p.peer === to)) return { ok: false, error: 'peer' }
      const body = text.trim()
      if (!body || body.length > MAX_TEXT) return { ok: false, error: 'text' }
      const id = crypto.randomUUID()
      if (!addDraft({ id, to, text: body, createdAt: clock.now() }, MAX_DRAFTS)) return { ok: false, error: 'full' }
      audit('draft', to, { id })
      changed()
      return { ok: true, id }
    },
    async sendDraft(id) {
      if (!config()) return { ok: false, error: 'off' }
      if (!isMessageId(id)) return { ok: false, error: 'draft' }
      // Taken out first, so a second press finds nothing; put back when the send is refused.
      const d = takeDraft(id)
      if (!d) return { ok: false, error: 'draft' }
      const r = await sendQuestion(d.to, d.text, 'agent')
      if (!r.ok) addDraft(d, Number.MAX_SAFE_INTEGER)
      else audit('draft_sent', d.to, { id })
      changed()
      return r
    },
    discardDraft(id) {
      if (!config() || !isMessageId(id)) return false
      const d = takeDraft(id)
      if (d) {
        audit('draft_discarded', d.to, { id })
        changed()
      }
      return d !== null
    },
    trust(peer) {
      if (!config() || !isPeerId(peer)) return false
      const ok = changePins(pins => {
        const p = Object.hasOwn(pins, peer) ? pins[peer] : undefined
        if (!p) return false
        p.status = 'trusted'
        for (const [id, x] of Object.entries(pins)) if (id !== peer && x.name === p.name) delete pins[id]
        return true
      })
      if (ok) {
        releaseHeld(peer)
        audit('trust', peer)
        changed()
      }
      return ok
    },
    rev() {
      return config() ? revCount : null
    },
    refresh() {
      const c = config()
      const sig = c ? `${c.hub}\n${c.name ?? ''}` : ''
      if (sig === signature) return
      const wasOn = !!active
      drop()
      active = null
      roster = []
      state = 'off'
      error = undefined
      begin()
      if (wasOn && !active) changed()
    },
    start() {
      if (active) return
      begin()
    },
    stop() {
      drop()
      active = null
      signature = ''
      state = 'off'
    },
  }
}
