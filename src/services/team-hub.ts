// The board's side of the peer network (#231, core/team.ts): one WebSocket to the team's hub while
// config.json's `team` is set. It joins nothing and launches nothing: what comes in is a question
// from a peer, checked (shape, kind, signature), kept in the inbox, acked with this board's
// signature, and shown; nothing else. This file has no Deps: the herdr adapter, launching, the
// terminals and any process are out of its reach by construction (test/services/
// team-inbound-isolation.test.ts keeps it so). With `team` unset, or not an object with a ws:// or
// wss:// hub, no socket is opened, no timer runs, no file is read or written and view() is null.
//
// Files (#371): the board says its box key in its hello, signed with its key; a peer's box is used
// only when its signature verifies and it is the one pinned for that peer (a different one makes the
// pin `changed`, as a new key does). A post with a file seals it once, wraps its key for each member
// whose board takes files, and sends the copies only once the hub has the blob (team-files.ts); the
// others get the post's text with FILE_LINE. A file that came in is fetched and opened there too.
import { readFileSync, statSync } from 'node:fs'
import {
  addDraft,
  addInbox,
  addOutbox,
  audit,
  changeBlobs,
  changePins,
  changeThreads,
  type Draft,
  type DraftFile,
  dropDraftFile,
  ensureBoxKey,
  ensureKey,
  type InboxItem,
  type InFile,
  keepDraftFile,
  keepSealed,
  markAcked,
  type OutboxItem,
  type OutFile,
  readAgents,
  readAllInbox,
  readAllOutbox,
  readBlobs,
  readDrafts,
  readInbox,
  readKey,
  readOutbox,
  readPins,
  readThreads,
  refuseOut,
  releaseHeld,
  type SessionRef,
  setOutState,
  type ThreadRecord,
  takeDraft,
} from '../adapters/team-store.ts'
import {
  ackBytes,
  authBytes,
  type BoxClaim,
  boxBytes,
  channelMembers,
  checkEnvelope,
  checkMessage,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_TTL_S,
  type Envelope,
  type ErrorCode,
  FILE_LINE,
  type FileRef,
  type Frame,
  fingerprint,
  GENERAL,
  type HubFiles,
  hasAssistant,
  hasChannels,
  hasFiles,
  hasReplies,
  hasThreads,
  isMessageId,
  isPeerId,
  isThreadId,
  MAX_DRAFTS,
  MAX_TEXT,
  MAX_TTL_S,
  type Message,
  OUR_CAPS,
  type OutState,
  openEnvelope,
  parseFrame,
  type RosterPeer,
  sealEnvelope,
  sign,
  TEAM_PROTOCOL,
  type TeamConfig,
  type ThreadRef,
  teamConfig,
  type Via,
  validLink,
  validName,
  validTitle,
  verify,
  verifyBox,
} from '../core/team.ts'
import { inboundKey, legacyText, splitKey, TEAM, threadKey } from '../core/team-agents.ts'
import { NONCE_BYTES, TAG_BYTES, usableBox, wrapSecret } from '../core/team-box.ts'
import { checkMeta, fileContext, mimeOf, sealFile } from '../core/team-file.ts'
import { backoffMs } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'
import { createFileTransfer, saveIncoming } from './team-files.ts'
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
  /** The peer's board reads topic and team threads (#216): its caps say so. */
  threads?: boolean
  /** A file can be sealed for the peer's board (#371): it takes files and its box verified and is the pinned one. */
  files?: boolean
  /** The peer is an assistant's bridge (#386): its caps say `assistant`. Absent for every other peer. */
  assistant?: boolean
}

export interface TeamView {
  state: TeamState
  /** error: what went wrong; reconnecting: when the next try is. */
  error?: string
  nextAt?: number
  me: { peer: string | null; fingerprint: string; name: string | null }
  hub: string
  roster: TeamRosterPeer[]
  /** The hub takes files (#371): the largest one this board can send through it, in bytes. */
  files?: { max: number }
}

/**
 * A file on a thread's line (#371). in: `pending` while it comes, `ready` once saved here, `failed`
 * with why; out: `uploading` to the hub, `up` once it has it, `refused` with the hub's code; a
 * draft's: `draft`. `progress`: how far the bytes are, while they move.
 */
export interface LineFile {
  state: 'pending' | 'ready' | 'failed' | 'uploading' | 'up' | 'refused' | 'draft'
  name?: string
  type?: string
  size?: number
  url?: string
  path?: string
  why?: string
  progress?: number
}

