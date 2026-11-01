// What the board itself reads of an agent's browser before it types a login there (services/
// login-fill.ts): which page has the focus, at which address (Chrome's own, not the page's word),
// and what has the focus in it, read in a world of the board's own (Page.createIsolatedWorld: no
// script of the page's can change what it reads). On the agent's DevTools connection when one is
// open (services/desktop.ts bridges it; Chrome's holder takes one client at a time), its own
// messages kept from the agent's client: their ids are far past any a client uses, the session it
// attaches is its own, and Chrome's word of that attach and detach never reaches the agent; or on
// a connection of its own to the holder when none is. Nothing it reads is a value of a field.

type Msg = Record<string, unknown>
const isRecord = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v)

/** A DevTools connection the board can use beside the agent's: what it sends, and a look at each message before the agent's client. */
export interface CdpLine {
  send(text: string): void
  /** `fn` sees each message from Chrome first; true keeps it from the agent. Returns its removal. */
  tap(fn: (text: string) => boolean): () => void
  /** A message held back that is the agent's after all: on to its client (nothing on a connection of the board's own). */
  pass(text: string): void
}

/** What has the focus on the page: a field to type into, its kind, or nothing that takes text. */
export interface FocusedField {
  editable: boolean
  /** password, email, username, code (a one-time code's), text; '' for no field. */
  kind: string
  /** In a frame of another site, which the board cannot look into. */
  crossFrame: boolean
}

export interface PageFocus {
  url: string
  title: string
  field: FocusedField
}

export type PeekResult = ({ ok: true } & PageFocus) | { ok: false; error: string }

/** Ids of the board's own commands: far past any a client counts to (the holder's mux takes up to 2^31 - 1). */
const BASE_ID = 1_900_000_000
let nextId = BASE_ID

/** In the board's own world: the focus, whether the page shows, and what has the focus (through shadow roots and frames of the page's own site). */
export const FOCUS_SCRIPT = `(() => {
  let el = document.activeElement, doc = document, cross = false
  for (let i = 0; i < 32 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue }
    const tag = el.tagName
    if (tag === 'IFRAME' || tag === 'FRAME') {
      let inner = null
      try { inner = el.contentDocument } catch (e) {}
      if (!inner) { cross = true; break }
      doc = inner; el = inner.activeElement; continue
    }
    break
  }
  const tag = el && el.tagName ? el.tagName.toLowerCase() : ''
  const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : ''
  const auto = el && el.getAttribute ? String(el.getAttribute('autocomplete') || '').toLowerCase() : ''
  const noText = ['button','submit','reset','checkbox','radio','file','image','hidden','range','color']
  const editable = !!el && !cross && el !== doc.body && !el.disabled && !el.readOnly &&
    (tag === 'textarea' || (tag === 'input' && !noText.includes(type)) || !!el.isContentEditable)
  const kind = !editable ? '' : type === 'password' ? 'password' : /one-time-code/.test(auto) ? 'code'
    : type === 'email' || /email/.test(auto) ? 'email' : /username/.test(auto) ? 'username' : 'text'
  return { focus: document.hasFocus(), visible: document.visibilityState === 'visible', editable, kind, cross }
})()`

interface Look {
  focus: boolean
  visible: boolean
  editable: boolean
  kind: string
  cross: boolean
}

const lookOf = (v: unknown): Look | null =>
  isRecord(v) && typeof v.visible === 'boolean'
    ? {
        focus: v.focus === true,
        visible: v.visible,
        editable: v.editable === true,
        kind: typeof v.kind === 'string' ? v.kind : '',
        cross: v.cross === true,
      }
    : null

/**
 * The page that has the focus in the browser on `line` (the one tab that shows; of several, the one
 * with the focus), its address and title as Chrome has them, and what has the focus on it. With
 * `activate`, that page is made the active one of its window first (Page.bringToFront: a Chrome on a
 * display with no window manager takes keys from the display only once it is; the element with the
 * focus stays it), and what has the focus is read after.
 */
