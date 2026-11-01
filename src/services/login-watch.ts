// The board watching an agent's browser for the owner's own sign-in (core/login-save.ts), while
// the owner holds that browser (services/desktop.ts control: "the owner has it"). It runs only
// then, and nothing of it runs on a session where the agent acts. On the agent's DevTools line
// (services/desktop.ts bridges it; Chrome's holder takes one client at a time), its own messages
// kept from the agent's client as the board's look does (services/cdp-peek.ts): the ids are far
// past any a client uses, the sessions it attaches are its own, and nothing it does reaches the
// agent's client.
//
// In a world of the board's own (Page.addScriptToEvaluateOnNewDocument with worldName, and the same
// script in an isolated world for the page already open), a small script listens for a form submit,
// an Enter or a click that submits, with a non-empty password field, and hands back the username it
// finds and the password through a binding (Runtime.addBinding, exposed in that world only). The
// script sees the DOM but not the page's own scripts (an isolated world has its own globals), and
// the page's origin comes from Chrome (Target.getTargetInfo), never the script's word. Only the top
// document is watched: a field in a frame of another site is left alone (its submit does not bubble
// to the top). The password is handed on at once and kept nowhere here.
import type { CdpLine } from './cdp-peek.ts'

type Msg = Record<string, unknown>
const isRecord = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v)

/** The binding the board exposes in its own world; the caught sign-in arrives through it. */
export const CAPTURE_BINDING = 'agentBoardLoginCapture'
/** The name of the board's own isolated world (as services/cdp-peek.ts uses for its look). */
export const CAPTURE_WORLD = 'agent-board'

/** Ids of the watcher's own commands: far past any a client counts to, and below the look's range (services/cdp-peek.ts). */
const BASE_ID = 1_800_000_000
const ID_TOP = 1_899_999_999

/**
 * In the board's own world, sharing the page's DOM: listens for a sign-in (a form submit, an Enter,
 * or a click on a submit) with a non-empty password field, and hands back the username before the
 * password field (or the last text/e-mail field the owner edited, for a two-step form) and the
 * password. Never throws into the page; installs once per world.
 */
export const CAPTURE_SCRIPT = `(() => {
  if (globalThis.__boardLoginWatch) return; globalThis.__boardLoginWatch = 1;
  var send = globalThis.${CAPTURE_BINDING};
  if (typeof send !== 'function') return;
  var lastUser = '';
  var isText = function (el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var ty = String(el.getAttribute('type') || 'text').toLowerCase();
    return ty === 'text' || ty === 'email' || ty === 'tel' || ty === '';
  };
  document.addEventListener('input', function (e) {
    try { var el = e.target; if (isText(el) && el.value) lastUser = el.value; } catch (x) {}
  }, true);
  var grab = function (scope) {
    try {
      var root = scope && scope.querySelectorAll ? scope : document;
      var pws = Array.prototype.slice.call(root.querySelectorAll('input[type=password]'));
      var pw = null;
      for (var i = 0; i < pws.length; i++) { if (pws[i].value) { pw = pws[i]; break; } }
      if (!pw) return;
      var user = '';
      var form = pw.form;
      if (form) {
        var ins = form.querySelectorAll('input');
        for (var j = 0; j < ins.length; j++) { if (ins[j] === pw) break; if (isText(ins[j]) && ins[j].value) user = ins[j].value; }
      }
      if (!user) user = lastUser;
      send(JSON.stringify({ username: user, password: pw.value }));
    } catch (x) {}
  };
  document.addEventListener('submit', function (e) { try { grab(e.target); } catch (x) {} }, true);
  document.addEventListener('keydown', function (e) {
    try { if (e.key === 'Enter' || e.keyCode === 13) grab((e.target && e.target.form) || document); } catch (x) {}
  }, true);
  document.addEventListener('click', function (e) {
    try {
      var el = e.target;
      for (var n = 0; el && n < 4 && el !== document.body; n++) {
        var tag = el.tagName, ty = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase();
        var txt = ((el.textContent || '') + ' ' + (el.getAttribute && el.getAttribute('aria-label') || '')).toLowerCase();
        if (ty === 'submit' || (tag === 'BUTTON' && ty !== 'button' && ty !== 'reset') ||
            /sign|log.?in|continue|next|enter|submit|войти|вход|продолж|дал/.test(txt)) { grab(document); return; }
        el = el.parentElement;
      }
    } catch (x) {}
  }, true);
})()`