/** A file for a post (#371): a path on this computer the board reads at once, and the name it goes under. */
export interface PostFile {
  path: string
  name: string
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

/** `thread`: the key of the thread it went to (a new topic's too, #355: the panel opens it). */
export type SendResult = { ok: true; id: string; thread?: string } | { ok: false; error: string }

/** Where a post goes (#216): a peer or the team, and a thread (an existing one's id, or a new one's title). */
export interface PostTarget {
  /** A peer id, or `team`. */
  to: string
  /**
   * An existing thread's id, or a new one's title and link. `members` (#355, to `team` only, from
   * the panel): a new channel's other members, ids from the roster.
   */
  thread?: { id?: string; title?: string; link?: string; members?: string[] }
  /** The line of that thread it answers (#370): a message's id, or a team post's (ThreadLine.id). */
  replyTo?: string
}

/**
 * A post's sender, set by the route that took it (#216): the panel, or a session's `board team
 * post`. `pressed`: the owner sent an agent's draft. `claimed`: the session was named with
 * --session, the caller's own word.
 */
export type PostSource = { by: 'ui' } | { by: 'agent'; session?: SessionRef; pressed?: boolean; claimed?: boolean }

export type PostResult =
  | { ok: true; id: string; thread: string; copies: number; skipped: string[] }
  | { ok: false; error: string }

/** What came in, for the router (#216): told after the message is kept, never before. */
export interface InboundEvent {
  id: string
  from: string
  thread: string
  via?: Via
  held: boolean
  /** The thread was new to this board. */
  fresh: boolean
}

/** A line of a thread (#216): a message either way, or a draft. */
export interface ThreadLine {
  /** in: the message's id; out: the post's (a team post's first copy); draft: the draft's. */
  id: string
  dir: 'in' | 'out' | 'draft'
  /** in: the sender's key, and their name from this board's roster or pins (never from the message). */
  from?: string
  who?: string
  /** null: held back from a key that changed, until it is trusted. */
  text: string | null
  ts: string
  via?: Via
  /** via agent: the sending session's name; in: as the sender's board wrote it. */
  agent?: string
  /** out to a pair: how far it got, and the hub's code when it refused it. */
  state?: OutState
  code?: ErrorCode
  /** out to the team: how far each copy got. */
  receipts?: { peer: string; name: string; state: OutState }[]
  /** out: an agent's draft the owner sent. */
  pressed?: boolean
  held?: boolean
  /** draft: why the board held it. */
  reason?: string
  /**
   * in or out: the message it answers (#370), as a line of this thread (its id) when this board
   * has it, else the id as the sender wrote it.
   */
  replyTo?: string
  /** A file with it (#371). */
  file?: LineFile
}

export interface ThreadView extends ThreadRecord {
  key: string
  /** The pair's peer, as this board's roster calls them; null for the team. */
  peerName: string | null
  /** Its latest message (#370), in GET /api/team/threads only. */
  last?: ThreadLast
}

/**
 * A thread's latest message for the list (#370): which way it went, who wrote it (this board's
 * name for them, never the message's), its text (null while held) and when.
 */
export interface ThreadLast {
  dir: 'in' | 'out'
  who?: string
  text: string | null
  ts: string
  via?: Via
}

export type DraftResult = { ok: true; id: string } | { ok: false; error: string }

export interface TeamService {
  /** The view, null while `team` is not on in config.json. */
  view(): TeamView | null
  /** The messages with a peer, oldest first; empty while off. */
  thread(peer: string): ThreadMessage[]
  /**
   * The panel's message to a peer in the roster whose key is trusted ('changed' otherwise), or to
   * the team, in general or a thread (#216); kept and sent (again on every reconnect until the hub settles it).
   */
  send(to: string, text: string, thread?: PostTarget['thread'], replyTo?: string, file?: PostFile): Promise<SendResult>
  /** A post from the panel or a session (#216), with its source set by the route that took it; a file with it (#371). */
  post(target: PostTarget, text: string, source: PostSource, file?: PostFile): Promise<PostResult>
  /**
   * An agent's draft for a person on the roster, or the team: kept for the person to Send or Discard,
   * never sent by the service. A file with it (#371) is copied into the board's folder at once.
   */
  draft(
    to: string,
    text: string,
    more?: Pick<Draft, 'thread' | 'reason' | 'session' | 'replyTo'> & { file?: PostFile },
  ): DraftResult
  /** The threads this board has, the latest first (#216); empty while off. */
  threads(): ThreadView[]
  /** One thread's lines by its key; empty while off or for no thread. */
  threadLines(key: string): ThreadLine[]
  /** Each thread's latest message, by its key (#370); empty while off. */
  lasts?(): Record<string, ThreadLast>
  /** What this board calls a peer: its roster's name, its pins', else the short fingerprint (#216). */
  nameOf(peer: string): string
  /** Changes who handles a thread, or whether it is muted (#216); false when there is no such thread. */
  setThread(key: string, change: { handler?: SessionRef | null; muted?: boolean }): boolean
  /**
   * Adds members to a channel this board started (#355): peers of the roster. They get its posts
   * from the next one on, the list with them; what was said before stays with who was there.
   */
  addMembers(key: string, peers: string[]): { ok: true } | { ok: false; error: string }
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
  /** A message came in and was kept: the router decides whether a session hears of it (#216), the
   * board's notification and unread count hear of it too (#355). */
  onInbound?: (e: InboundEvent) => void
  socket?: (url: string) => WsLike
  clock?: Clock
  random?: () => number
  version?: string
}

/** How much of a thread's latest message the list gets (#370). */
export const LAST_CHARS = 160

/** Threads kept per peer (and for the team); past it the quietest one nobody handles goes (#216). */
export const MAX_THREADS_PER_SCOPE = 200

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
  onInbound,
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
  /** What the hub said of files in its welcome (#371); null for a hub that keeps none. */
  let hubFiles: HubFiles | null = null
  /** The peers' box keys whose signatures verified (#371), by peer; and the claims checked already. */
  const boxes = new Map<string, string>()
  const checked = new Map<string, boolean>()

