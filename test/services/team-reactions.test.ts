import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stateDir, teamReactionsFile } from '../../src/adapters/paths.ts'
import { changeAgents, changePins, readReactions } from '../../src/adapters/team-store.ts'
import { ownerTeam } from '../../src/core/remote.ts'
import { type Envelope, generateKey, type KeyPair, type Message, OUR_CAPS } from '../../src/core/team.ts'
import { framedThread, teamAgents, threadData } from '../../src/entrypoints/team-agents-cli.ts'
import { teamRoutes } from '../../src/server/routes/team.ts'
import { createTeam, type InboundReactionEvent, type TeamService } from '../../src/services/team-hub.ts'
import { createTeamNotify } from '../../src/services/team-notify.ts'
import { createTeamRouter } from '../../src/services/team-router.ts'
import { fakeClock, msgOf, question, startHarness } from '../hub/harness.ts'
import { FakeWs, handshake, settle, setup, stopAll, until } from '../support/team-service.ts'

const liveServices: TeamService[] = []

afterEach(() => {
  for (const s of liveServices.splice(0)) s.stop()
  stopAll()
})

const CAPS_ALL = [...OUR_CAPS]
const CAPS_OLD = ['threads', 'channels', 'replies']
const sentMsgs = (ws: FakeWs): Message[] => ws.of('send').map(f => msgOf((f as { env: Envelope }).env))

async function deliver(
  ws: FakeWs,
  me: string,
  from: KeyPair,
  text: string,
  ts: string,
  body: Partial<Message['body']> = {},
): Promise<string> {
  const env = await question(from, me, text, { body: { text, ...body } as Message['body'] }, ts)
  const before = ws.of('ack').length
  ws.recv({ t: 'deliver', env })
  await until(() => ws.of('ack').length > before, 'ack')
  return msgOf(env).id
}

