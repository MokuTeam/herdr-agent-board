// The assistant bridge (#384, phases 1 and 3, issues #386 and #388): one hub peer for a NanoClaw
// assistant. Hub messages go to the host assistant's inbox topic, or to the place a thread is bound
// to; the ones addressed to the assistant wake it, the rest wait for a scheduled read. The assistant
// writes back with hub_send from any topic: a new topic is bound to the topic it came from, so the
// answers come back there. The allow list decides who is heard at all; the hub cannot.
//
// Other agent groups of the same NanoClaw are places too (`group:<id>`, design 6.2). A new topic
// whose title starts with `[<alias>]` goes to that alias's place and stays bound there (rule 3 of
// 4.2). A group speaks only in its own threads, opens new topics only with an owner, and its
// hub_inbox shows only its own; the host assistant keeps reaching everything.
import { randomUUID } from 'node:crypto'
import {
  ackBytes,
  DEFAULT_TTL_S,
  type Envelope,
  GENERAL,
  hasReplies,
  hasThreads,
  type KeyPair,
  MAX_TEXT,
  type Message,
  type RosterPeer,
  sealEnvelope,
  TEAM_PROTOCOL,
  type ThreadRef,
  validTitle,
  verify,
} from '../../src/core/team.ts'
import {
  DEFAULT_LIMITS,
  inboundKey,
  legacyText,
  secretHit,
  splitKey,
  TEAM,
  threadKey,
} from '../../src/core/team-agents.ts'
import type { BridgeConfig, Role } from './config.ts'
import { type Clock, createHubLink, type HubLink, type LinkState, realClock, type WsLike } from './hub-link.ts'
import { listenModule, type ModuleSocket } from './module-socket.ts'
import {
  batchRow,
  capNotice,
  changedNotice,
  delivered,
  type HeaderParts,
  header,
  inboxText,
  loopNotice,
  newTopicNotice,
  nextBatchAt,
  nextRun,
  REFUSE_EVERY_MS,
  refOf,
  refusalText,
  type Scope,
  wakeOrBatch,
} from './policy.ts'
import {
  BRIDGE_PROTOCOL,
  type BridgeFrame,
  type InboxArgs,
  type Location,
  type ModuleFrame,
  type SendArgs,
  type Topic,
} from './protocol.ts'
import type { Store, StoredMessage, Thread } from './store.ts'

/** The inbox, inside the bridge; the module hears the inbox topic's real thread id. */
export const INBOX: Location = 'host:inbox'
/** What the bridge says it understands (design 4.7). */
export const BRIDGE_CAPS = ['threads', 'replies', 'channels', 'assistant']
const HOUR = 3600_000
const SELF = 'self'

export interface BridgeStatus {
  link: LinkState
  module: boolean
  name: string | null
  inbox: Location | null
  counts: Record<string, number>
}

export interface BridgeOptions {
  cfg: BridgeConfig
  store: Store
  key: KeyPair
  log: (line: string) => void
  clock?: Clock
  version?: string
  /** The hub's WebSocket (tests). */
  socket?: (url: string) => WsLike
  random?: () => number
  onStatus?: (s: BridgeStatus) => void
}

export interface Bridge {
  start(): Promise<void>
  stop(): Promise<void>
  /** A new config (SIGHUP): the allow list and the rest; pins and held messages are looked at again. */
  reload(cfg: BridgeConfig): void
  status(): BridgeStatus
}

