// The board's own look at an agent's browser before a login fill (services/cdp-peek.ts), on a
// DevTools line of the test's own playing Chrome: the page that has the focus (the one tab that
// shows; of several, the one with the focus), its address as Chrome lists it, what has the focus
// there, read in a world of the board's own; and the agent's client never sees the board's
// messages, its session's, or Chrome's word of its attach, while another client's attach meanwhile
// still reaches the agent.
import { describe, expect, test } from 'bun:test'
import { type CdpLine, FOCUS_SCRIPT, focusedPage } from '../../src/services/cdp-peek.ts'

type Msg = Record<string, unknown>
interface Page {
  id: string
  url: string
  title: string
  look: Record<string, unknown>
}

/** Chrome as far as the look asks it, with what the agent's client got and what was sent. */
function fakeChrome(pages: Page[], o: { otherAttach?: boolean } = {}) {
  const taps = new Set<(text: string) => boolean>()
  const agent: string[] = []
  const sent: Msg[] = []
  let n = 0
  const sessions = new Map<string, Page>()
  const emit = (msg: Msg): void => {
    const text = JSON.stringify(msg)
    let own = false
    for (const tap of taps) if (tap(text)) own = true
    if (!own) agent.push(text)
  }
  const line: CdpLine = {
    send(text) {
      const m = JSON.parse(text) as Msg
      sent.push(m)
      const params = (m.params ?? {}) as Msg
      queueMicrotask(() => {
        if (m.method === 'Target.getTargets')
          return emit({
            id: m.id,
            result: {
              targetInfos: [
                { targetId: 'sw', type: 'service_worker', url: 'https://x/sw.js' },
                ...pages.map(p => ({ targetId: p.id, type: 'page', url: p.url, title: p.title, attached: true })),
              ],
            },
          })
        if (m.method === 'Target.attachToTarget') {
          const page = pages.find(p => p.id === params.targetId) as Page
          const session = `S${++n}`
          sessions.set(session, page)
          // another client's attach to the same page at the same moment: the agent's, which goes on
          if (o.otherAttach)
            emit({
              method: 'Target.attachedToTarget',
              params: { sessionId: 'AGENT', targetInfo: { targetId: page.id } },
            })
          // Chrome says so before it answers
          emit({ method: 'Target.attachedToTarget', params: { sessionId: session, targetInfo: { targetId: page.id } } })
          return emit({ id: m.id, result: { sessionId: session } })
        }
        const page = sessions.get(String(m.sessionId))
        if (m.method === 'Page.getFrameTree')
          return emit({ id: m.id, sessionId: m.sessionId, result: { frameTree: { frame: { id: `F-${page?.id}` } } } })
        if (m.method === 'Page.createIsolatedWorld') {
          emit({ method: 'Runtime.executionContextCreated', sessionId: m.sessionId, params: {} })
          return emit({ id: m.id, sessionId: m.sessionId, result: { executionContextId: 7 } })
        }
        if (m.method === 'Page.bringToFront') return emit({ id: m.id, sessionId: m.sessionId, result: {} })
        if (m.method === 'Runtime.evaluate')
          return emit({ id: m.id, sessionId: m.sessionId, result: { result: { type: 'object', value: page?.look } } })
        if (m.method === 'Target.detachFromTarget') {
          emit({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId } })
          return emit({ id: m.id, result: {} })
        }
      })
    },
    tap(fn) {
      taps.add(fn)
      return () => taps.delete(fn)
    },
    pass(text) {
      agent.push(text)
    },
  }
  return { line, agent, sent, emit, taps }
}

const field = { editable: true, kind: 'password', cross: false }
const front = (url: string, more: Record<string, unknown> = {}): Page => ({
  id: url,
  url,
  title: `Title of ${url}`,
  look: { focus: true, visible: true, ...field, ...more },
})
const behind = (url: string): Page => ({ ...front(url), look: { focus: false, visible: false, ...field } })

