// Addressing a peer's agent (#832), the pure rules: code names, the directory as a board accepts
// it, the owner's exposures and whom they reach, the `@Name.code` mention and where a post that
// starts with one goes; and the two signed body fields as checkMessage reads them.
import { describe, expect, test } from 'bun:test'
import { checkMessage, generateKey, type Message, sealEnvelope } from '../../src/core/team.ts'
import {
  addressTarget,
  assignHandles,
  directoryFor,
  directoryMark,
  handleOf,
  leadingMention,
  mentionAt,
  mentionTitle,
  mentionWord,
  peerOfWord,
  type ReachWorld,
  reach,
  readDirectory,
  validCode,
} from '../../src/core/team-directory.ts'

const P = 'P'.repeat(43)
const Q = 'Q'.repeat(43)
const R = 'R'.repeat(43)
const CH = 'team/11111111-1111-4111-8111-111111111111'

describe('handles on the wire', () => {
  test.each(['reviewer', 'a', 'ops-2', '9lives', 'x'.repeat(40)])('%s is one', c => expect(validCode(c)).toBe(true))
  test.each(['', 'Reviewer', '-ops', 'ops_2', 'a b', 'x'.repeat(41), 'ревьюер', 'a.b', 'a%b', 5, null])(
    '%p is none',
    c => expect(validCode(c)).toBe(false),
  )
})

describe('a directory as a board accepts it', () => {
  test('codes with an optional line, each code once', () => {
    expect(readDirectory([{ code: 'reviewer', about: 'Reviews pull requests' }, { code: 'ops' }])).toEqual([
      { code: 'reviewer', about: 'Reviews pull requests' },
      { code: 'ops' },
    ])
    expect(readDirectory([])).toEqual([])
  })
  test.each([
    ['not a list', { code: 'a' }],
    ['a code twice', [{ code: 'a' }, { code: 'a' }]],
    ['an unknown key', [{ code: 'a', session: 'x' }]],
    ['a bad code', [{ code: 'A' }]],
    ['an unprintable line', [{ code: 'a', about: 'x\u202ey' }]],
    ['a line too long', [{ code: 'a', about: 'x'.repeat(81) }]],
    ['too many', Array.from({ length: 65 }, (_, i) => ({ code: `a${i}` }))],
  ])('%s is refused', (_n, v) => expect(readDirectory(v)).toBeNull())
  test('its mark does not depend on the order', () => {
    expect(directoryMark([{ code: 'b' }, { code: 'a' }])).toBe(directoryMark([{ code: 'a' }, { code: 'b' }]))
    expect(directoryMark([{ code: 'a' }])).not.toBe(directoryMark([{ code: 'a', about: 'x' }]))
  })
})

describe('handles', () => {
  test("a session's name: lowercase, spaces to dashes, ASCII only, at most 40", () => {
    expect(handleOf('Acme Work')).toBe('acme-work')
    expect(handleOf('  claude-team   agent mentions ')).toBe('claude-team-agent-mentions')
    expect(handleOf('Café Ops 2')).toBe('cafe-ops-2')
    expect(handleOf('a/b.c_d')).toBe('abcd')
    expect(handleOf('x'.repeat(60))).toBe('x'.repeat(40))
    expect(handleOf('Блюбениан монитор v2')).toBe('blyubenian-monitor-v2')
    expect(handleOf('Щука Ёж і Їжак')).toBe('shchuka-ezh-i-yizhak')
    expect(handleOf('Acme отчёт Q3')).toBe('acme-otchet-q3')
    expect(handleOf('日本')).toBeNull()
    expect(handleOf('---')).toBeNull()
  })

  test('each session keeps its handle; a new one gets its name, or the name with -2 when taken', () => {
    const one = assignHandles([{ key: 'k1', name: 'Acme Work' }], {})
    expect(one).toEqual({ k1: 'acme-work' })
    // Renamed later: the address stays.
    expect(assignHandles([{ key: 'k1', name: 'Other' }], one)).toEqual({ k1: 'acme-work' })
    const two = assignHandles(
      [
        { key: 'k1', name: 'Acme Work' },
        { key: 'k2', name: 'acme work' },
        { key: 'k3', name: '日本' },
      ],
      one,
    )
    expect(two).toEqual({ k1: 'acme-work', k2: 'acme-work-2', k3: 'agent' })
  })

  test("a session no longer on the board passes its handle to a new one of that name: the board's mapping, not the old key", () => {
    const before = { old: 'acme-work', other: 'ops' }
    expect(assignHandles([{ key: 'new', name: 'Acme Work' }], before)).toEqual({ other: 'ops', new: 'acme-work' })
    // A handle kept while its session is away and nobody else asks for it.
    expect(assignHandles([{ key: 'k9', name: 'Ops' }], { old: 'acme-work', gone: 'ops' })).toEqual({
      old: 'acme-work',
      k9: 'ops',
    })
  })
})

