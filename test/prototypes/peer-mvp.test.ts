// The peer network prototype (prototypes/peer-mvp, #225): a static page on mock data that opens from
// disk. Its files are there, the mock is strict JSON of the agreed shape, nothing in it reaches the
// network, clicks change the card and the matrix, and an untrusted message has no button that acts.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const DIR = join(import.meta.dir, '..', '..', 'prototypes', 'peer-mvp')
const FILES = ['index.html', 'style.css', 'mock.js', 'peer.js', 'app.js', 'README.md']
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')

type Verdict = 'accept' | 'decline' | 'clarify'
type Item = { n: number; title: string; priority: string; estimate_h: number; ref?: string }
type Message = { id: string; kind: string; trust: string; from: string; reply_by: string; items: Item[] }
type Mock = {
  now: string
  roster: { id: string; name: string; online: boolean; last_seen: string | null; fingerprint: string }[]
  inbox: Message[]
  matrix: { offer: string; rows: { peer: string; delivery: string; answers: { n: number; verdict: Verdict }[] }[] }
}
type State = { mock: Mock; late: boolean; answers: Record<string, Record<number, Verdict>> }
type Action = { type: string; message?: string; n?: number; verdict?: string; on?: boolean }
type Row = { peer: string; answers: Record<number, Verdict>; status: string; overdue: boolean }
type PeerMvp = {
  initialState(mock: Mock): State
  apply(state: State, action: Action): State
  matrixOf(state: State): { rows: Row[]; takers: string[][]; late: boolean }
  render(state: State): string
}

/** The mock as the test reads it: the object literal after `PEER_MOCK = `, through JSON.parse. */
const mockJson = (): Mock => {
  const literal = /^globalThis\.PEER_MOCK = (\{[\s\S]*\})\s*$/m.exec(read('mock.js'))?.[1]
  if (!literal) throw new Error('mock.js: no `globalThis.PEER_MOCK = {…}`')
  return JSON.parse(literal)
}

/** mock.js and peer.js as the page runs them, in a context of their own with no DOM. */
const load = () => {
  const context = vm.createContext({})
  vm.runInContext(read('mock.js'), context)
  vm.runInContext(read('peer.js'), context)
  const { PeerMvp, PEER_MOCK } = context as { PeerMvp: PeerMvp; PEER_MOCK: Mock }
  return { P: PeerMvp, state: PeerMvp.initialState(PEER_MOCK) }
}

const offerId = (state: State) => state.mock.inbox.find(m => m.trust === 'trusted')?.id ?? ''
const untrustedId = (state: State) => state.mock.inbox.find(m => m.trust === 'untrusted')?.id ?? ''
const mine = (P: PeerMvp, state: State) => P.matrixOf(state).rows.find(row => row.peer === 'me')?.answers
const card = (html: string, id: string) =>
  new RegExp(`<article class="card[^"]*" data-message="${id}">([\\s\\S]*?)</article>`).exec(html)?.[1] ?? ''

describe('peer network prototype (#225)', () => {
  test('its files are in prototypes/peer-mvp, and the page loads only them', () => {
    for (const name of FILES) expect(existsSync(join(DIR, name))).toBe(true)
    const html = read('index.html')
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map(m => m[1])
    expect(refs).toEqual(['style.css', 'mock.js', 'peer.js', 'app.js'])
  })

  test('nothing in it reaches the network: no fetch, sockets, XHR, beacons, imports or URLs', () => {
    for (const name of FILES.filter(name => !name.endsWith('.md'))) {
      const source = read(name)
      for (const banned of [
        'fetch(',
        'WebSocket(',
        'XMLHttpRequest',
        'EventSource',
        'sendBeacon',
        'import(',
        '@import',
      ]) {
        expect({ name, has: source.includes(banned) }).toEqual({ name, has: false })
      }
      expect({ name, url: /\b(?:https?|wss?):\/\//i.exec(source)?.[0] ?? null }).toEqual({ name, url: null })
    }
  })

  test('the mock is strict JSON: five peers, one trusted offer, one untrusted message, one matrix', () => {
    const mock = mockJson()
    expect(mock.roster).toHaveLength(5)
    for (const peer of mock.roster) {
      expect(peer.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/)
      expect(peer.online || Number.isFinite(Date.parse(peer.last_seen ?? ''))).toBe(true)
    }
    expect(mock.inbox.map(m => m.trust).sort()).toEqual(['trusted', 'untrusted'])
    const offer = mock.inbox.find(m => m.trust === 'trusted')
    expect(offer?.kind).toBe('offer')
    expect(mock.matrix.offer).toBe(offer?.id ?? '')
    const known = new Set(['me', ...mock.roster.map(p => p.id)])
    for (const row of mock.matrix.rows) expect(known.has(row.peer)).toBe(true)
    expect(mock.matrix.rows.filter(row => row.peer === 'me')).toHaveLength(1)
  })

  test('Возьму, Не возьму, Уточнить and Возьму всё change my answers, and my row of the matrix with them', () => {
    const { P, state: start } = load()
    const id = offerId(start)
    let state = P.apply(start, { type: 'verdict', message: id, n: 1, verdict: 'accept' })
    state = P.apply(state, { type: 'verdict', message: id, n: 2, verdict: 'decline' })
    state = P.apply(state, { type: 'verdict', message: id, n: 3, verdict: 'clarify' })
    expect(mine(P, state)).toEqual({ 1: 'accept', 2: 'decline', 3: 'clarify' })
    expect(P.matrixOf(state).rows.find(row => row.peer === 'me')?.status).toBe('answered')
    expect(P.matrixOf(state).takers[0]).toContain('me')

    state = P.apply(state, { type: 'accept-all', message: id })
    expect(mine(P, state)).toEqual({ 1: 'accept', 2: 'accept', 3: 'accept' })
    const html = card(P.render(state), id)
    expect(html.match(/class="v-accept" [^>]*aria-pressed="true"/g)).toHaveLength(3)

    expect(mine(P, P.apply(state, { type: 'reset' }))).toEqual({})
    // The others' rows are the mock's, whatever I click.
    expect(P.matrixOf(state).rows.filter(row => row.peer !== 'me')).toEqual(
      P.matrixOf(start).rows.filter(row => row.peer !== 'me'),
    )
  })

  test('an untrusted message: every button disabled, none with an action, and apply() ignores it', () => {
    const { P, state } = load()
    const id = untrustedId(state)
    const html = card(P.render(state), id)
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) {
      expect(b).toContain(' disabled')
      expect(b).not.toContain('data-')
    }
    for (const action of [
      { type: 'verdict', message: id, n: 1, verdict: 'accept' },
      { type: 'accept-all', message: id },
    ]) {
      expect(P.apply(state, action)).toBe(state)
    }
    // Its text is shown as text: the markup in the mock comes out escaped.
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
    // The trusted offer's buttons do act.
    expect(card(P.render(state), offerId(state))).toContain('data-action="verdict"')
  })

  test('after the deadline, who has not answered in full is overdue, and an item nobody takes is marked', () => {
    const { P, state } = load()
    expect(P.matrixOf(state).rows.some(row => row.overdue)).toBe(false)
    const late = P.apply(state, { type: 'late', on: true })
    const m = P.matrixOf(late)
    expect(m.late).toBe(true)
    expect(m.rows.filter(row => row.overdue).map(row => row.peer)).toEqual(
      m.rows.filter(row => row.status !== 'answered').map(row => row.peer),
    )
    expect(P.render(late)).toContain('class="takers is-nobody"')
  })
})