describe('focusedPage', () => {
  test('the tab that shows: its address as Chrome lists it, its title and the field with the focus', async () => {
    const c = fakeChrome([behind('https://other.test/'), front('https://acme.test/login?next=x')])
    const r = await focusedPage(c.line)
    expect(r).toEqual({
      ok: true,
      url: 'https://acme.test/login?next=x',
      title: 'Title of https://acme.test/login?next=x',
      field: { editable: true, kind: 'password', crossFrame: false },
    })
    // read in a world of the board's own, the script its own, by value
    const evals = c.sent.filter(m => m.method === 'Runtime.evaluate')
    expect(evals.length).toBe(2)
    for (const e of evals)
      expect(e.params).toEqual({ expression: FOCUS_SCRIPT, contextId: 7, returnByValue: true, awaitPromise: false })
    expect(c.sent.filter(m => m.method === 'Page.createIsolatedWorld').length).toBe(2)
    // every session it attached detached again
    expect(c.sent.filter(m => m.method === 'Target.detachFromTarget').length).toBe(2)
    // ids no client counts to
    for (const m of c.sent) expect(Number(m.id)).toBeGreaterThanOrEqual(1_900_000_000)
  })

  test('to type there: that page made the active one, no other; read again after', async () => {
    const c = fakeChrome([behind('https://other.test/'), front('https://acme.test/login')])
    expect(await focusedPage(c.line, 5000, { activate: true })).toMatchObject({
      ok: true,
      url: 'https://acme.test/login',
    })
    const fronts = c.sent.filter(m => m.method === 'Page.bringToFront')
    expect(fronts.length).toBe(1)
    const attached = c.sent.filter(m => m.method === 'Target.attachToTarget').map(m => (m.params as Msg).targetId)
    expect(attached).toEqual(['https://other.test/', 'https://acme.test/login', 'https://acme.test/login'])
    // its session the last one attached: the page with the focus
    expect(fronts[0]?.sessionId).toBe('S3')
    expect(c.sent.filter(m => m.method === 'Runtime.evaluate').length).toBe(3)
    // without it, nothing is brought to the front
    const look = fakeChrome([front('https://acme.test/')])
    await focusedPage(look.line)
    expect(look.sent.some(m => m.method === 'Page.bringToFront')).toBe(false)
  })

  test('the agent’s client sees nothing of it, another client’s attach meanwhile it does', async () => {
    const c = fakeChrome([front('https://acme.test/')], { otherAttach: true })
    await focusedPage(c.line)
    await Bun.sleep(20)
    expect(c.agent.map(t => JSON.parse(t))).toEqual([
      {
        method: 'Target.attachedToTarget',
        params: { sessionId: 'AGENT', targetInfo: { targetId: 'https://acme.test/' } },
      },
    ])
    // a straggler of its own session after it is done stays the board's a while
    c.emit({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } })
    c.emit({ id: 5, result: {} })
    expect(c.agent.length).toBe(2)
    expect(JSON.parse(c.agent[1] as string)).toEqual({ id: 5, result: {} })
  })

  test('two windows that show: the one with the focus; none, or no telling: refused', async () => {
    const two = fakeChrome([front('https://a.test/', { focus: false }), front('https://b.test/')])
    expect(await focusedPage(two.line)).toMatchObject({ ok: true, url: 'https://b.test/' })
    const none = fakeChrome([behind('https://a.test/')])
    expect(await focusedPage(none.line)).toEqual({ ok: false, error: 'which page' })
    const both = fakeChrome([front('https://a.test/'), front('https://b.test/')])
    expect(await focusedPage(both.line)).toEqual({ ok: false, error: 'which page' })
  })

  test('a browser that does not answer: refused in time', async () => {
    const line: CdpLine = { send() {}, tap: () => () => {}, pass() {} }
    expect(await focusedPage(line, 100)).toEqual({ ok: false, error: 'the browser did not answer' })
  })

  test('nothing to type into, or a frame of another site: said so', async () => {
    const c = fakeChrome([front('https://acme.test/', { editable: false, kind: '', cross: true })])
    expect(await focusedPage(c.line)).toMatchObject({
      ok: true,
      field: { editable: false, kind: '', crossFrame: true },
    })
  })
})
