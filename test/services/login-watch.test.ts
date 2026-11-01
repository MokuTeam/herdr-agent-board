// The board watching an agent's browser for the owner's own sign-in (services/login-watch.ts), on
// a DevTools line of the test's own playing Chrome: it attaches to the page in a session of its
// own, installs its world and its binding, and hands on a sign-in the script reports — the page's
// address coming from Chrome (Target.getTargetInfo), the username and the password from the script;
// and the agent's client sees nothing of any of it. Stopping detaches its sessions.
import { describe, expect, test } from 'bun:test'
import type { CdpLine } from '../../src/services/cdp-peek.ts'
import { CAPTURE_BINDING, CAPTURE_WORLD, createLoginWatch } from '../../src/services/login-watch.ts'

type Msg = Record<string, unknown>

/** Chrome as far as the watcher asks it: one page target, a session per attach, and what the agent's client got and what was sent. */
function fakeChrome(o: { url?: string; otherAttach?: boolean } = {}) {
  const taps = new Set<(text: string) => boolean>()
  const agent: string[] = []
  const sent: Msg[] = []
  let url = o.url ?? 'https://login.acme.test/in'
  let n = 0
  const sessions = new Map<string, string>() // session -> targetId
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
          return emit({ id: m.id, result: { targetInfos: [{ targetId: 'T1', type: 'page', url }] } })
        if (m.method === 'Target.attachToTarget') {
          const session = `W${++n}`
          sessions.set(session, String(params.targetId))
          if (o.otherAttach)
            emit({
              method: 'Target.attachedToTarget',
              params: { sessionId: 'AGENT', targetInfo: { targetId: params.targetId } },
            })
          emit({
            method: 'Target.attachedToTarget',
            params: { sessionId: session, targetInfo: { targetId: params.targetId } },
          })
          return emit({ id: m.id, result: { sessionId: session } })
        }
        if (m.method === 'Target.getTargetInfo')
          return emit({ id: m.id, result: { targetInfo: { targetId: params.targetId, url } } })
        if (m.method === 'Target.detachFromTarget') {
          emit({ method: 'Target.detachedFromTarget', params: { sessionId: params.sessionId } })
          return emit({ id: m.id, result: {} })
        }
        if (m.method === 'Page.getFrameTree')
          return emit({ id: m.id, sessionId: m.sessionId, result: { frameTree: { frame: { id: 'F1' } } } })
        if (m.method === 'Page.createIsolatedWorld')
          return emit({ id: m.id, sessionId: m.sessionId, result: { executionContextId: 11 } })
        // Runtime.enable, Runtime.addBinding, Page.enable, Page.addScriptToEvaluateOnNewDocument, Runtime.evaluate
        return emit({ id: m.id, sessionId: m.sessionId, result: {} })
      })
    },
    tap(fn) {
      taps.add(fn)
      return () => taps.delete(fn)
    },
    // the bridge forwards a held message that was not the watcher's to the agent's client
    pass(text) {
      agent.push(text)
    },
  }
  return {
    line,
    agent,
    sent,
    emit,
    sessionFor: (targetId: string) => [...sessions].find(([, t]) => t === targetId)?.[0],
    setUrl: (u: string) => {
      url = u
    },
  }
}

describe('catching the owner’s sign-in', () => {
  test('a sign-in the script reports: handed on with the page’s address from Chrome, the agent seeing nothing', async () => {
    const c = fakeChrome({ otherAttach: true })
    const caught: { url: string; username: string; password: string }[] = []
    const watch = createLoginWatch(c.line, { onCapture: cred => caught.push(cred), scanMs: 10_000 })
    await Bun.sleep(30)
    // the watcher attached and set up its world and binding
    expect(c.sent.some(m => m.method === 'Target.attachToTarget')).toBe(true)
    const addBinding = c.sent.find(m => m.method === 'Runtime.addBinding')
    expect((addBinding?.params as Msg)?.name).toBe(CAPTURE_BINDING)
    expect((addBinding?.params as Msg)?.executionContextName).toBe(CAPTURE_WORLD)
    const onNew = c.sent.find(m => m.method === 'Page.addScriptToEvaluateOnNewDocument')
    expect((onNew?.params as Msg)?.worldName).toBe(CAPTURE_WORLD)

    // the script reports a sign-in through the binding
    const session = c.sessionFor('T1') as string
    c.emit({
      method: 'Runtime.bindingCalled',
      sessionId: session,
      params: { name: CAPTURE_BINDING, payload: JSON.stringify({ username: 'bot@acme.test', password: 'Typed-9!' }) },
    })
    await Bun.sleep(20)
    expect(caught).toEqual([{ url: 'https://login.acme.test/in', username: 'bot@acme.test', password: 'Typed-9!' }])

    // the agent's client saw only the other client's attach, nothing of the watcher's
    expect(c.agent.map(t => JSON.parse(t))).toEqual([
      { method: 'Target.attachedToTarget', params: { sessionId: 'AGENT', targetInfo: { targetId: 'T1' } } },
    ])
    await watch.stop()
    expect(c.sent.some(m => m.method === 'Target.detachFromTarget')).toBe(true)
  })

  test('a binding call with no password is ignored', async () => {
    const c = fakeChrome()
    const caught: unknown[] = []
    const watch = createLoginWatch(c.line, { onCapture: cred => caught.push(cred), scanMs: 10_000 })
    await Bun.sleep(30)
    const session = c.sessionFor('T1') as string
    c.emit({
      method: 'Runtime.bindingCalled',
      sessionId: session,
      params: { name: CAPTURE_BINDING, payload: JSON.stringify({ username: 'bot', password: '' }) },
    })
    await Bun.sleep(20)
    expect(caught).toEqual([])
    await watch.stop()
  })

  test('once stopped, a straggler on its session still never reaches the agent', async () => {
    const c = fakeChrome()
    const watch = createLoginWatch(c.line, { onCapture: () => {}, scanMs: 10_000 })
    await Bun.sleep(30)
    const session = c.sessionFor('T1') as string
    await watch.stop()
    c.emit({ method: 'Runtime.consoleAPICalled', sessionId: session, params: {} })
    expect(c.agent.length).toBe(0)
  })
})