export interface LoginWatch {
  stop(): Promise<void>
}

export interface LoginWatchOptions {
  /** A sign-in the owner typed: the page's address from Chrome, the username and the password. */
  onCapture(c: { url: string; username: string; password: string }): void
  log?(line: string): void
  now?(): number
  /** How often the open tabs are looked at again, for one the owner opened since (default 2s). */
  scanMs?: number
  /** How long one of the watcher's own commands may take (default 5s). */
  timeoutMs?: number
}

/**
 * Starts watching the browser on `line` for the owner's own sign-in, in the board's own world; the
 * agent's client sees nothing of it. `stop()` detaches the watcher's sessions (its binding and
 * script go with them) and stops looking. Errors are the watcher's own; nothing of them reaches
 * the agent.
 */
export function createLoginWatch(line: CdpLine, o: LoginWatchOptions): LoginWatch {
  const scanMs = o.scanMs ?? 2000
  const timeoutMs = o.timeoutMs ?? 5000
  const log = o.log ?? (() => {})
  const pending = new Map<number, { done: (v: Msg) => void; fail: (e: Error) => void }>()
  /** The watcher's own sessions, each to the page target it attaches. */
  const mine = new Map<string, string>()
  /** The targets being watched (so a scan does not attach twice). */
  const watched = new Set<string>()
  /** Chrome's word of an attach to a target while the watcher's own attach is under way: held until it knows whose it is (services/cdp-peek.ts). */
  const held = new Map<string, string[]>()
  let nextId = BASE_ID
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const untap = line.tap(text => {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return false
    }
    if (!isRecord(msg)) return false
    if (typeof msg.id === 'number' && msg.id >= BASE_ID && msg.id <= ID_TOP) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (p) {
        if (isRecord(msg.error)) p.fail(new Error(String(msg.error.message ?? 'cdp')))
        else p.done(isRecord(msg.result) ? msg.result : {})
        return true
      }
      return false
    }
    const params = isRecord(msg.params) ? msg.params : {}
    // our attach's echo comes before our answer: it is held for the target we are attaching, and once
    // we know our session, the ones that are not ours go on to the agent (another client's attach)
    if (msg.method === 'Target.attachedToTarget') {
      const session = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (mine.has(session)) return true
      const info = isRecord(params.targetInfo) ? params.targetInfo : {}
      const target = typeof info.targetId === 'string' ? info.targetId : ''
      const buf = target ? held.get(target) : undefined
      if (buf) {
        buf.push(text)
        return true
      }
      return false
    }
    // a detach's word carries the session in its params, not at the top
    if (msg.method === 'Target.detachedFromTarget')
      return typeof params.sessionId === 'string' && mine.has(params.sessionId)
    const sid = typeof msg.sessionId === 'string' ? msg.sessionId : ''
    if (!sid || !mine.has(sid)) return false
    // everything on one of the watcher's sessions is the watcher's: the page's events, the world's, the caught sign-in
    if (msg.method === 'Runtime.bindingCalled' && params.name === CAPTURE_BINDING)
      void caught(sid, typeof params.payload === 'string' ? params.payload : '')
    return true
  })

  function call(method: string, params: Msg = {}, sessionId?: string): Promise<Msg> {
    return new Promise<Msg>((resolve, reject) => {
      if (stopped) return reject(new Error('stopped'))
      nextId = nextId >= ID_TOP ? BASE_ID : nextId + 1
      const id = nextId
      const timeout = setTimeout(() => {
        if (pending.delete(id)) reject(new Error('the browser did not answer'))
      }, timeoutMs)
      timeout.unref?.()
      pending.set(id, {
        done: v => {
          clearTimeout(timeout)
          resolve(v)
        },
        fail: e => {
          clearTimeout(timeout)
          reject(e)
        },
      })
      line.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    })
  }

  /** A sign-in the script handed back: the page's address from Chrome (the session's target), the username and password. */
  async function caught(session: string, payload: string): Promise<void> {
    const targetId = mine.get(session)
    if (!targetId) return
    let data: unknown
    try {
      data = JSON.parse(payload)
    } catch {
      return
    }
    if (!isRecord(data)) return
    const username = typeof data.username === 'string' ? data.username : ''
    const password = typeof data.password === 'string' ? data.password : ''
    if (!password) return
    let url = ''
    try {
      const info = await call('Target.getTargetInfo', { targetId })
      const t = isRecord(info.targetInfo) ? info.targetInfo : {}
      url = typeof t.url === 'string' ? t.url : ''
    } catch {
      return
    }
    if (url) o.onCapture({ url, username, password })
  }

  /** Attaches to one page target in a session of the watcher's own, and installs the world and the script. */
  async function watch(targetId: string): Promise<void> {
    if (stopped || watched.has(targetId)) return
    watched.add(targetId)
    held.set(targetId, [])
    try {
      const r = await call('Target.attachToTarget', { targetId, flatten: true })
      const session = typeof r.sessionId === 'string' ? r.sessionId : ''
      if (!session) {
        watched.delete(targetId)
        return
      }
      mine.set(session, targetId)
      // what Chrome said of an attach to this target meanwhile that is not the watcher's goes on to the agent
      for (const text of held.get(targetId) ?? []) {
        let p: unknown
        try {
          p = JSON.parse(text)
        } catch {}
        const s = isRecord(p) && isRecord(p.params) ? p.params.sessionId : undefined
        if (s !== session) line.pass(text)
      }
      await call('Runtime.enable', {}, session)
      await call('Runtime.addBinding', { name: CAPTURE_BINDING, executionContextName: CAPTURE_WORLD }, session)
      await call('Page.enable', {}, session)
      await call('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SCRIPT, worldName: CAPTURE_WORLD }, session)
      // the page already open: the same script in an isolated world of the board's, now
      const tree = await call('Page.getFrameTree', {}, session)
      const frame = isRecord(tree.frameTree) && isRecord(tree.frameTree.frame) ? tree.frameTree.frame.id : undefined
      if (typeof frame === 'string') {
        const world = await call('Page.createIsolatedWorld', { frameId: frame, worldName: CAPTURE_WORLD }, session)
        const contextId = world.executionContextId
        if (typeof contextId === 'number')
          await call('Runtime.evaluate', { expression: CAPTURE_SCRIPT, contextId, awaitPromise: false }, session)
      }
    } catch (err) {
      watched.delete(targetId)
      if (!stopped) log(`login watch: a tab was not watched (${err instanceof Error ? err.message : String(err)})`)
    } finally {
      held.delete(targetId)
    }
  }

  async function scan(): Promise<void> {
    if (stopped) return
    try {
      const t = await call('Target.getTargets')
      const pages = (Array.isArray(t.targetInfos) ? t.targetInfos : [])
        .filter(isRecord)
        .filter(i => i.type === 'page' && typeof i.targetId === 'string')
        .slice(0, 16)
      const live = new Set(pages.map(p => String(p.targetId)))
      for (const id of [...watched]) if (!live.has(id)) watched.delete(id)
      for (const [session, targetId] of [...mine]) if (!live.has(targetId)) mine.delete(session)
      await Promise.all(pages.map(p => watch(String(p.targetId))))
    } catch (err) {
      if (!stopped) log(`login watch: the tabs were not read (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  void scan().then(() => {
    if (stopped) return
    timer = setInterval(() => void scan(), scanMs)
    timer.unref?.()
  })

  return {
    async stop() {
      if (stopped) return
      stopped = true
      clearTimeout(timer as ReturnType<typeof setTimeout>)
      clearInterval(timer as ReturnType<typeof setInterval>)
      // `mine` stays as it is until the tap goes: its sessions' stragglers (the detaches' word) are kept from the agent meanwhile
      const sessions = [...mine.keys()]
      watched.clear()
      // the sessions detached: the binding and the on-new-document script go with them
      await Promise.all(
        sessions.map(sessionId =>
          new Promise<Msg>((done, fail) => {
            nextId = nextId >= ID_TOP ? BASE_ID : nextId + 1
            const id = nextId
            pending.set(id, { done, fail })
            const to = setTimeout(() => {
              if (pending.delete(id)) done({})
            }, timeoutMs)
            to.unref?.()
            line.send(JSON.stringify({ id, method: 'Target.detachFromTarget', params: { sessionId } }))
          }).catch(() => ({})),
        ),
      )
      for (const p of pending.values()) p.fail(new Error('stopped'))
      pending.clear()
      // a straggler of a session after its detach may still come: kept from the agent a while more
      setTimeout(untap, 1500)
    },
  }
}