export function createBridge(o: BridgeOptions): Bridge {
  const clock = o.clock ?? realClock
  const store = o.store
  let cfg = o.cfg
  let myName: string | null = null
  const roster = new Map<string, RosterPeer>()
  let topics: Topic[] = []
  let inboxTopic: Location | null = null
  let mod: ModuleSocket | null = null
  /** Jobs sent on the module's current connection, so a pump does not send them twice. */
  const sent = new Set<string>()
  let pumpTimer: unknown
  let pruneTimer: unknown

  const status = (): BridgeStatus => ({
    link: link.state(),
    module: mod?.connected() ?? false,
    name: myName,
    inbox: inboxTopic,
    counts: store.counts(),
  })
  const changed = (): void => o.onStatus?.(status())

  // ---- who is who

  const allowEntry = (name: string) => cfg.allow.find(a => a.name === name)
  /** The role of a peer key: a trusted pin of a name on the allow list. */
  function roleOf(peer: string): Role | null {
    const pin = store.pins().find(p => p.peer === peer && p.status === 'trusted')
    return pin ? (allowEntry(pin.name)?.role ?? null) : null
  }
  const heldBy = (peer: string): boolean => store.pins().some(p => p.status === 'changed' && p.seen === peer)
  const nameOf = (peer: string): string =>
    roster.get(peer)?.name ?? store.pins().find(p => p.peer === peer)?.name ?? peer.slice(0, 10)
  const ownerName = (): string => cfg.allow.find(a => a.role === 'owner')?.name ?? 'its owner'

  /** Pins every allowed name to a key: the config's when it names one, else the first the roster shows. */
  function pinAllowed(): void {
    const now = clock.now()
    const pins = new Map(store.pins().map(p => [p.name, p]))
    for (const a of cfg.allow) {
      const pin = pins.get(a.name)
      if (a.peer) {
        if (!pin || pin.peer !== a.peer || pin.status !== 'trusted') store.pin(a.name, a.peer, now)
        continue
      }
      const seen = [...roster.values()].find(p => p.name === a.name)
      if (!seen) continue
      if (!pin) store.pin(a.name, seen.peer, now)
      else if (pin.peer !== seen.peer && store.markChanged(a.name, seen.peer, now)) notice(changedNotice(a.name))
    }
    for (const p of store.pins()) if (!allowEntry(p.name)) store.unpin(p.name)
  }

  // ---- locations

  const findTopic = (s: string): Topic | undefined =>
    topics.find(t => t.id === s) ?? topics.find(t => t.name !== undefined && t.name.toLowerCase() === s.toLowerCase())
  /**
   * The inbox topic's place: the module's topic with that id or name. A name the module does not
   * list (the topic is not made yet, or the bot has not seen a message in it) leaves the inbox
   * unresolved, and what is for the inbox waits in the store: sent to a guessed place, the module
   * would drop it. A value with a colon is taken as a thread id as it is.
   */
  function resolveInbox(): void {
    const want = cfg.inbox.topic.startsWith('host:') ? cfg.inbox.topic.slice(5) : cfg.inbox.topic
    const found = findTopic(want)
    if (found || want.includes(':')) {
      inboxTopic = `host:${found?.id ?? want}`
      return
    }
    if (topics.length > 0)
      o.log(
        `config: the host assistant has no topic "${want}" yet; hub messages for the inbox wait until it does (write once in the topic, then restart the bridge)`,
      )
    inboxTopic = null
  }
  const toModule = (loc: Location): Location | null => (loc === INBOX ? inboxTopic : loc)
  const fromModule = (loc: Location): Location => (loc === inboxTopic ? INBOX : loc)
  /** The agent group a location is in; null for the host assistant's topics. */
  const groupOf = (loc: Location): string | null => (loc.startsWith('group:') ? (loc.slice(6).split('/')[0] ?? null) : null)
  /** A published `at` as a location. */
  function placeOf(at: string): Location {
    if (at === 'host:inbox') return INBOX
    if (at.startsWith('group:')) return at as Location
    return resolvePublished(at)
  }
  /**
   * The name the assistant writes under from a location: its published alias; in a group, the
   * group's alias wherever in it; else `host` (or `group` for a group published under no alias).
   */
  function aliasOf(loc: Location): string {
    for (const p of cfg.publish) if (placeOf(p.at) === loc) return p.alias
    const g = groupOf(loc)
    if (g === null) return 'host'
    return cfg.publish.find(p => p.at.startsWith('group:') && groupOf(p.at as Location) === g)?.alias ?? 'group'
  }
  /**
   * Rule 3 of 4.2: a new pair topic titled `[<alias>] ...` goes to that alias's place, when the alias
   * is published to the sender (owners always, members when the entry says so). Null: the inbox.
   */
  function titledPlace(title: string, role: Role): Location | null {
    const m = /^\s*\[([a-z0-9][a-z0-9-]{0,31})\]/i.exec(title)
    const alias = m?.[1]?.toLowerCase()
    const p = alias ? cfg.publish.find(x => x.alias === alias) : undefined
    if (!p || (role !== 'owner' && !p.members)) return null
    const loc = placeOf(p.at)
    return loc === INBOX ? null : loc
  }
  /** Whether a thread is bound into the group (a group's hub tools reach only those). */
  const inGroup = (t: Thread, g: string): boolean => t.location !== null && groupOf(t.location) === g
  function resolvePublished(at: string): Location {
    const s = at.slice(5)
    const t = findTopic(s)
    const loc: Location = `host:${t?.id ?? s}`
    return loc === inboxTopic ? INBOX : loc
  }
  const aliases = (): string[] => cfg.publish.map(p => p.alias)

  // ---- jobs for the module

  function addJob(
    kind: 'deliver' | 'schedule' | 'notice',
    location: Location,
    trigger: 0 | 1,
    text: string,
    due: number,
  ): void {
    store.addJob({ id: randomUUID(), kind, location, trigger, text, due, createdAt: clock.now() })
  }
  function notice(text: string): void {
    if (cfg.inbox.notice === 'none' && text.startsWith('hub: new ')) return
    addJob('notice', INBOX, 0, text, clock.now())
  }

  /** Sends what is open and due; sets a timer for the next deliver that is not due yet. */
  function pump(): void {
    if (pumpTimer !== undefined) clock.clearTimeout(pumpTimer)
    pumpTimer = undefined
    if (!mod?.connected()) return
    const now = clock.now()
    let next = Number.POSITIVE_INFINITY
    for (const j of store.openJobs()) {
      if (sent.has(j.id)) continue
      if (j.kind === 'deliver' && j.due > now) {
        next = Math.min(next, j.due)
        continue
      }
      const at = toModule(j.location)
      if (!at) continue
      let f: BridgeFrame
      if (j.kind === 'deliver') f = { t: 'deliver', id: j.id, at, trigger: j.trigger, text: j.text }
      else if (j.kind === 'schedule')
        f = { t: 'schedule', id: j.id, at, when: new Date(j.due).toISOString(), text: j.text }
      else f = { t: 'notice', id: j.id, at, text: j.text }
      if (mod.send(f)) sent.add(j.id)
    }
    if (next !== Number.POSITIVE_INFINITY) pumpTimer = clock.setTimeout(pump, Math.max(0, next - now))
  }

  /** A wake for a location, held to the gap after the last one (design 5.2): close messages share it. */
  function queueWake(location: Location, text: string): void {
    const now = clock.now()
    const gap = cfg.wake.gapSec * 1000
    const last = store.lastWake(location)
    const due = !last ? now : last.due > now ? last.due : now - last.due < gap ? last.due + gap : now
    addJob('deliver', location, 1, text, due)
  }

  /** The next batch read for a location, unless one is ahead already (design 5.3). */
  function ensureSchedule(location: Location): void {
    const now = clock.now()
    if (store.pendingSchedule(location, now)) return
    addJob('schedule', location, 1, batchRow(), nextBatchAt(now, cfg.batch.at))
  }

  // ---- inbound

  const scopeOf = (ref: ThreadRef | undefined): Scope => (ref?.group ? (ref.members ? 'channel' : 'team') : 'pair')

  function headerFor(m: StoredMessage, t: Thread, role: Role): HeaderParts {
    const scope: Scope = t.scope === TEAM ? (t.members ? 'channel' : 'team') : 'pair'
    return {
      scope,
      name: m.name,
      peer: m.peer,
      role,
      ...(m.agent && { agent: m.agent }),
      ref: refOf(t.scope, t.id, t.scope === TEAM ? null : nameOf(t.scope)),
      ...(t.title && { title: t.title }),
      msgId: m.id,
      ...(m.replyTo && { replyTo: m.replyTo }),
      ...(t.members && { members: t.members.map(nameOf) }),
    }
  }

  /** A kept message from an allowed peer goes where its thread goes, waking or waiting. */
  function route(m: StoredMessage, t: Thread, role: Role, isNew: boolean): void {
    const now = clock.now()
    const location = t.location ?? INBOX
    const ref = refOf(t.scope, t.id, t.scope === TEAM ? null : nameOf(t.scope))
    const run = nextRun(t.run, m.via ?? undefined)
    const paused = run >= cfg.loop
    let told = paused ? t.pauseTold : false
    if (paused && !told) {
      notice(loopNotice(ref, run))
      told = true
    }
    store.setRun(t.key, run, told)
    const scope: Scope = t.scope === TEAM ? (t.members ? 'channel' : 'team') : 'pair'
    const d = wakeOrBatch({
      scope,
      text: m.text,
      names: [myName ?? cfg.name, ...aliases()],
      ours: t.by === SELF,
      paused,
      wakesLastHour: store.wakesSince(now - HOUR),
      maxPerHour: cfg.wake.maxPerHour,
    })
    if (d.why === 'cap' && store.tellOnce('cap', now - HOUR, now)) notice(capNotice(cfg.wake.maxPerHour))
    if (isNew && t.id !== GENERAL && t.title)
      notice(newTopicNotice(scope, m.name, m.peer, t.title) + (location === INBOX ? '' : ` (to ${aliasOf(location)})`))
    store.setState(m.id, d.wake ? 'delivered' : 'batched')
    store.touchThread(t.key, now)
    if (d.wake) queueWake(location, delivered(headerFor(m, t, role), m.text))
    else ensureSchedule(location)
  }

  async function onMessage(msg: Message): Promise<void> {
    if (store.hasMessage(msg.id)) return
    const now = clock.now()
    const ref = msg.body.thread
    const key = inboundKey(msg.from, ref)
    const role = roleOf(msg.from)
    const held = !role && heldBy(msg.from)
    const name = nameOf(msg.from)
    const base: StoredMessage = {
      id: msg.id,
      thread: key,
      dir: 'in',
      peer: msg.from,
      name,
      via: msg.body.via ?? null,
      agent: msg.body.agent ?? null,
      text: msg.body.text,
      replyTo: msg.body.replyTo ?? null,
      ts: msg.ts,
      at: now,
      state: role ? 'batched' : held ? 'held' : 'dropped',
      location: null,
    }
    if (!role && !held) {
      // Kept as dropped for the count and the dedupe; the text goes with the next prune.
      store.addMessage({ ...base, text: '' })
      if (scopeOf(ref) === 'pair' && cfg.refuse === 'once') await refuse(msg.from)
      changed()
      return
    }
    // A thread already known keeps its place (rule 2); only a new topic is placed by its title.
    const place =
      role && ref?.title && scopeOf(ref) === 'pair' && !store.thread(key) ? titledPlace(ref.title, role) : null
    const isNew = store.addThread({
      key,
      scope: splitKey(key)?.scope ?? msg.from,
      id: ref?.id ?? GENERAL,
      title: ref?.title ?? null,
      members: ref?.members ?? null,
      by: msg.from,
      createdAt: now,
      location: place,
    })
    const t = store.thread(key)
    if (!t) return
    store.addMessage({ ...base, location: t.location ?? INBOX })
    if (role) route({ ...base, location: t.location ?? INBOX }, t, role, isNew)
    pump()
    changed()
  }

  /** Held messages of keys trusted since (after a reload): routed now, in order. */
  function releaseHeld(): void {
    for (const m of store.byState(['held'], null)) {
      const role = roleOf(m.peer)
      const t = store.thread(m.thread)
      if (!role || !t) continue
      route(m, t, role, false)
    }
    pump()
  }

  async function refuse(peer: string): Promise<void> {
    const now = clock.now()
    const last = store.refusedAt(peer)
    if (last !== null && now - last < REFUSE_EVERY_MS) return
    store.refused(peer, now)
    await post(peer, refusalText(ownerName()), undefined, 'bridge')
  }

  // ---- outbound

  /** Seals and queues a message; sent now when online, else after the next welcome. */
  async function post(
    peer: string,
    text: string,
    thread: ThreadRef | undefined,
    agent: string,
    replyTo?: string,
  ): Promise<Message> {
    const rp = roster.get(peer)
    const withThread = thread && hasThreads(rp)
    const msg: Message = {
      v: TEAM_PROTOCOL,
      id: randomUUID(),
      from: o.key.pub,
      to: peer,
      kind: 'question',
      reply_to: null,
      ts: new Date(clock.now()).toISOString(),
      ttl_s: DEFAULT_TTL_S,
      body: {
        text: withThread || !thread ? text : legacyText(text, thread),
        via: 'agent',
        agent,
        ...(withThread && { thread }),
        ...(replyTo && hasReplies(rp) && { replyTo }),
      },
    }
    const env = await sealEnvelope(o.key, msg)
    store.addOut({ id: msg.id, to: peer, env: JSON.stringify(env), state: 'queued', at: clock.now() })
    link.send(env)
    return msg
  }

  /** A thread named by the agent: a topic's id start, `general:<name>`, `team`. */
  function findThread(ref: string): Thread | null {
    const r = ref.trim()
    if (r === TEAM) return store.thread(threadKey(TEAM, GENERAL))
    if (r.startsWith('general:')) {
      const who = r.slice(8)
      const pin = store.pins().find(p => p.name.toLowerCase() === who.toLowerCase() && p.status === 'trusted')
      if (!pin) return null
      return (
        store.thread(threadKey(pin.peer, GENERAL)) ?? {
          key: threadKey(pin.peer, GENERAL),
          scope: pin.peer,
          id: GENERAL,
          title: null,
          members: null,
          by: pin.peer,
          createdAt: clock.now(),
          location: null,
          run: 0,
          pauseTold: false,
          lastAt: 0,
        }
      )
    }
    if (r.length < 8) return null
    const hits = store.threads().filter(t => t.id !== GENERAL && t.id.startsWith(r.toLowerCase()))
    return hits.length === 1 ? (hits[0] ?? null) : null
  }

  const no = (why: string) => ({ ok: false, text: `not sent: ${why}` })

  async function handleSend(from: Location, a: SendArgs): Promise<{ ok: boolean; text: string }> {
    const now = clock.now()
    const text = a.text
    if (!text.trim()) return no('the text is empty')
    if (text.length > MAX_TEXT) return no(`the text is longer than ${MAX_TEXT} characters`)
    const secret = secretHit(text)
    if (secret) return no(`it looks like it carries ${secret}; secrets never go into a hub thread`)

    let t: Thread | null = null
    let fresh: { peer: string; id: string; title: string } | null = null
    if (a.thread) {
      t = findThread(a.thread)
      if (!t) return no(`there is no hub thread ${a.thread} (hub_inbox and the message headers show the refs)`)
    } else if (a.to) {
      const pin = store.pins().find(p => p.name.toLowerCase() === a.to?.toLowerCase() && p.status === 'trusted')
      if (a.to.toLowerCase() === TEAM) return no('the bridge does not post to the team chat')
      if (!pin || !roleOf(pin.peer)) return no(`${a.to} is not on the bridge's allow list`)
      if (a.title !== undefined) {
        if (!validTitle(a.title)) return no('the title must be 1 to 80 characters on one line')
        fresh = { peer: pin.peer, id: randomUUID(), title: a.title }
      } else t = findThread(`general:${pin.name}`)
    } else {
      const newest = store.newestIn(from)
      t = newest ? store.thread(newest.thread) : null
      if (!t) return no('no hub thread here to answer; give to (with a title for a new topic) or thread')
    }
    if (t && t.scope === TEAM) return no('the bridge does not post to the team chat or a channel')
    const group = groupOf(from)
    if (group !== null && t && !inGroup(t, group))
      return no(
        `that hub thread is not this group's; a group answers only in its own threads, or opens a new topic with ${ownerName()} (to and title)`,
      )
    const peer = fresh?.peer ?? t?.scope ?? ''
    if (!roleOf(peer)) return no(`${nameOf(peer)} is not on the bridge's allow list`)
    if (group !== null && fresh && roleOf(peer) !== 'owner')
      return no(`a group opens new hub topics only with ${ownerName()}`)
    const key = fresh ? threadKey(peer, fresh.id) : (t?.key ?? '')
    if (t && t.run >= cfg.loop) return no('loop pause: a person has to write in the thread first')

    // The board's limits for an agent (design 5.4).
    if (store.sentSince(now - HOUR, { location: from }).length >= DEFAULT_LIMITS.sessionHour)
      return no(`${DEFAULT_LIMITS.sessionHour} posts in the last hour from this topic; try later`)
    if (store.sentSince(now - HOUR, { peer }).length >= DEFAULT_LIMITS.peerHour)
      return no(`${DEFAULT_LIMITS.peerHour} posts in the last hour to ${nameOf(peer)}; try later`)
    if (store.sentSince(now - 24 * HOUR, { peer }).length >= DEFAULT_LIMITS.peerDay)
      return no(`${DEFAULT_LIMITS.peerDay} posts today to ${nameOf(peer)}; try tomorrow`)
    if (store.sentSince(now - DEFAULT_LIMITS.echoMin * 60_000, { thread: key }).some(m => m.text === text))
      return no('the same text went to that thread a few minutes ago')

    let replyTo: string | undefined
    if (a.replyTo) {
      const m = store.messageByRef(a.replyTo)
      if (!m || m.thread !== key) return no(`there is no message ${a.replyTo} in that thread`)
      replyTo = m.id
    }

    const threadRef: ThreadRef | undefined = fresh
      ? { id: fresh.id, title: fresh.title }
      : t && t.id !== GENERAL
        ? { id: t.id, ...(t.title && { title: t.title }) }
        : undefined
    if (fresh)
      store.addThread({
        key,
        scope: peer,
        id: fresh.id,
        title: fresh.title,
        members: null,
        by: SELF,
        createdAt: now,
        location: from === INBOX ? null : from,
      })
    else if (t && !store.thread(t.key)) store.addThread({ ...t })
    const msg = await post(peer, text, threadRef, aliasOf(from), replyTo)
    store.addMessage({
      id: msg.id,
      thread: key,
      dir: 'out',
      peer,
      name: nameOf(peer),
      via: 'agent',
      agent: aliasOf(from),
      text,
      replyTo: replyTo ?? null,
      ts: msg.ts,
      at: now,
      state: 'sent',
      location: from,
    })
    const after = store.thread(key)
    if (after) store.setRun(key, nextRun(after.run, 'agent'), after.pauseTold)
    store.touchThread(key, now)
    changed()
    const ref = refOf(peer, fresh?.id ?? t?.id ?? GENERAL, nameOf(peer))
    return {
      ok: true,
      text: `ok · sent to ${nameOf(peer)} in thread ${ref}${link.state() === 'online' ? '' : ' (goes out when the hub is back)'}`,
    }
  }

  function handleInbox(from: Location, a: InboxArgs): { ok: boolean; text: string } {
    const group = groupOf(from)
    // A group reads what waits anywhere in it; a host topic reads its own.
    let items =
      group === null
        ? store.byState(['batched'], from)
        : store.byState(['batched'], null).filter(m => m.location !== null && groupOf(m.location) === group)
    if (a.thread) {
      const t = findThread(a.thread)
      if (!t) return { ok: false, text: `there is no hub thread ${a.thread}` }
      if (group !== null && !inGroup(t, group)) return { ok: false, text: `hub thread ${a.thread} is not this group's` }
      items = items.filter(m => m.thread === t.key)
    }
    const shown = items.flatMap(m => {
      const t = store.thread(m.thread)
      const role = roleOf(m.peer)
      return t && role ? [{ head: header(headerFor(m, t, role)), text: m.text, id: m.id }] : []
    })
    for (const s of shown) store.setState(s.id, 'read')
    changed()
    return { ok: true, text: inboxText(shown, a.full === true) }
  }

  function onModule(f: ModuleFrame): void {
    switch (f.t) {
      case 'hello':
        topics = f.topics
        resolveInbox()
        sent.clear()
        mod?.send({ t: 'welcome', v: BRIDGE_PROTOCOL })
        pump()
        changed()
        return
      case 'confirm':
        store.confirm(f.id, clock.now())
        changed()
        return
      case 'call': {
        const from = fromModule(f.from)
        const answer = (r: { ok: boolean; text: string }) =>
          mod?.send({ t: 'result', req: f.req, ok: r.ok, text: r.text })
        if (f.op === 'send')
          void handleSend(from, f.args)
            .then(answer)
            .catch(err => answer({ ok: false, text: `not sent: ${err instanceof Error ? err.message : String(err)}` }))
        else answer(handleInbox(from, f.args))
        return
      }
    }
  }

  // ---- the hub

  const link: HubLink = createHubLink({
    hub: cfg.hub,
    key: o.key,
    caps: BRIDGE_CAPS,
    version: o.version ?? 'dev',
    clock,
    ...(o.random && { random: o.random }),
    ...(o.socket && { socket: o.socket }),
    log: o.log,
    onWelcome: name => {
      myName = name
      changed()
    },
    onRoster: peers => {
      roster.clear()
      for (const p of peers) if (p.peer !== o.key.pub) roster.set(p.peer, p)
      pinAllowed()
      pump()
      changed()
    },
    onPresence: f => {
      const p = roster.get(f.peer)
      if (!p) return
      const next: RosterPeer = { ...p, online: f.online, last_seen: f.at }
      if (f.online) {
        delete next.caps
        if (f.caps) next.caps = f.caps
      }
      roster.set(f.peer, next)
    },
    onMessage,
    onState: async f => {
      const out = store.out(f.id)
      if (!out) return
      if (f.state === 'acked') {
        const a = f.ack
        const ok =
          !!a &&
          a.by === out.to &&
          (await verify(a.by, ackBytes({ by: a.by, id: f.id, to: o.key.pub, ts: a.ts }), a.sig))
        store.setOut(f.id, ok ? 'acked' : 'delivered', f.at)
      } else store.setOut(f.id, f.state, f.at)
      changed()
    },
    onRefused: (id, code) => {
      if (!store.out(id)) return
      store.setOut(id, 'refused', clock.now())
      o.log(`hub: refused ${id.slice(0, 8)} (${code})`)
      changed()
    },
    unsettled: () => store.unsettled().map(i => JSON.parse(i.env) as Envelope),
    onStateChange: () => changed(),
  })

  return {
    start: async () => {
      mod = await listenModule({
        path: cfg.socket,
        log: o.log,
        onFrame: onModule,
        onClose: () => {
          sent.clear()
          changed()
        },
      })
      resolveInbox()
      store.prune(clock.now())
      pruneTimer = clock.setInterval(() => store.prune(clock.now()), HOUR)
      link.start()
      changed()
    },
    stop: async () => {
      link.stop()
      if (pumpTimer !== undefined) clock.clearTimeout(pumpTimer)
      if (pruneTimer !== undefined) clock.clearInterval(pruneTimer)
      pumpTimer = pruneTimer = undefined
      await mod?.close()
      mod = null
    },
    reload: next => {
      cfg = next
      pinAllowed()
      resolveInbox()
      releaseHeld()
      changed()
    },
    status,
  }
}