describe('whom a handle reaches: the lanes shared with that person', () => {
  const world = (over: Partial<ReachWorld> = {}): ReachWorld => ({
    handles: { 'sess-acme': 'acme-work', 'sess-globex': 'globex-work', 'sess-left': 'left' },
    off: false,
    peers: {
      [P]: { on: true, lanes: ['acme'] },
      [Q]: { on: true, lanes: ['acme', 'globex'] },
      [R]: { on: false, lanes: ['acme'] },
    },
    sessions: [
      { key: 'sess-acme', name: 'acme-work', lane: 'acme' },
      { key: 'sess-globex', name: 'globex-work', lane: 'globex' },
      { key: 'sess-new', name: 'not yet', lane: 'acme' },
    ],
    ...over,
  })
  test('Agents on for them, the session on the board, its lane shared', () => {
    expect(reach('acme-work', P, world())?.key).toBe('sess-acme')
    expect(directoryFor(P, world())).toEqual([{ code: 'acme-work' }])
    expect(directoryFor(Q, world())).toEqual([{ code: 'acme-work' }, { code: 'globex-work' }])
    expect(reach('acme-work', P, world({ peers: { [P]: { on: true, lanes: [], allLanes: true } } }))?.key).toBe(
      'sess-acme',
    )
  })
  test('never: lane not shared, Agents off, all off, no such handle, its session gone (archived)', () => {
    expect(reach('globex-work', P, world())).toBeNull()
    expect(reach('acme-work', R, world())).toBeNull()
    expect(directoryFor(R, world())).toEqual([])
    expect(reach('acme-work', P, world({ off: true }))).toBeNull()
    expect(reach('nobody', P, world())).toBeNull()
    expect(reach('left', P, world())).toBeNull()
    expect(directoryFor('S'.repeat(43), world())).toEqual([])
  })
})