export async function focusedPage(
  line: CdpLine,
  timeoutMs = 5000,
  o: { activate?: boolean } = {},
): Promise<PeekResult> {
  const pending = new Map<number, { done: (v: Msg) => void; fail: (e: Error) => void }>()
  const mine = new Set<string>()
  /** Chrome's word of an attach to a target while the board's attach to it is under way: whose it is shows with the answer. */
  const held = new Map<string, string[]>()
  const untap = line.tap(text => {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return false
    }
    if (!isRecord(msg)) return false
    if (typeof msg.id === 'number' && pending.has(msg.id) && msg.id >= BASE_ID) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (isRecord(msg.error)) p?.fail(new Error(String(msg.error.message ?? 'cdp')))
      else p?.done(isRecord(msg.result) ? msg.result : {})
      return true
    }
    if (typeof msg.sessionId === 'string' && mine.has(msg.sessionId)) return true
    const params = isRecord(msg.params) ? msg.params : {}
    if (msg.method === 'Target.attachedToTarget') {
      const session = typeof params.sessionId === 'string' ? params.sessionId : ''
      if (mine.has(session)) return true
      const info = isRecord(params.targetInfo) ? params.targetInfo : {}
      const list = typeof info.targetId === 'string' ? held.get(info.targetId) : undefined
      if (list) {
        list.push(text)
        return true
      }
    }
    if (
      msg.method === 'Target.detachedFromTarget' &&
      typeof params.sessionId === 'string' &&
      mine.has(params.sessionId)
    )
      return true
    return false
  })
  const call = (method: string, params: Msg = {}, sessionId?: string): Promise<Msg> =>
    new Promise((done, fail) => {
      nextId = nextId >= 0x7ffffff0 ? BASE_ID : nextId + 1
      const id = nextId
      pending.set(id, { done, fail })
      line.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error('the browser did not answer')), timeoutMs)
  })

  /** Attached to `targetId` in a session of the board's own; what Chrome said of another's attach meanwhile goes on. */
  async function attach(targetId: string): Promise<string> {
    held.set(targetId, [])
    try {
      const r = await call('Target.attachToTarget', { targetId, flatten: true })
      const session = typeof r.sessionId === 'string' ? r.sessionId : ''
      if (session) mine.add(session)
      for (const text of held.get(targetId) ?? []) {
        let p: unknown
        try {
          p = JSON.parse(text)
        } catch {}
        const s = isRecord(p) && isRecord(p.params) ? p.params.sessionId : undefined
        if (s !== session) line.pass(text)
      }
      if (!session) throw new Error('no session')
      return session
    } finally {
      held.delete(targetId)
    }
  }

  async function look(targetId: string, activate = false): Promise<Look | null> {
    const session = await attach(targetId)
    try {
      if (activate) await call('Page.bringToFront', {}, session)
      const tree = await call('Page.getFrameTree', {}, session)
      const frame = isRecord(tree.frameTree) && isRecord(tree.frameTree.frame) ? tree.frameTree.frame.id : undefined
      if (typeof frame !== 'string') return null
      const world = await call('Page.createIsolatedWorld', { frameId: frame, worldName: 'agent-board' }, session)
      const contextId = world.executionContextId
      if (typeof contextId !== 'number') return null
      const r = await call(
        'Runtime.evaluate',
        { expression: FOCUS_SCRIPT, contextId, returnByValue: true, awaitPromise: false },
        session,
      )
      return lookOf(isRecord(r.result) ? r.result.value : undefined)
    } finally {
      await call('Target.detachFromTarget', { sessionId: session }).catch(() => ({}))
    }
  }

  try {
    return await Promise.race([
      (async (): Promise<PeekResult> => {
        const t = await call('Target.getTargets')
        const pages = (Array.isArray(t.targetInfos) ? t.targetInfos : [])
          .filter(isRecord)
          .filter(i => i.type === 'page' && typeof i.targetId === 'string' && typeof i.url === 'string')
          .slice(0, 12)
        const seen: { id: string; url: string; title: string; look: Look }[] = []
        for (const p of pages) {
          const l = await look(String(p.targetId)).catch(() => null)
          if (l?.visible)
            seen.push({ id: String(p.targetId), url: String(p.url), title: String(p.title ?? ''), look: l })
        }
        const focused = seen.length > 1 ? seen.filter(s => s.look.focus) : seen
        if (focused.length !== 1 || !focused[0]) return { ok: false, error: 'which page' }
        const { id, url, title } = focused[0]
        const l = o.activate ? await look(id, true) : focused[0].look
        if (!l) return { ok: false, error: 'which page' }
        return { ok: true, url, title, field: { editable: l.editable, kind: l.kind, crossFrame: l.cross } }
      })(),
      late,
    ])
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
    for (const p of pending.values()) p.fail(new Error('done'))
    pending.clear()
    // Chrome's word of the board's own detach may come after its answer: kept from the agent a while more
    setTimeout(untap, 1500)
  }
}