describe('reactions in team-hub, router, notify, CLI, and backward compat', () => {
  test('add, toggle, remove, and LWW convergence across out-of-order deliveries', async () => {
    const s = setup()
    const reactions: InboundReactionEvent[] = []
    s.svc.stop()
    const [A, B] = [await generateKey(), await generateKey()]
    s.svc.start()
    const { ws, me } = await handshake(s, [
      { peer: A.pub, name: 'anna', caps: CAPS_ALL },
      { peer: B.pub, name: 'ben', caps: CAPS_ALL },
    ])
    const m1 = await deliver(ws, me, A, 'ship it?', '2026-11-11T10:00:00.000Z')
    const key = `${A.pub}/general`

    // Add my reaction
    const r1 = await s.svc.react(key, m1, '👍', 'add')
    expect(r1).toEqual({ ok: true, copies: 1, skipped: [] })
    expect(s.svc.threadLines(key).find(l => l.id === m1)?.reactions).toEqual([
      { emoji: '👍', count: 1, me: true, peers: [] },
    ])
    expect(sentMsgs(ws).at(-1)?.body.react).toEqual({ to: m1, emoji: '👍', op: 'add' })

    // Anna also reacts 👍
    await deliver(ws, me, A, '👍', '2026-11-11T10:01:00.000Z', {
      react: { to: m1, emoji: '👍', op: 'add' },
    })
    expect(s.svc.threadLines(key).find(l => l.id === m1)?.reactions).toEqual([
      { emoji: '👍', count: 2, me: true, peers: ['anna'] },
    ])

    // Out-of-order older remove from Anna does not override her newer add
    await deliver(ws, me, A, '👍', '2026-11-11T10:00:30.000Z', {
      react: { to: m1, emoji: '👍', op: 'remove' },
    })
    expect(s.svc.threadLines(key).find(l => l.id === m1)?.reactions).toEqual([
      { emoji: '👍', count: 2, me: true, peers: ['anna'] },
    ])

    // Newer remove from Anna removes her reaction, mine stays
    await deliver(ws, me, A, '👍', '2026-11-11T10:02:00.000Z', {
      react: { to: m1, emoji: '👍', op: 'remove' },
    })
    expect(s.svc.threadLines(key).find(l => l.id === m1)?.reactions).toEqual([
      { emoji: '👍', count: 1, me: true, peers: [] },
    ])

    // Remove my reaction
    s.clock.skew(1000)
    await s.svc.react(key, m1, '👍', 'remove')
    expect(s.svc.threadLines(key).find(l => l.id === m1)?.reactions).toBeUndefined()
    expect(reactions).toEqual([])
  })

  test('held reactions from a changed peer key are hidden until trust(peer)', async () => {
    const s = setup()
    const A = await generateKey()
    s.svc.start()
    const { ws, me } = await handshake(s, [{ peer: A.pub, name: 'anna', caps: CAPS_ALL }])
    const out = await s.svc.send(A.pub, 'hi anna')
    if (!out.ok) throw new Error('send failed')

    changePins(pins => {
      pins[A.pub] = { name: 'anna', status: 'changed', at: 1 }
    })
    await deliver(ws, me, A, '👀', '2026-11-11T10:05:00.000Z', {
      react: { to: out.id, emoji: '👀', op: 'add' },
    })
    const key = `${A.pub}/general`
    expect(s.svc.threadLines(key).find(l => l.id === out.id)?.reactions).toBeUndefined()
    expect(readReactions()[0]?.held).toBe(true)

    expect(s.svc.trust(A.pub)).toBe(true)
    expect(s.svc.threadLines(key).find(l => l.id === out.id)?.reactions).toEqual([
      { emoji: '👀', count: 1, me: false, peers: ['anna'] },
    ])
  })

  test('old peer without reactions cap: messages work, no body.react sent to old peer', async () => {
    const s = setup()
    const [A, C] = [await generateKey(), await generateKey()]
    s.svc.start()
    const { ws, me } = await handshake(s, [
      { peer: A.pub, name: 'anna', caps: CAPS_ALL },
      { peer: C.pub, name: 'cleo', caps: CAPS_OLD },
    ])

    // Team message goes to both anna and cleo
    const post = await s.svc.send('team', 'deploying now')
    if (!post.ok) throw new Error('post failed')
    expect(sentMsgs(ws)).toHaveLength(2)
    ws.sent.length = 0

    // React in team chat: only anna gets body.react, cleo does not
    const rxTeam = await s.svc.react('team/general', post.id, '🚀', 'add')
    expect(rxTeam).toEqual({ ok: true, copies: 1, skipped: [] })
    const rxSent = sentMsgs(ws)
    expect(rxSent).toHaveLength(1)
    expect(rxSent[0]?.to).toBe(A.pub)
    expect(rxSent[0]?.body.react).toEqual({ to: post.id, emoji: '🚀', op: 'add' })

    // Pair with old peer cleo: local reaction works, 0 wire copies sent, messaging still works
    ws.sent.length = 0
    const cleoMsg = await deliver(ws, me, C, 'hello from old board', '2026-11-11T10:06:00.000Z')
    const rxCleo = await s.svc.react(`${C.pub}/general`, cleoMsg, '👍', 'add')
    expect(rxCleo).toEqual({ ok: true, copies: 0, skipped: [] })
    expect(sentMsgs(ws)).toHaveLength(0)
    expect(s.svc.threadLines(`${C.pub}/general`).find(l => l.id === cleoMsg)?.reactions).toEqual([
      { emoji: '👍', count: 1, me: true, peers: [] },
    ])
    expect((await s.svc.send(C.pub, 'still works')).ok).toBe(true)
    expect(sentMsgs(ws)).toHaveLength(1)
  })

  test('two real boards through a real test hub see reactions live, after reconnect, and after restart/history load', async () => {
    const hub = await startHarness()
    const dirA = mkdtempSync(join(tmpdir(), 'board-rx-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'board-rx-b-'))
    const envA = { HOME: dirA, APPDATA: dirA, LOCALAPPDATA: dirA }
    const envB = { HOME: dirB, APPDATA: dirB, LOCALAPPDATA: dirB }
    let restore: (() => void) | null = null
    try {
      const [annaKey, benKey] = [await generateKey(), await generateKey()]
      ;(await hub.join(annaKey, 'anna')).close()
      ;(await hub.join(benKey, 'ben')).close()
      await hub.offline(annaKey.pub)
      await hub.offline(benKey.pub)

      joinState(envA, annaKey)
      joinState(envB, benKey)

      const startBoard = (name: string, onReaction?: (e: InboundReactionEvent) => void) => {
        const svc = createTeam({
          cfg: { team: { hub: hub.url.replace(/\/v1$/, ''), name } },
          log: () => {},
          onChange: () => {},
          ...(onReaction && { onReaction }),
          socket: url => new WebSocket(url) as never,
        })
        liveServices.push(svc)
        return svc
      }

      restore = applyEnv(envA)
      const svcA = startBoard('anna')
      svcA.start()
      await until(() => svcA.view()?.state === 'online' && (svcA.view()?.roster.length ?? 0) === 1, 'A online')
      restore()
      restore = null

      restore = applyEnv(envB)
      const benReactions: InboundReactionEvent[] = []
      let svcB = startBoard('ben', e => benReactions.push(e))
      svcB.start()
      await until(() => svcB.view()?.state === 'online' && (svcB.view()?.roster.length ?? 0) === 1, 'B online')

      // Ben sends a message to team chat
      const sentB = await svcB.send('team', 'ready for release')
      if (!sentB.ok) throw new Error('B send failed')
      restore()
      restore = null

      restore = applyEnv(envA)
      await until(() => svcA.threadLines('team/general').some(l => l.text === 'ready for release'), 'A got msg')
      const msgOnA = svcA.threadLines('team/general').find(l => l.text === 'ready for release')
      if (!msgOnA) throw new Error('missing msgOnA')
      // Anna reacts 👀 live
      const reactA = await svcA.react('team/general', msgOnA.id, '👀', 'add')
      expect(reactA).toEqual({ ok: true, copies: 1, skipped: [] })
      restore()
      restore = null

      restore = applyEnv(envB)
      await until(
        () => (svcB.threadLines('team/general').find(l => l.id === sentB.id)?.reactions?.length ?? 0) === 1,
        'B got reaction',
      )
      expect(svcB.threadLines('team/general').find(l => l.id === sentB.id)?.reactions).toEqual([
        { emoji: '👀', count: 1, me: false, peers: ['anna'] },
      ])
      expect(benReactions[0]).toMatchObject({ emoji: '👀', op: 'add', ownText: 'ready for release' })

      // Ben also adds 👀, then removes it
      await svcB.react('team/general', sentB.id, '👀', 'add')
      restore()
      restore = null

      restore = applyEnv(envA)
      await until(
        () => svcA.threadLines('team/general').find(l => l.id === msgOnA.id)?.reactions?.[0]?.count === 2,
        'A sees count 2',
      )
      restore()
      restore = null

      restore = applyEnv(envB)
      await svcB.react('team/general', sentB.id, '👀', 'remove')
      restore()
      restore = null

      restore = applyEnv(envA)
      await until(
        () => svcA.threadLines('team/general').find(l => l.id === msgOnA.id)?.reactions?.[0]?.count === 1,
        'A sees count 1 after remove',
      )
      restore()
      restore = null

      // Ben goes offline; Anna reacts 🔥 while Ben is offline; Ben also queues 🎉 offline; then Ben reconnects
      svcB.stop()
      await hub.offline(benKey.pub)

      restore = applyEnv(envA)
      await svcA.react('team/general', msgOnA.id, '🔥', 'add')
      restore()
      restore = null

      // Restart Ben on same state dir (history load + reconnect)
      restore = applyEnv(envB)
      await svcB.react('team/general', sentB.id, '🎉', 'add')
      svcB = startBoard('ben')
      // Before handshake finishes, history from team-reactions.json already shows 👀 and 🎉
      expect(
        svcB
          .threadLines('team/general')
          .find(l => l.id === sentB.id)
          ?.reactions?.map(r => r.emoji),
      ).toEqual(['👀', '🎉'])
      svcB.start()
      await until(
        () =>
          svcB
            .threadLines('team/general')
            .find(l => l.id === sentB.id)
            ?.reactions?.some(r => r.emoji === '🔥') ?? false,
        'B got queued 🔥 on reconnect',
      )
      restore()
      restore = null

      restore = applyEnv(envA)
      await until(
        () =>
          svcA
            .threadLines('team/general')
            .find(l => l.id === msgOnA.id)
            ?.reactions?.some(r => r.emoji === '🎉') ?? false,
        'A got flushed 🎉 from B reconnect',
      )
      restore()
      restore = null
    } finally {
      restore?.()
      hub.stop()
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  }, 20_000)

  test('reactions never bump unread, never wake sessions, and notify message sender quietly', async () => {
    const s = setup()
    const A = await generateKey()
    s.svc.stop()
    const clock = fakeClock()
    const inboundCalls: unknown[] = []
    const toasts: unknown[] = []
    const notify = createTeamNotify({
      desktop: { show: t => toasts.push(t) },
      nameOf: () => 'anna',
      mutes: () => () => false,
      now: () => clock.now(),
    })
    const sockets: FakeWs[] = []
    const svc = createTeam({
      cfg: { team: { hub: 'ws://127.0.0.1:7443', name: 'me' } },
      clock,
      log: () => {},
      onChange: () => {},
      onInbound: e => {
        inboundCalls.push(e)
        notify.inbound(e)
      },
      onReaction: e => notify.reaction?.(e),
      socket: url => {
        const ws = new FakeWs(url)
        sockets.push(ws)
        return ws
      },
    })
    liveServices.push(svc)
    svc.start()
    await until(() => sockets.length === 1, 'socket')
    const ws = sockets[0]
    if (!ws) throw new Error('missing socket')
    ws.open()
    const hello = ws.of('hello')[0]
    if (!hello) throw new Error('missing hello')
    ws.recv({ t: 'challenge', hub: 'hub-1', nonce: 'N'.repeat(43) })
    await until(() => ws.of('auth').length === 1, 'auth')
    ws.recv({ t: 'welcome', peer: hello.peer, name: 'me', hub: 'hub-1' })
    ws.recv({ t: 'roster', peers: [{ peer: A.pub, name: 'anna', online: true, last_seen: null, caps: CAPS_ALL }] })
    await until(() => svc.view()?.state === 'online', 'online')

    expect(notify.unread()).toBe(0)
    const own = await svc.send(A.pub, 'can you review PR #10?')
    if (!own.ok) throw new Error('send failed')
    clock.skew(1000)
    const incoming = await deliver(ws, hello.peer, A, 'sure thing', '2026-11-11T10:10:00.000Z')
    expect(inboundCalls).toHaveLength(1)
    expect(notify.unread()).toBe(1)
    toasts.length = 0

    // Reaction on our own message: no inbound event, unread stays 1, quiet toast fires
    clock.skew(1000)
    await deliver(ws, hello.peer, A, '👀', '2026-11-11T10:11:00.000Z', {
      react: { to: own.id, emoji: '👀', op: 'add' },
    })
    expect(inboundCalls).toHaveLength(1)
    expect(notify.unread()).toBe(1)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({
      title: 'anna',
      body: 'anna reacted 👀 to “can you review PR #10?”',
    })

    // Reaction on anna's own message: no toast for us
    await deliver(ws, hello.peer, A, '🔥', '2026-11-11T10:12:00.000Z', {
      react: { to: incoming, emoji: '🔥', op: 'add' },
    })
    expect(toasts).toHaveLength(1)
    expect(notify.unread()).toBe(1)
  })

  test('agentReact respects switches/lanes/rate limit, CLI react & thread show reactions as data', async () => {
    const s = setup()
    const A = await generateKey()
    s.svc.start()
    const { ws, me } = await handshake(s, [{ peer: A.pub, name: 'anna', caps: CAPS_ALL }])
    const m = await deliver(ws, me, A, 'please check logs', '2026-11-11T10:15:00.000Z')
    const key = `${A.pub}/general`

    const router = createTeamRouter({
      team: s.svc,
      cfg: {
        team: { hub: 'ws://127.0.0.1:7443', name: 'me', agentLimits: { sessionHour: 1 } },
        categories: [{ id: 'acme', color: 'blue', paths: [] }],
      },
      items: () => [{ key: 'sess-1', name: 'acme-dev', category: 'acme' }],
      schedule: { list: () => [], add: () => {}, update: () => false },
      now: () => s.clock.now(),
    })

    // Off -> 403 / error 'off'
    expect(
      await router.agentReact({ thread: key, message: m, emoji: '👀', op: 'add', session: { key: 'sess-1' } }),
    ).toEqual({ ok: false, error: 'off' })

    // On for another lane -> 'lane'
    changeAgents(a => {
      a.peers[A.pub] = { on: true, lanes: ['other'] }
    })
    expect(
      await router.agentReact({ thread: key, message: m, emoji: '👀', op: 'add', session: { key: 'sess-1' } }),
    ).toEqual({ ok: false, error: 'lane' })

    // Share acme lane -> works via HTTP route + CLI
    changeAgents(a => {
      a.peers[A.pub] = { on: true, lanes: ['acme'] }
    })
    const routes = teamRoutes(s.svc, router, {
      categories: [{ id: 'acme', color: 'blue', paths: [] }],
      team: { hub: 'ws://127.0.0.1:7443', name: 'me' },
    })
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url)
        for (const r of routes) {
          if (r.method !== req.method) continue
          const hit = typeof r.path === 'string' ? (r.path === url.pathname ? [] : null) : r.path.exec(url.pathname)
          if (!hit) continue
          const res = await r.handle(req, {
            params: hit.slice(1),
            rawBody: () => req.json(),
            refuse: () => null,
          } as never)
          if (res) return res
        }
        return Response.json({ ok: false }, { status: 404 })
      },
    })
    try {
      const ctx = {
        webPort: server.port as number,
        roster: [{ peer: A.pub, name: 'anna' }],
        self: async () => ({ key: 'sess-1', name: 'acme-dev' }),
        find: async () => ({ key: 'sess-1', name: 'acme-dev' }),
      }
      const res = await teamAgents('react', ['anna', m.slice(0, 8), ':eyes:'], ctx)
      expect(res).toBe(`ok · reacted 👀 to ${m.slice(0, 8)} in anna`)

      const framed = await teamAgents('thread', ['anna'], ctx)
      expect(framed).toContain('  [reactions: 👀 1 (you)]')
      const jsonStr = await teamAgents('thread', ['anna', '--json'], ctx)
      expect(JSON.parse(jsonStr).lines[0].reactions).toEqual([{ emoji: '👀', count: 1, me: true, peers: [] }])

      // Remove via CLI
      const rmRes = await teamAgents('react', ['anna', m.slice(0, 8), '👀', '--remove'], ctx)
      expect(rmRes).toBe(`ok · removed 👀 from ${m.slice(0, 8)} in anna`)
    } finally {
      server.stop(true)
    }

    // Check framedThread + threadData helper directly with peer names
    const ft = framedThread(
      key,
      {},
      [
        {
          id: m,
          dir: 'in',
          who: 'anna',
          ts: '2026-11-11T10:15:00.000Z',
          text: 'hi',
          reactions: [{ emoji: '🔥', count: 2, me: true, peers: ['anna'] }],
        },
      ],
      { peers: {}, lanes: [] },
      'anna',
    )
    expect(ft).toContain('  [reactions: 🔥 2 (you, anna)]')
    expect(
      (
        threadData(
          key,
          {},
          [
            {
              id: m,
              dir: 'in',
              ts: '2026-11-11T10:15:00.000Z',
              text: 'hi',
              reactions: [{ emoji: '🔥', count: 1, me: false, peers: ['anna'] }],
            },
          ],
          'anna',
          false,
        ) as { lines: unknown[] }
      ).lines[0],
    ).toMatchObject({
      reactions: [{ emoji: '🔥', count: 1, me: false, peers: ['anna'] }],
    })
  })

  test('setups without reactions or without team never create team-reactions.json; remote ownerTeam gates correctly', async () => {
    const off = setup(undefined)
    off.svc.start()
    expect(await off.svc.react('team/general', '00000000-0000-4000-8000-000000000001', '👍', 'add')).toEqual({
      ok: false,
      error: 'off',
    })
    expect(existsSync(stateDir())).toBe(false)

    // Team on, normal messages/acks/errors/trust without any reactions never write team-reactions.json
    const s = setup()
    const A = await generateKey()
    s.svc.start()
    const { ws, me } = await handshake(s, [{ peer: A.pub, name: 'anna', caps: CAPS_ALL }])
    const out = await s.svc.send(A.pub, 'hello')
    if (!out.ok) throw new Error('send failed')
    await deliver(ws, me, A, 'world', '2026-11-11T10:00:00.000Z')
    ws.recv({ t: 'state', id: out.id, state: 'delivered', at: 1 })
    ws.recv({ t: 'error', id: out.id, code: 'bad_frame', message: 'nope' })
    s.svc.trust(A.pub)
    await settle()
    expect(existsSync(teamReactionsFile())).toBe(false)

    // Remote route gates: phone/domain owner can call /api/team/react, never /api/team/agent-react
    expect(ownerTeam('/api/team/react')).toBe(true)
    expect(ownerTeam('/api/team/agent-react')).toBe(false)
  })
})

function joinState(env: Record<string, string>, key: KeyPair): string {
  const prev = applyEnv(env)
  try {
    const dir = stateDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'team-key.json'), JSON.stringify({ v: 1, ...key }), { mode: 0o600 })
    return dir
  } finally {
    prev()
  }
}

function applyEnv(env: Record<string, string>): () => void {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return () => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}