  const files = createFileTransfer({
    frame: f => frame(f),
    authed: () => authed,
    me: () => me?.peer ?? null,
    now: () => clock.now(),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: h => clock.clearTimeout(h),
    hubMax: () => hubFiles?.max ?? 0,
    log,
    changed: () => changed(),
    release: blob => {
      if (!authed) return
      for (const list of Object.values(readAllOutbox()))
        for (const i of list) if (i.file?.blob === blob && i.state === 'queued') frame({ t: 'send', env: i.env })
    },
    refuse: (blob, code) => {
      for (const list of Object.values(readAllOutbox()))
        for (const i of list) if (i.file?.blob === blob) refuseOut(i.msg.id, code, clock.now())
    },
  })

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
    files.stop()
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
      // The box key goes in the hello signed with this board's key (#371), so no hub can swap it.
      // Without a box key (a state folder it cannot write, a runtime without X25519) the board still
      // connects, as an older one does: no box, no `files` cap, text as ever.
      let claim: BoxClaim | undefined
      try {
        const box = await ensureBoxKey()
        claim = { key: box.pub, sig: await sign(key.pkcs8, boxBytes({ box: box.pub, peer: key.pub })) }
      } catch (err) {
        log(`team: no box key, so no files: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (mine !== gen) return
      me = { peer: key.pub, pkcs8: key.pkcs8 }
      const w = socket(hubUrl(active.hub))
      ws = w
      w.onopen = () => {
        if (mine !== gen) return
        lastRx = clock.now()
        frame({
          t: 'hello',
          v: TEAM_PROTOCOL,
          peer: key.pub,
          client: `agent-board/${version}`,
          caps: claim ? OUR_CAPS : OUR_CAPS.filter(c => c !== 'files'),
          ...(claim && { box: claim }),
        })
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
        hubFiles = f.files ?? null
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
        files.welcome()
        return
      case 'roster':
        takeRoster(f.peers)
        await takeBoxes()
        return
      case 'presence':
        // Coming online says what the board understands now (an upgrade, #216); going offline says nothing of it.
        roster = roster.map(p => {
          if (p.peer !== f.peer) return p
          const next: RosterPeer = { ...p, online: f.online, last_seen: f.at }
          if (f.online) {
            delete next.caps
            if (f.caps) next.caps = f.caps
            delete next.box
            if (f.box) next.box = f.box
          }
          return next
        })
        changed()
        if (f.online) await takeBoxes()
        return
      case 'state':
        await takeState(f)
        return
      case 'deliver':
        if (authed) await takeDeliver(f.env)
        return
      case 'blob_have':
      case 'blob_ready':
      case 'blob_data':
        if (authed) files.frame(f)
        return
      case 'error':
        log(`team: the hub says ${f.code}${f.id ? ` for ${f.id}` : ''}`)
        audit('hub-error', null, { code: f.code })
        // A blob of ours, or one being fetched (#371), is settled there.
        if (f.id && files.error(f.id, f.code)) return
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

  /** The questions the hub has not settled go again, same id: it answers with their state. A post with a file waits for its blob (#371). */
  function resend(): void {
    const up = new Set(
      readBlobs()
        .filter(b => b.state === 'up')
        .map(b => b.id),
    )
    for (const list of Object.values(readAllOutbox()))
      for (const i of list)
        if ((i.state === 'queued' || i.state === 'delivered') && (!i.file || up.has(i.file.blob)))
          frame({ t: 'send', env: i.env })
  }

  /**
   * The peers' box keys (#371): each claim's signature checked once against the peer's key, and
   * held to the box pinned for that peer. A trusted pin without a box takes the first that verifies;
   * a different one later makes the pin `changed`, as a new key under a pinned name does, until Trust.
   */
  async function takeBoxes(): Promise<void> {
    const claims = roster.map(p => [p.peer, p.box] as const)
    for (const [peer, claim] of claims) {
      if (!claim) continue
      const id = `${peer}\n${claim.key}\n${claim.sig}`
      // A signed key nothing can be sealed to (of low order) is no box either.
      if (!checked.has(id)) checked.set(id, (await verifyBox(peer, claim)) && (await usableBox(claim.key)))
    }
    boxes.clear()
    for (const [peer, claim] of claims)
      if (claim && checked.get(`${peer}\n${claim.key}\n${claim.sig}`)) boxes.set(peer, claim.key)
    const moved = changePins(pins => {
      let n = 0
      for (const [peer, key] of boxes) {
        const pin = Object.hasOwn(pins, peer) ? pins[peer] : undefined
        if (pin?.status !== 'trusted' || pin.box === key) continue
        if (pin.box === undefined) pin.box = key
        else {
          pin.status = 'changed'
          pin.at = clock.now()
          n++
        }
      }
      return n
    })
    if (moved) {
      audit('box_changed', null, { peers: moved })
      log('team: a peer box key changed; trust it in the Team panel before files go to it')
    }
    changed()
  }

  /** Whether a file can be sealed for a peer (#371): its board takes files, its box verified and is the trusted one. */
  function canFile(p: RosterPeer): boolean {
    const pin = readPins()[p.peer]
    const box = boxes.get(p.peer)
    return hasFiles(p) && !!box && pin?.status === 'trusted' && pin.box === box
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
    const thread = inboundKey(msg.from, msg.body.thread)
    if (!channelFits(thread, msg.body.thread, msg.from, me.peer)) {
      // Acked all the same: the hub need not bring it again.
      audit('drop', msg.from, { why: 'channel', id: msg.id })
      log('team: dropped a message (a channel this board is not in, or a thread it does not fit)')
    } else {
      keep(msg, thread, held)
      if (msg.body.file) files.kick()
    }
    // Acked again on a redelivery: the first ack may not have got through.
    const ts = new Date(clock.now()).toISOString()
    const sig = await sign(me.pkcs8, ackBytes({ by: me.peer, id: msg.id, to: msg.from, ts }))
    frame({ t: 'ack', id: msg.id, ts, sig })
    markAcked(msg.from, msg.id, clock.now())
  }

  /**
   * A channel's copy (#355) fits when it names this board and its sender as members, and its thread
   * here is a channel too, or new. A plain team thread's copy never lands in a channel either: a
   * channel's words stay with its members, and the team's stay the team's. A channel kept here takes
   * copies only from its members as kept, or its creator (whose post brings a new member's name
   * before that member can answer: the hub hands each board its copies in order). A new channel is
   * not taken while the team's threads are at their cap: channels are never dropped to make room,
   * so a full scope cannot be used to forget one.
   */
  function channelFits(key: string, ref: ThreadRef | undefined, from: string, self: string): boolean {
    const all = readThreads()
    const have = Object.hasOwn(all, key) ? all[key] : undefined
    const members = ref?.members
    if (!members) return !have?.members
    if (!members.includes(self) || !members.includes(from)) return false
    if (have) return !!have.members && (have.members.includes(from) || have.by === from)
    return Object.values(all).filter(t => t.scope === TEAM).length < MAX_THREADS_PER_SCOPE
  }

  /** A message that came in, kept: the inbox, its thread, the audit and the hearers. */
  function keep(msg: Message, thread: string, held: boolean): void {
    const fresh = addInbox({
      id: msg.id,
      from: msg.from,
      ts: msg.ts,
      text: msg.body.text,
      receivedAt: clock.now(),
      held,
      ...(msg.body.via && { via: msg.body.via }),
      ...(msg.body.agent && { agent: msg.body.agent }),
      thread,
      ...(msg.body.replyTo && { replyTo: msg.body.replyTo }),
      ...(msg.body.post && { post: msg.body.post }),
      ackedAt: null,
      ...(msg.body.file && { file: { state: 'pending' as const, ref: msg.body.file } }),
    })
    if (fresh) {
      const isNew = keepThread(thread, msg.body.thread, msg.from)
      audit('inbox', msg.from, { id: msg.id, held, thread, ...(msg.body.via && { via: msg.body.via }) })
      changed()
      onInbound?.({
        id: msg.id,
        from: msg.from,
        thread,
        held,
        fresh: isNew,
        ...(msg.body.via && { via: msg.body.via }),
      })
    }
  }

  /** The name this board knows a peer by: its roster, its pins, else the short fingerprint. Never a message's word. */
  const nameOf = (peer: string): string =>
    roster.find(p => p.peer === peer)?.name ?? readPins()[peer]?.name ?? fingerprint(peer).slice(0, 14).trim()

  /**
   * Notes a thread seen in a message, or started here (#216): made on first sight with the title
   * and link it came with, moved on after that. `handler`: the session that started it. True when new.
   */
  function keepThread(key: string, ref: ThreadRef | undefined, by: string, handler?: SessionRef): boolean {
    const parts = splitKey(key)
    if (!parts) return false
    const now = clock.now()
    return changeThreads(threads => {
      const have = Object.hasOwn(threads, key) ? threads[key] : undefined
      if (have) {
        have.lastAt = now
        if (!have.title && ref?.title) have.title = ref.title
        if (!have.link && ref?.link) have.link = ref.link
        // A channel's member list moves on with its creator's posts only (#355).
        if (have.members && ref?.members && by === have.by) have.members = ref.members
        return false
      }
      threads[key] = {
        scope: parts.scope,
        id: parts.id,
        title: ref?.title ?? null,
        link: ref?.link ?? null,
        handler: handler ?? null,
        muted: false,
        by,
        createdAt: now,
        lastAt: now,
        ...(ref?.members && { members: ref.members }),
      }
      // A peer cannot grow the file without end: past the cap, its quietest thread nobody handles
      // goes (its messages stay in the inbox, under the thread's key). Never a channel (#355): its
      // record is what keeps its words with its members.
      const mine = Object.entries(threads).filter(([, t]) => t.scope === parts.scope)
      if (mine.length > MAX_THREADS_PER_SCOPE) {
        const [quietest] =
          mine.filter(([, t]) => !t.handler && !t.members).sort((a, b) => a[1].lastAt - b[1].lastAt)[0] ?? []
        if (quietest) delete threads[quietest]
      }
      return true
    })
  }

  /** The thread a post goes to: an existing one by id, a new one by title, else general. */
  function threadOf(scope: string, t: PostTarget['thread'], me: string): { ok: true; ref?: ThreadRef } | { ok: false } {
    if (t?.id !== undefined) {
      if (!isThreadId(t.id) || t.members !== undefined) return { ok: false }
      if (t.id === GENERAL) return { ok: true }
      const rec = readThreads()[threadKey(scope, t.id)]
      if (!rec) return { ok: false }
      return {
        ok: true,
        ref: {
          id: t.id,
          ...(rec.title && { title: rec.title }),
          ...(rec.link && { link: rec.link }),
          ...(rec.members && { members: rec.members }),
        },
      }
    }
    if (t?.title === undefined) return { ok: true }
    if (!validTitle(t.title) || (t.link !== undefined && !validLink(t.link))) return { ok: false }
    // A new channel (#355): the team's, its members in the roster now, this board among them.
    let members: string[] | undefined
    if (t.members !== undefined) {
      const ids = Array.isArray(t.members) ? t.members : []
      if (scope !== TEAM || !ids.length || !ids.every(id => id !== me && roster.some(p => p.peer === id)))
        return { ok: false }
      const list = channelMembers([me, ...ids])
      if (!list) return { ok: false }
      members = list
    }
    return {
      ok: true,
      ref: {
        id: crypto.randomUUID(),
        title: t.title,
        ...(t.link !== undefined && { link: t.link }),
        ...(members && { members }),
      },
    }
  }

  /**
   * A post to a peer or the team (#216). The team gets one copy per member, each signed for its
   * recipient and carrying the same thread; a member whose key changed is skipped (named in the
   * result). A peer whose board reads threads gets the thread and the session's name in the body,
   * any other the text with the title in front. Every copy is built before any is kept, so a
   * refused one sends nothing.
   */
  async function post(target: PostTarget, text: string, source: PostSource, file?: PostFile): Promise<PostResult> {
    if (!config()) return { ok: false, error: 'off' }
    const body = text.trim()
    // With a file the text is its caption, and may be left out (#371).
    if ((!body && !file) || body.length > MAX_TEXT) return { ok: false, error: 'text' }
    if (file && !hubFiles) return { ok: false, error: 'files_hub' }
    const bytes = file ? readPostFile(file) : null
    if (bytes && !bytes.ok) return { ok: false, error: bytes.error }
    const team = target.to === TEAM
    if (!team && (!isPeerId(target.to) || !roster.some(p => p.peer === target.to))) return { ok: false, error: 'peer' }
    const pins = readPins()
    // A key that changed under a pinned name may be someone else's: nothing goes to it until Trust.
    if (!team && pins[target.to]?.status === 'changed') return { ok: false, error: 'changed' }
    // Only the panel starts a channel (#355): an agent's post or a draft never names members.
    if (target.thread?.members !== undefined && source.by !== 'ui') return { ok: false, error: 'thread' }
    const scope = team ? TEAM : target.to
    const me = await ensureKey()
    const th = threadOf(scope, target.thread, me.pub)
    if (!th.ok) return { ok: false, error: 'thread' }
    const ref: ThreadRef | undefined = team ? { ...(th.ref ?? { id: GENERAL }), group: true } : th.ref
    const key = threadKey(scope, ref?.id ?? GENERAL)
    const changedKey = (p: RosterPeer): boolean => pins[p.peer]?.status === 'changed'
    // A channel goes to its members only (#355); the team's other threads to everyone.
    const inThread = (p: RosterPeer): boolean => !ref?.members || ref.members.includes(p.peer)
    const recipients = team
      ? roster.filter(p => inThread(p) && !changedKey(p))
      : roster.filter(p => p.peer === target.to)
    const skipped = team ? roster.filter(p => inThread(p) && changedKey(p)).map(p => p.name) : []
    if (!recipients.length) return { ok: false, error: 'nobody' }
    // A reply (#370): a line of this thread, named on the wire as its sender's board named it.
    let replyTo: string | undefined
    if (target.replyTo !== undefined) {
      const wire = wireId(key, target.replyTo)
      if (!wire) return { ok: false, error: 'reply' }
      replyTo = wire
    }
    // A file (#371) is sealed once and its key wrapped for each board that can take it; the others
    // get the text and FILE_LINE. Nobody who can take it: nothing goes.
    const takers = bytes?.ok ? recipients.filter(canFile) : []
    if (bytes?.ok && !takers.length) return { ok: false, error: 'files_nobody' }
    // Each taker's box as it was pinned when it was chosen, before anything awaits.
    const boxesOf = takers.map(p => ({ peer: p.peer, box: boxes.get(p.peer) as string }))
    const blob = bytes?.ok ? crypto.randomUUID() : null
    let sealed: Awaited<ReturnType<typeof sealFile>> | null = null
    let wrapped: Awaited<ReturnType<typeof wrapSecret>> | null = null
    try {
      sealed = bytes?.ok && blob ? await sealFile(bytes.bytes, bytes.meta, blob) : null
      wrapped = sealed && blob ? await wrapSecret(sealed.secret, boxesOf, fileContext(blob)) : null
    } catch (err) {
      log(`team: a file could not be sealed: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: 'file' }
    }
    const ttl_s = team ? MAX_TTL_S : DEFAULT_TTL_S
    const via: Via | undefined = source.by === 'agent' ? 'agent' : undefined
    const session = source.by === 'agent' ? source.session : undefined
    const pressed = source.by === 'agent' && source.pressed === true
    const agentName = session?.name && validName(session.name) ? session.name : undefined
    const copies: { env: Envelope; msg: Message }[] = []
    // The first copy's id is the post's: every copy of a team post carries it to a board with
    // `replies` (#370), so a reply to it names one message on every member's board.
    const postId = crypto.randomUUID()
    for (const p of recipients) {
      // A channel's copy goes as a channel only to a board that reads channels; any other gets it
      // in its pair's general with the title in front, so an answer there reaches this board alone.
      const rich = ref?.members ? hasChannels(p) : hasThreads(p)
      const fileRef: FileRef | undefined =
        sealed && blob && wrapped?.keys[p.peer]
          ? {
              blob,
              size: sealed.blob.length,
              hash: sealed.hash,
              eph: wrapped.eph,
              key: wrapped.keys[p.peer] as string,
              meta: sealed.meta,
            }
          : undefined
      // A board that cannot take the file reads that one was sent, after the text.
      const said = sealed && !fileRef ? (body ? `${body}\n\n${FILE_LINE}` : FILE_LINE) : body
      const words =
        rich || (fileRef && !body)
          ? said
          : legacyText(
              said,
              ref && { ...(ref.title && { title: ref.title }), group: ref.group === true && !ref.members },
            )
      if (words.length > MAX_TEXT) return { ok: false, error: 'text' }
      const msgBody: Message['body'] = { text: words }
      if (via) msgBody.via = via
      if (rich && via && agentName) msgBody.agent = agentName
      if (rich && ref) msgBody.thread = ref
      if (rich && hasReplies(p)) {
        if (replyTo) msgBody.replyTo = replyTo
        if (team) msgBody.post = postId
      }
      if (fileRef) msgBody.file = fileRef
      const msg: Message = {
        v: TEAM_PROTOCOL,
        id: copies.length ? crypto.randomUUID() : postId,
        from: me.pub,
        to: p.peer,
        kind: 'question',
        reply_to: null,
        ts: new Date(clock.now()).toISOString(),
        // A team copy waits as long as the hub keeps anything, for members who are away.
        ttl_s,
        body: msgBody,
      }
      // Written once and signed as written; that string is what every hop passes on.
      const env: Envelope = await sealEnvelope(me, msg)
      // What the hub would refuse (shape, the 16 KiB of the payload) is refused here, not queued.
      const wire = checkEnvelope(env)
      if (!wire.ok) return { ok: false, error: wire.code }
      const checked = checkMessage(env.payload, env.from)
      if (!checked.ok) return { ok: false, error: checked.code }
      copies.push({ env, msg })
    }
    keepThread(key, ref, 'me')
    // The file's own copy here, to show in the thread, and its sealed bytes until the hub has them.
    let outFile: OutFile | undefined
    if (bytes?.ok && sealed && blob) {
      const mine = saveIncoming(bytes.bytes, bytes.meta.name, blob, new Date(clock.now()))
      outFile = { blob, name: bytes.meta.name, type: bytes.meta.type, size: bytes.meta.size, url: mine.url }
      keepSealed(blob, sealed.blob)
      const rec = {
        id: blob,
        to: takers.map(p => p.peer),
        size: sealed.blob.length,
        hash: sealed.hash,
        ttl_s,
        state: 'uploading' as const,
        at: clock.now(),
      }
      changeBlobs(all => {
        all[blob] = rec
      })
      sealed.secret.fill(0)
    }
    for (const c of copies) {
      addOutbox({
        env: c.env,
        msg: c.msg,
        state: 'queued',
        at: clock.now(),
        thread: key,
        ...(team && { post: postId }),
        by: source.by,
        ...(session && { session }),
        ...(pressed && { pressed: true }),
        // The post's own text, where this copy's has a title in front (an older board's).
        ...(c.msg.body.text !== body && { text: body }),
        ...(replyTo && { replyTo }),
        ...(outFile && { file: outFile }),
      })
      // A copy with a file goes once the hub has the blob (#371).
      if (authed && !outFile) frame({ t: 'send', env: c.env })
    }
    if (outFile) {
      const rec = readBlobs().find(b => b.id === outFile.blob)
      if (rec) files.send(rec)
    }
    audit('post', team ? null : target.to, {
      id: postId,
      thread: key,
      copies: copies.length,
      ...(outFile && { file: outFile.blob, size: outFile.size }),
      by: source.by,
      ...(session && { session: session.key }),
      ...(pressed && { pressed: true }),
      ...(source.by === 'agent' && source.claimed && { claimed: true }),
    })
    changed()
    return { ok: true, id: postId, thread: key, copies: copies.length, skipped }
  }

  /**
   * A file for a post (#371), read now: a regular file within what the hub takes (less the seal's
   * nonce and tag), under a name a meta can carry and a type from its extension.
   */
  function readPostFile(
    file: PostFile,
  ):
    | { ok: true; bytes: Uint8Array; meta: { name: string; type: string; size: number } }
    | { ok: false; error: string } {
    const max = (hubFiles?.max ?? 0) - NONCE_BYTES - TAG_BYTES
    let size: number
    try {
      const st = statSync(file.path)
      if (!st.isFile()) return { ok: false, error: 'file' }
      size = st.size
    } catch {
      return { ok: false, error: 'file' }
    }
    if (size > max) return { ok: false, error: 'file_big' }
    const meta = checkMeta({ name: file.name, type: mimeOf(file.name), size })
    if (!meta) return { ok: false, error: 'file_name' }
    try {
      const bytes = new Uint8Array(readFileSync(file.path))
      if (bytes.length !== size || bytes.length > max) return { ok: false, error: 'file' }
      return { ok: true, bytes, meta }
    } catch {
      return { ok: false, error: 'file' }
    }
  }

  /** A line's file (#371): what came in, what went out with how far its blob got, or a draft's. */
  function lineFileIn(f: InFile, blob?: string): LineFile {
    const progress = blob ? files.progress(blob) : undefined
    return {
      state: f.state,
      ...(f.name !== undefined && { name: f.name }),
      ...(f.type !== undefined && { type: f.type }),
      ...(f.size !== undefined && { size: f.size }),
      ...(f.url !== undefined && { url: f.url }),
      ...(f.path !== undefined && { path: f.path }),
      ...(f.why !== undefined && { why: f.why }),
      ...(progress !== undefined && { progress }),
    }
  }
  function lineFileOut(f: OutFile): LineFile {
    const rec = readBlobs().find(b => b.id === f.blob)
    const progress = files.progress(f.blob)
    return {
      state: rec?.state ?? 'up',
      name: f.name,
      type: f.type,
      size: f.size,
      ...(f.url && { url: f.url }),
      ...(rec?.code && { why: rec.code }),
      ...(progress !== undefined && { progress }),
    }
  }
  const lineFileDraft = (f: DraftFile): LineFile => ({ state: 'draft', name: f.name, size: f.size })

  function setHandler(key: string, handler: SessionRef | null): boolean {
    return changeThreads(threads => {
      const t = Object.hasOwn(threads, key) ? threads[key] : undefined
      if (t) t.handler = handler
      return !!t
    })
  }

  const keyOf = (thread: string | undefined, peer: string): string => thread ?? threadKey(peer, GENERAL)

  /** A thread's messages either way, as kept: what came in with its peer, and each post's copies. */
  function threadItems(key: string): { incoming: [string, InboxItem][]; posts: Map<string, OutboxItem[]> } | null {
    const parts = splitKey(key)
    if (!parts) return null
    const team = parts.scope === TEAM
    if (!team && !isPeerId(parts.scope)) return null
    const inLists: [string, InboxItem[]][] = team
      ? Object.entries(readAllInbox())
      : [[parts.scope, readInbox(parts.scope)]]
    const incoming = inLists.flatMap(([peer, list]) =>
      list.filter(i => keyOf(i.thread, peer) === key).map((i): [string, InboxItem] => [peer, i]),
    )
    const outLists = team ? Object.values(readAllOutbox()) : [readOutbox(parts.scope)]
    const posts = new Map<string, OutboxItem[]>()
    for (const list of outLists)
      for (const o of list) {
        if (keyOf(o.thread, o.msg.to) !== key) continue
        const id = o.post ?? o.msg.id
        posts.set(id, [...(posts.get(id) ?? []), o])
      }
    return { incoming, posts }
  }

  /**
   * A line of a thread as the wire names it in a reply (#370): a message by its id, a team post by
   * its post id (the sender's first copy's, carried on every copy); null when the thread has no
   * such line, or it is held.
   */
  function wireId(key: string, line: string): string | null {
    const items = isMessageId(line) ? threadItems(key) : null
    if (!items) return null
    const i = items.incoming.find(([, x]) => x.id === line)?.[1]
    if (i) return i.held ? null : (i.post ?? i.id)
    return items.posts.has(line) ? line : null
  }

  /** A thread's lines (#216): what came in and went out in it, a team post once with its receipts, then its drafts. */
  function threadLines(key: string): ThreadLine[] {
    const parts = splitKey(key)
    const items = threadItems(key)
    if (!parts || !items) return []
    const team = parts.scope === TEAM
    // What a reply names, as a line here (#370): a message by its own id, a post by its id or any
    // copy's, then a team copy by the post id it carries. The first to claim a name keeps it, so a
    // copy cannot take over the name of a message that came before it; a post id two senders carry
    // (one of them copied it) names nothing, and a held copy claims none.
    const lineOf = new Map<string, string>()
    const claim = (name: string | undefined, id: string): void => {
      if (name && !lineOf.has(name)) lineOf.set(name, id)
    }
    for (const [, i] of items.incoming) claim(i.id, i.id)
    for (const [id, copies] of items.posts) {
      claim(id, id)
      for (const c of copies) claim(c.msg.id, id)
    }
    const senders = new Map<string, Set<string>>()
    for (const [peer, i] of items.incoming)
      if (i.post && !i.held) senders.set(i.post, new Set([...(senders.get(i.post) ?? []), peer]))
    for (const [, i] of [...items.incoming].sort((a, b) => a[1].receivedAt - b[1].receivedAt))
      if (i.post && !i.held && senders.get(i.post)?.size === 1) claim(i.post, i.id)
    const answers = (name: string | undefined): { replyTo?: string } =>
      name ? { replyTo: lineOf.get(name) ?? name } : {}
    const incoming: ThreadLine[] = items.incoming.map(
      ([peer, i]): ThreadLine => ({
        id: i.id,
        dir: 'in',
        from: peer,
        who: nameOf(peer),
        text: i.held ? null : i.text,
        ts: i.ts,
        ...(i.held && { held: true }),
        ...(i.via && { via: i.via }),
        ...(i.agent && { agent: i.agent }),
        ...(!i.held && answers(i.replyTo)),
        ...(i.file && !i.held && { file: lineFileIn(i.file, i.file.ref?.blob) }),
      }),
    )
    const outgoing: ThreadLine[] = [...items.posts.entries()].map(([id, copies]): ThreadLine => {
      const first = copies[0] as OutboxItem
      return {
        id,
        dir: 'out',
        text: first.msg.body.text,
        ts: first.msg.ts,
        ...(first.msg.body.via && { via: first.msg.body.via }),
        ...(first.session?.name && { agent: first.session.name }),
        ...(first.pressed && { pressed: true }),
        ...(first.file && { file: lineFileOut(first.file) }),
        ...(team
          ? { receipts: copies.map(c => ({ peer: c.msg.to, name: nameOf(c.msg.to), state: c.state })) }
          : { state: first.state, ...(first.code && { code: first.code }) }),
        ...answers(first.replyTo),
      }
    })
    const drafts: ThreadLine[] = readDrafts()
      .filter(d => d.to === parts.scope && threadKey(parts.scope, d.thread?.id ?? GENERAL) === key)
      .map(
        (d): ThreadLine => ({
          id: d.id,
          dir: 'draft',
          text: d.text,
          ts: new Date(d.createdAt).toISOString(),
          via: 'agent',
          ...(d.session?.name && { agent: d.session.name }),
          ...(d.reason && { reason: d.reason }),
          ...answers(d.replyTo),
          ...(d.file && { file: lineFileDraft(d.file) }),
        }),
      )
    return [...[...incoming, ...outgoing].sort((a, b) => a.ts.localeCompare(b.ts)), ...drafts]
  }

  /** A file an agent attached to a draft (#371): a regular file within what the hub takes, under a name a meta can carry. */
  function checkDraftFile(file: PostFile): { ok: true; size: number; max: number } | { ok: false; error: string } {
    try {
      const st = statSync(file.path)
      if (!st.isFile()) return { ok: false, error: 'file' }
      // Before the hub said its limit (offline, an older hub), the default one holds.
      const max = (hubFiles?.max ?? DEFAULT_MAX_FILE_BYTES) - NONCE_BYTES - TAG_BYTES
      if (st.size > max) return { ok: false, error: 'file_big' }
      if (!checkMeta({ name: file.name, type: mimeOf(file.name), size: st.size }))
        return { ok: false, error: 'file_name' }
      return { ok: true, size: st.size, max }
    } catch {
      return { ok: false, error: 'file' }
    }
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
          threads: hasThreads(p),
          ...(canFile(p) && { files: true }),
          ...(hasAssistant(p) && { assistant: true }),
        })),
        ...(hubFiles && { files: { max: hubFiles.max - NONCE_BYTES - TAG_BYTES } }),
      }
    },
    thread(peer) {
      if (!config() || !isPeerId(peer)) return []
      const known = roster.find(p => p.peer === peer)?.name ?? readPins()[peer]?.name
      const who = known ?? fingerprint(peer).slice(0, 14).trim()
      // Everything with this peer, the team's copies too: the panel shows one flat thread until
      // #355 draws the threads (threadLines).
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
    async send(to, text, thread, replyTo, file) {
      const r = await post({ to, ...(thread && { thread }), ...(replyTo && { replyTo }) }, text, { by: 'ui' }, file)
      return r.ok ? { ok: true, id: r.id, thread: r.thread } : r
    },
    post,
    draft(to, text, more = {}) {
      if (!config()) return { ok: false, error: 'off' }
      if (to !== TEAM && (!isPeerId(to) || !roster.some(p => p.peer === to))) return { ok: false, error: 'peer' }
      const body = text.trim()
      const { file, ...rest } = more
      if ((!body && !file) || body.length > MAX_TEXT) return { ok: false, error: 'text' }
      const id = crypto.randomUUID()
      // The draft keeps a copy of the file as it is now: a change to it later changes nothing (#371).
      let kept: DraftFile | undefined
      if (file) {
        const checked = checkDraftFile(file)
        if (!checked.ok) return checked
        try {
          const path = keepDraftFile(id, file.path)
          // The file may have grown between the look and the copy: the copy is what counts.
          const size = statSync(path).size
          if (size > checked.max) {
            dropDraftFile(path)
            return { ok: false, error: 'file_big' }
          }
          kept = { path, name: file.name, size }
        } catch {
          return { ok: false, error: 'file' }
        }
      }
      if (!addDraft({ id, to, text: body, createdAt: clock.now(), ...rest, ...(kept && { file: kept }) }, MAX_DRAFTS)) {
        if (kept) dropDraftFile(kept.path)
        return { ok: false, error: 'full' }
      }
      audit('draft', to === TEAM ? null : to, {
        id,
        ...(more.reason && { reason: more.reason }),
        ...(kept && { size: kept.size }),
      })
      changed()
      return { ok: true, id }
    },
    threads() {
      if (!config()) return []
      return Object.entries(readThreads())
        .map(([key, r]): ThreadView => ({ key, ...r, peerName: r.scope === TEAM ? null : nameOf(r.scope) }))
        .sort((a, b) => b.lastAt - a.lastAt)
    },
    threadLines: key => (config() ? threadLines(key) : []),
    lasts() {
      if (!config()) return {}
      const out: Record<string, ThreadLast> = {}
      const put = (key: string, l: ThreadLast): void => {
        const was = out[key]
        if (!was || was.ts < l.ts) out[key] = l
      }
      // A line of it is enough for the list; the thread itself shows the whole text.
      const line = (text: string): string => [...text.slice(0, LAST_CHARS + 1)].slice(0, LAST_CHARS).join('')
      for (const [peer, list] of Object.entries(readAllInbox()))
        for (const i of list)
          put(keyOf(i.thread, peer), {
            dir: 'in',
            who: nameOf(peer),
            text: i.held ? null : line(i.text),
            ts: i.ts,
            ...(i.via && { via: i.via }),
          })
      for (const list of Object.values(readAllOutbox()))
        for (const o of list)
          put(keyOf(o.thread, o.msg.to), {
            dir: 'out',
            text: line(o.text ?? o.msg.body.text),
            ts: o.msg.ts,
            ...(o.msg.body.via && { via: o.msg.body.via }),
          })
      return out
    },
    nameOf,
    addMembers(key, peers) {
      if (!config()) return { ok: false, error: 'off' }
      const all = readThreads()
      const rec = Object.hasOwn(all, key) ? all[key] : undefined
      if (!rec?.members || rec.by !== 'me') return { ok: false, error: 'thread' }
      if (!peers.length || !peers.every(p => roster.some(r => r.peer === p))) return { ok: false, error: 'peer' }
      const list = channelMembers([...new Set([...rec.members, ...peers])])
      if (!list) return { ok: false, error: 'members' }
      changeThreads(threads => {
        const t = Object.hasOwn(threads, key) ? threads[key] : undefined
        if (t) t.members = list
      })
      audit('members', null, { thread: key, added: peers.length, members: list.length })
      changed()
      return { ok: true }
    },
    setThread(key, change) {
      if (!config()) return false
      // No such thread: nothing to change, and no file made for it.
      if (!Object.hasOwn(readThreads(), key)) return false
      const ok = changeThreads(threads => {
        const t = Object.hasOwn(threads, key) ? threads[key] : undefined
        if (!t) return false
        if (change.handler !== undefined) t.handler = change.handler
        if (change.muted !== undefined) t.muted = change.muted
        return true
      })
      if (ok) changed()
      return ok
    },
    async sendDraft(id) {
      if (!config()) return { ok: false, error: 'off' }
      if (!isMessageId(id)) return { ok: false, error: 'draft' }
      // Taken out first, so a second press finds nothing; put back when the send is refused.
      const d = takeDraft(id)
      if (!d) return { ok: false, error: 'draft' }
      // A reply an agent wrote (#373) still answers its message when the owner sends it; when that
      // message is gone from this board by then, it goes as a plain message rather than never.
      const target = { to: d.to, ...(d.thread && { thread: d.thread }) }
      const source = { by: 'agent' as const, ...(d.session && { session: d.session }), pressed: true }
      const file = d.file && { path: d.file.path, name: d.file.name }
      let r: PostResult = { ok: false, error: 'draft' }
      try {
        r = await post({ ...target, ...(d.replyTo && { replyTo: d.replyTo }) }, d.text, source, file)
        if (!r.ok && r.error === 'reply' && d.replyTo) r = await post(target, d.text, source, file)
      } finally {
        // Put back when the send is refused, or throws: a draft is never lost on the way.
        if (!r.ok) addDraft(d, Number.MAX_SAFE_INTEGER)
      }
      if (r.ok) {
        if (d.file) dropDraftFile(d.file.path)
        audit('draft_sent', d.to === TEAM ? null : d.to, { id })
        // The session that wrote it hears the answers, as it would have had it gone at once (#216).
        const t = readThreads()[r.thread]
        if (d.session && t && t.id !== GENERAL && !t.handler && readAgents().listener?.key !== d.session.key)
          setHandler(r.thread, d.session)
      }
      changed()
      return r.ok ? { ok: true, id: r.id } : r
    },
    discardDraft(id) {
      if (!config() || !isMessageId(id)) return false
      const d = takeDraft(id)
      if (d) {
        if (d.file) dropDraftFile(d.file.path)
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
        // The box the roster has for it now is the one files are sealed to from here on (#371).
        const box = boxes.get(peer)
        if (box) p.box = box
        for (const [id, x] of Object.entries(pins)) if (id !== peer && x.name === p.name) delete pins[id]
        return true
      })
      if (ok) {
        releaseHeld(peer)
        audit('trust', peer)
        changed()
        files.kick()
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
