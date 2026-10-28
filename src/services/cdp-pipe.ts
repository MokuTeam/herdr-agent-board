// A desktop's Chrome on its DevTools pipe (`--remote-debugging-pipe`: no TCP port, which any account
// on the server could reach), for one client at a time. The holder (entrypoints/cdp-pipe.ts) runs
// Chrome with the pipe and serves it on a Unix socket in the desktop's folder (0600 in a 0700
// folder: the board's user's alone); the board bridges that socket to its keyed route
// (routes/desktop.ts /api/browser/cdp) for the agent's chrome-devtools-mcp.
//
// The pipe outlives its clients (and the board's restarts), so the ids on it are the holder's own:
// an answer meant for a client gone never reaches the next one, which may use the same ids. And
// what a client set on the browser is undone when it goes, as Chrome does for a WebSocket client
// that disconnects: auto-attach (which would hold every page opened later, the owner's too, waiting
// for a debugger no one is), target discovery, and its sessions (each page let run first).

type Msg = Record<string, unknown>
const isRecord = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v)

export interface CdpClient {
  /** A message from the client (one JSON command). */
  send(text: string): void
  /** The client went: what it set is undone. */
  close(): void
}

export interface CdpMux {
  /** A message from Chrome. */
  fromChrome(text: string): void
  /** A client connects, in place of the one before (whose `kick` is called): messages to it by `out`. */
  connect(out: (text: string) => void, kick: () => void): CdpClient
  /** Chrome answered on its pipe: its product. */
  ready: Promise<string>
}

const MAX_ID = 0x7fffffff

export function createCdpMux(toChrome: (text: string) => void): CdpMux {
  interface Client {
    out(text: string): void
    kick(): void
  }
  let last = 0
  /** Each command on the pipe: whose (null: the holder's own), its id as its client gave it, its method. */
  const pending = new Map<number, { client: Client | null; id: unknown; method: string }>()
  /** The sessions attached through the pipe, detached when their client goes. */
  const sessions = new Set<string>()
  let current: Client | null = null
  const nextId = (): number => {
    last = last >= MAX_ID ? 1 : last + 1
    return last
  }
  function own(method: string, params: Msg = {}, sessionId?: string): number {
    const id = nextId()
    pending.set(id, { client: null, id, method })
    toChrome(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }))
    return id
  }
  let readyNow: (product: string) => void = () => {}
  const ready = new Promise<string>(resolve => {
    readyNow = resolve
  })
  const version = own('Browser.getVersion')

  function undo(): void {
    own('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true })
    own('Target.setDiscoverTargets', { discover: false })
    for (const s of sessions) {
      own('Runtime.runIfWaitingForDebugger', {}, s)
      own('Target.detachFromTarget', { sessionId: s })
    }
    sessions.clear()
  }

  return {
    ready,
    fromChrome(text) {
      let msg: unknown
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (!isRecord(msg)) return
      if (typeof msg.id === 'number') {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id)
        const result = isRecord(msg.result) ? msg.result : {}
        if (msg.id === version) readyNow(String(result.product ?? 'Chrome'))
        if (p.method.startsWith('Target.attachTo') && typeof result.sessionId === 'string')
          sessions.add(result.sessionId)
        if (p.client && p.client === current) p.client.out(JSON.stringify({ ...msg, id: p.id }))
        return
      }
      const params = isRecord(msg.params) ? msg.params : {}
      if (msg.method === 'Target.attachedToTarget' && typeof params.sessionId === 'string')
        sessions.add(params.sessionId)
      if (msg.method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string')
        sessions.delete(params.sessionId)
      current?.out(text)
    },
    connect(out, kick) {
      const before = current
      if (before) {
        current = null
        before.kick()
        undo()
      }
      const c: Client = { out, kick }
      current = c
      return {
        send(text) {
          if (current !== c) return
          let msg: unknown
          try {
            msg = JSON.parse(text)
          } catch {
            return
          }
          if (!isRecord(msg) || typeof msg.id !== 'number' || typeof msg.method !== 'string') return
          const id = nextId()
          pending.set(id, { client: c, id: msg.id, method: msg.method })
          toChrome(JSON.stringify({ ...msg, id }))
        },
        close() {
          if (current !== c) return
          current = null
          undo()
        },
      }
    },
  }
}

/** A byte stream cut into the pipe's messages (each ended by a NUL byte), as UTF-8 text. */
export function nulFrames(): (chunk: Uint8Array) => string[] {
  let pieces: Buffer[] = []
  return chunk => {
    const out: string[] = []
    let buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    for (let at = buf.indexOf(0); at !== -1; at = buf.indexOf(0)) {
      pieces.push(buf.subarray(0, at))
      out.push(Buffer.concat(pieces).toString('utf8'))
      pieces = []
      buf = buf.subarray(at + 1)
    }
    // a copy: the chunk's memory is the stream's
    if (buf.length) pieces.push(Buffer.from(buf))
    return out
  }
}