describe('the mention', () => {
  test('a leading @Name.code and the text after it', () => {
    expect(leadingMention('@Dima.reviewer please look')).toEqual({ who: 'Dima', code: 'reviewer', rest: 'please look' })
    expect(leadingMention('  @Дима.ops: now')).toEqual({ who: 'Дима', code: 'ops', rest: 'now' })
    expect(leadingMention('@Dima.reviewer')).toEqual({ who: 'Dima', code: 'reviewer', rest: '' })
  })
  test.each([
    'hi @Dima.reviewer',
    '@Dima reviewer',
    '@Dima.Reviewer x',
    'mail@Dima.reviewer',
    '@Dima.rev.iew',
    '@.rev x',
  ])('%p is none', t => expect(leadingMention(t)).toBeNull())
  test('a name as written after @: no spaces, dots or @; a dotted name is found by it', () => {
    expect(mentionWord('Dima K.')).toBe('DimaK')
    expect(mentionWord('anna.k')).toBe('annak')
    expect(mentionWord('bob@work')).toBe('bobwork')
    const roster = [{ peer: P, name: 'Dima K.' }]
    const m = leadingMention(`@${mentionWord('Dima K.')}.helper hi`)
    expect(m).toEqual({ who: 'DimaK', code: 'helper', rest: 'hi' })
    expect(peerOfWord(m?.who ?? '', roster)?.peer).toBe(P)
  })

  test('a name by its words without spaces, any case, or the id; never a guess between two', () => {
    const roster = [
      { peer: P, name: 'Anna Lee' },
      { peer: Q, name: 'ben' },
      { peer: R, name: 'Ben' },
    ]
    expect(peerOfWord('annalee', roster)?.peer).toBe(P)
    expect(peerOfWord('AnnaLee', roster)?.peer).toBe(P)
    expect(peerOfWord(Q, roster)?.peer).toBe(Q)
    expect(peerOfWord('ben', roster)).toBeNull()
    expect(peerOfWord('nobody', roster)).toBeNull()
  })
  test('what the composer completes at the caret', () => {
    expect(mentionAt('@Di', 3)).toEqual({ start: 0, who: 'Di', code: null })
    expect(mentionAt('hi @Dima.re', 11)).toEqual({ start: 3, who: 'Dima', code: 're' })
    expect(mentionAt('hi @Dima. x', 9)).toEqual({ start: 3, who: 'Dima', code: '' })
    expect(mentionAt('mail@Dima', 9)).toBeNull()
    expect(mentionAt('@Dima.rev done', 14)).toBeNull()
  })
  test("a topic's title: the code name and the text's start, within 80 printable characters", () => {
    expect(mentionTitle('rev', '')).toBe('@rev')
    expect(mentionTitle('rev', 'check\n the\u202e PR')).toBe('@rev: check the PR')
    const long = mentionTitle('rev', 'x'.repeat(200))
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('where a post that starts with a mention goes', () => {
  const roster = [
    { peer: P, name: 'dima' },
    { peer: Q, name: 'anna' },
  ]
  const w = { roster, listed: (peer: string) => (peer === P ? ['rev'] : null) }
  const topic = '22222222-2222-4222-8222-222222222222'
  test('no mention, nobody by that name, or a peer with no directory: where it was going', () => {
    expect(addressTarget('hello', { to: 'team' }, w)).toEqual({ ok: true, to: 'team' })
    expect(addressTarget('@zed.rev hi', { to: P }, w)).toEqual({ ok: true, to: P })
    expect(addressTarget('@anna.rev hi', { to: Q }, w)).toEqual({ ok: true, to: Q })
  })
  test('a code name not in their directory is refused', () => {
    expect(addressTarget('@dima.ops hi', { to: P }, w)).toEqual({ ok: false, error: 'agent' })
  })
  test("from a thread they do not read: a topic of its own with them, a reply's line dropped", () => {
    const own = { ok: true as const, to: P, thread: { title: '@rev: check it' }, at: { peer: P, code: 'rev' } }
    const channel = CH.slice(5)
    const members = (id: string) => (id === channel ? [Q] : null)
    // A pair's thread with someone else, and a channel without them.
    expect(addressTarget('@dima.rev check it', { to: Q }, w)).toEqual(own)
    expect(addressTarget('@dima.rev check it', { to: Q, thread: { id: topic } }, w)).toEqual(own)
    expect(addressTarget('@dima.rev check it', { to: 'team', thread: { id: channel } }, { ...w, members })).toEqual(own)
    expect(
      addressTarget('@dima.rev check it', { to: 'team', thread: { title: 'Ops', members: [Q] } }, { ...w, members }),
    ).toEqual(own)
  })
  test('a thread they read keeps it (#875): the team chat, a team topic, a channel with them, their general', () => {
    const at = { peer: P, code: 'rev' }
    const channel = CH.slice(5)
    const members = (id: string) => (id === channel ? [P, Q] : null)
    expect(addressTarget('@dima.rev check it', { to: 'team' }, w)).toEqual({ ok: true, to: 'team', at })
    expect(addressTarget('@dima.rev check it', { to: 'team', replyTo: topic }, w)).toEqual({
      ok: true,
      to: 'team',
      replyTo: topic,
      at,
    })
    expect(addressTarget('@dima.rev x', { to: 'team', thread: { id: 'general' } }, w)).toEqual({
      ok: true,
      to: 'team',
      thread: { id: 'general' },
      at,
    })
    expect(addressTarget('@dima.rev x', { to: 'team', thread: { id: channel } }, { ...w, members })).toEqual({
      ok: true,
      to: 'team',
      thread: { id: channel },
      at,
    })
    expect(addressTarget('@dima.rev x', { to: 'team', thread: { title: 'Ops', members: [P] } }, w)).toEqual({
      ok: true,
      to: 'team',
      thread: { title: 'Ops', members: [P] },
      at,
    })
    expect(addressTarget('@dima.rev check it', { to: P }, w)).toEqual({ ok: true, to: P, at })
    expect(addressTarget('@dima.rev x', { to: P, thread: { id: 'general' } }, w)).toEqual({
      ok: true,
      to: P,
      thread: { id: 'general' },
      at,
    })
  })
  test('a topic with them keeps it, with the agent named; so does a team topic', () => {
    const at = { peer: P, code: 'rev' }
    expect(addressTarget('@dima.rev x', { to: P, thread: { id: topic }, replyTo: topic }, w)).toEqual({
      ok: true,
      to: P,
      thread: { id: topic },
      replyTo: topic,
      at,
    })
    expect(addressTarget('@dima.rev x', { to: P, thread: { title: 'Mine' } }, w)).toEqual({
      ok: true,
      to: P,
      thread: { title: 'Mine' },
      at,
    })
    expect(addressTarget('@dima.rev x', { to: 'team', thread: { id: topic } }, w)).toEqual({
      ok: true,
      to: 'team',
      thread: { id: topic },
      at,
    })
  })
})

describe('the signed body fields', () => {
  async function check(body: Record<string, unknown>) {
    const k = await generateKey()
    const msg = {
      v: 1,
      id: '33333333-3333-4333-8333-333333333333',
      from: k.pub,
      to: P,
      kind: 'question',
      reply_to: null,
      ts: '2026-11-26T10:00:00.000Z',
      ttl_s: 60,
      body,
    } as unknown as Message
    const env = await sealEnvelope(k, msg)
    return { board: checkMessage(env.payload, k.pub), relay: checkMessage(env.payload, k.pub, 'relay') }
  }
  test('a directory alone, and the code name a copy is addressed to', async () => {
    const d = await check({ text: 'agent directory', agents: [{ code: 'rev' }] })
    expect(d.board.ok && d.board.msg.body.agents).toEqual([{ code: 'rev' }])
    const a = await check({ text: 'hi', at: 'rev', thread: { id: '44444444-4444-4444-8444-444444444444', title: 'T' } })
    expect(a.board.ok && a.board.msg.body.at).toBe('rev')
  })
  test.each([
    ['a directory with a thread', { text: 'x', agents: [], thread: { id: 'general' } }],
    ['a directory with via', { text: 'x', agents: [], via: 'agent' }],
    ['a bad directory', { text: 'x', agents: [{ code: 'A' }] }],
    ['a bad code name', { text: 'x', at: 'A b' }],
    [
      'a code name on a reaction',
      { text: 'x', at: 'rev', react: { to: '33333333-3333-4333-8333-333333333334', emoji: '👍', op: 'add' } },
    ],
    ['a code name on a directory', { text: 'x', at: 'rev', agents: [] }],
  ])('%s is no body for a board; the hub relays it as signed', async (_n, body) => {
    const r = await check(body)
    expect(r.board.ok).toBe(false)
    expect(r.relay.ok).toBe(true)
  })
})

test('an owner service is reachable in any shared lane with Agents on', () => {
  const service = {
    key: 'service-key',
    name: 'Inventory',
    lane: 'other',
    ownerServiceLanes: [{ id: 'ops' }, { id: 'research' }],
  }
  const world: ReachWorld = {
    handles: { [service.key]: 'inventory', normal: 'normal' },
    sessions: [service, { key: 'normal', name: 'Normal', lane: 'other' }],
    off: false,
    peers: { [P]: { on: true, lanes: ['ops'] }, [Q]: { on: true, lanes: [] } },
  }
  expect(directoryFor(P, world)).toEqual([{ code: 'inventory' }])
  expect(reach('inventory', P, world)).toEqual(service)
  expect(directoryFor(Q, world)).toEqual([])
  expect(directoryFor(P, { ...world, off: true })).toEqual([])
})
