// The board's own small VNC client: RFB 3.3 to 3.8 (RFC 6143) over bytes that come and go however
// the page carries them (api/desktop.ts: a WebSocket through the board). The display of an agent's
// browser lives on the board's own server, reached only through the board's login, so the
// security is None and nothing else. It asks for 32-bit pixels laid out as the canvas takes them
// (red, green, blue, a spare byte), and for CopyRect, Hextile and Raw: what Xvnc sends to any viewer,
// small enough to read here without a decompressor (the board's socket may compress on the wire).
// A display that changes size says so (DesktopSize). Its cursor is drawn into the picture by the
// server. What it draws goes to `screen`; what it sends, to `send`.

/** Where the picture goes (hooks/useDesktop.ts: a canvas). */
export interface RfbScreen {
  /** The display is now `width` × `height`: at the server's hello, and when it changes size. */
  size(width: number, height: number): void
  /** These pixels (RGBA, opaque) at (x, y), `width` × `height`. */
  put(x: number, y: number, width: number, height: number, rgba: Uint8ClampedArray): void
  /** What is at (sx, sy) copied to (x, y), `width` × `height`. */
  copy(sx: number, sy: number, x: number, y: number, width: number, height: number): void
}

/**
 * Why it stopped: `protocol` (the other end is not a VNC server), `security` (it asks for a
 * password: the types it offered in `detail`), `refused` (the server's own reason), `data` (it sent
 * what this client did not ask for and cannot read on from).
 */
export interface RfbFailure {
  code: 'protocol' | 'security' | 'refused' | 'data'
  detail: string
}

export interface RfbEvents {
  /** Through the handshake: the display's name. */
  live?(name: string): void
  failed?(why: RfbFailure): void
}

export type RfbState = 'handshake' | 'live' | 'failed'

const ENCODINGS = [1, 5, 0, -223] // CopyRect, Hextile, Raw, DesktopSize
const RAW = 0
const COPY_RECT = 1
const HEXTILE = 5
const DESKTOP_SIZE = -223

/** The bytes that came and were not read yet, in the pieces they came in. */
class Pending {
  private chunks: Uint8Array[] = []
  private head = 0
  length = 0

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  /** The byte `at` places on, without taking it. */
  peek(at: number): number {
    let i = this.head + at
    for (const chunk of this.chunks) {
      if (i < chunk.length) return chunk[i] ?? 0
      i -= chunk.length
    }
    return 0
  }

  u16(at: number): number {
    return (this.peek(at) << 8) | this.peek(at + 1)
  }

  u32(at: number): number {
    return ((this.peek(at) << 24) | (this.peek(at + 1) << 16) | (this.peek(at + 2) << 8) | this.peek(at + 3)) >>> 0
  }

  /** The next `n` bytes, taken. */
  take(n: number): Uint8Array {
    const first = this.chunks[0]
    let out: Uint8Array
    if (first && first.length - this.head >= n) out = first.subarray(this.head, this.head + n)
    else {
      out = new Uint8Array(n)
      let filled = 0
      let i = 0
      let from = this.head
      while (filled < n) {
        const chunk = this.chunks[i++] as Uint8Array
        const part = chunk.subarray(from, Math.min(chunk.length, from + n - filled))
        out.set(part, filled)
        filled += part.length
        from = 0
      }
    }
    this.skip(n)
    return out
  }

  skip(n: number): void {
    this.length -= n
    this.head += n
    while (this.chunks[0] && this.head >= this.chunks[0].length) {
      this.head -= this.chunks[0].length
      this.chunks.shift()
    }
  }
}

/** Pixels as they come (R, G, B, spare) made opaque for the canvas. */
function opaque(pixels: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(pixels)
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  return rgba
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

export class RfbClient {
  state: RfbState = 'handshake'
  width = 0
  height = 0
  private readonly pending = new Pending()
  /** The step that reads next: false while what it needs has not come yet. */
  private step: () => boolean = () => this.version()
  private minor = 8
  private rects = 0
  /** Hextile's colours, kept from tile to tile in a rectangle. */
  private bg = new Uint8ClampedArray([0, 0, 0, 255])
  private fg = new Uint8ClampedArray([0, 0, 0, 255])

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    private readonly screen: RfbScreen,
    private readonly events: RfbEvents = {},
  ) {}

  /** Bytes from the server. */
  receive(bytes: Uint8Array): void {
    if (this.state === 'failed') return
    this.pending.push(bytes)
    while (this.state !== 'failed' && this.step()) {}
  }

  /** The mouse at (x, y) on the display with these buttons down (1 left, 2 middle, 4 right, 8/16 the wheel). */
  pointer(x: number, y: number, mask: number): void {
    if (this.state !== 'live') return
    const at = (n: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(n)))
    const px = at(x, this.width)
    const py = at(y, this.height)
    this.send(Uint8Array.of(5, mask & 255, px >> 8, px & 255, py >> 8, py & 255))
  }

  /** A key down or up, by its X keysym (models/desk-input.ts). */
  key(keysym: number, down: boolean): void {
    if (this.state !== 'live') return
    const k = keysym >>> 0
    this.send(Uint8Array.of(4, down ? 1 : 0, 0, 0, k >>> 24, (k >>> 16) & 255, (k >>> 8) & 255, k & 255))
  }

  private fail(code: RfbFailure['code'], detail: string): false {
    this.state = 'failed'
    this.events.failed?.({ code, detail })
    return false
  }

  private version(): boolean {
    if (this.pending.length < 12) return false
    const hello = text(this.pending.take(12))
    const m = /^RFB 003\.(\d{3})\n$/.exec(hello)
    if (!m) return this.fail('protocol', hello.trim())
    const minor = Number(m[1])
    this.minor = minor >= 8 ? 8 : minor === 7 ? 7 : 3
    this.send(new TextEncoder().encode(`RFB 003.00${this.minor}\n`))
    this.step = this.minor >= 7 ? () => this.securityTypes() : () => this.securityType()
    return true
  }

  private securityTypes(): boolean {
    if (this.pending.length < 1) return false
    const n = this.pending.peek(0)
    if (n === 0) {
      this.pending.skip(1)
      this.step = () => this.reason()
      return true
    }
    if (this.pending.length < 1 + n) return false
    const types = [...this.pending.take(1 + n).subarray(1)]
    if (!types.includes(1)) return this.fail('security', types.join(','))
    this.send(Uint8Array.of(1))
    this.step = this.minor >= 8 ? () => this.securityResult() : () => this.clientInit()
    return true
  }

  /** 3.3: the server names the one type. */
  private securityType(): boolean {
    if (this.pending.length < 4) return false
    const type = this.pending.u32(0)
    this.pending.skip(4)
    if (type === 0) {
      this.step = () => this.reason()
      return true
    }
    if (type !== 1) return this.fail('security', String(type))
    this.send(Uint8Array.of(1))
    return this.clientInit()
  }

  private securityResult(): boolean {
    if (this.pending.length < 4) return false
    const result = this.pending.u32(0)
    this.pending.skip(4)
    if (result === 0) return this.clientInit()
    this.step = () => this.reason()
    return true
  }

  private reason(): boolean {
    if (this.pending.length < 4) return false
    const n = this.pending.u32(0)
    if (this.pending.length < 4 + n) return false
    return this.fail('refused', text(this.pending.take(4 + n).subarray(4)))
  }

  /** Shared: other viewers of the display stay. */
  private clientInit(): boolean {
    this.send(Uint8Array.of(1))
    this.step = () => this.serverInit()
    return true
  }

  private serverInit(): boolean {
    if (this.pending.length < 24) return false
    const n = this.pending.u32(20)
    if (this.pending.length < 24 + n) return false
    this.width = this.pending.u16(0)
    this.height = this.pending.u16(2)
    const name = text(this.pending.take(24 + n).subarray(24))
    this.screen.size(this.width, this.height)
    // 32 bits, depth 24, little-endian, true colour, 255 each; red at 0, green 8, blue 16: R G B spare.
    this.send(Uint8Array.of(0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0))
    const encodings = new Uint8Array(4 + 4 * ENCODINGS.length)
    const view = new DataView(encodings.buffer)
    view.setUint8(0, 2)
    view.setUint16(2, ENCODINGS.length)
    for (const [i, e] of ENCODINGS.entries()) view.setInt32(4 + 4 * i, e)
    this.send(encodings)
    this.request(false)
    this.state = 'live'
    this.step = () => this.message()
    this.events.live?.(name)
    return true
  }

  private request(incremental: boolean): void {
    const { width: w, height: h } = this
    this.send(Uint8Array.of(3, incremental ? 1 : 0, 0, 0, 0, 0, w >> 8, w & 255, h >> 8, h & 255))
  }

  private message(): boolean {
    const p = this.pending
    if (p.length < 1) return false
    const type = p.peek(0)
    switch (type) {
      case 0: // FramebufferUpdate
        if (p.length < 4) return false
        this.rects = p.u16(2)
        p.skip(4)
        this.step = () => this.rect()
        return true
      case 1: {
        // SetColourMapEntries: none in true colour; read past.
        if (p.length < 6) return false
        const n = 6 + 6 * p.u16(4)
        if (p.length < n) return false
        p.skip(n)
        return true
      }
      case 2: // Bell
        p.skip(1)
        return true
      case 3: {
        // ServerCutText: the display's clipboard, not taken.
        if (p.length < 8) return false
        const n = 8 + p.u32(4)
        if (p.length < n) return false
        p.skip(n)
        return true
      }
      default:
        return this.fail('data', `message ${type}`)
    }
  }

  private rect(): boolean {
    const p = this.pending
    if (this.rects === 0) {
      this.request(true)
      this.step = () => this.message()
      return true
    }
    if (p.length < 12) return false
    const x = p.u16(0)
    const y = p.u16(2)
    const w = p.u16(4)
    const h = p.u16(6)
    const encoding = p.u32(8) | 0
    p.skip(12)
    this.rects--
    switch (encoding) {
      case RAW:
        this.step = () => this.raw(x, y, w, h)
        return true
      case COPY_RECT:
        this.step = () => this.copyRect(x, y, w, h)
        return true
      case HEXTILE:
        this.step = this.hextile(x, y, w, h)
        return true
      case DESKTOP_SIZE:
        this.width = w
        this.height = h
        this.screen.size(w, h)
        return true
      default:
        return this.fail('data', `encoding ${encoding}`)
    }
  }

  private raw(x: number, y: number, w: number, h: number): boolean {
    const n = w * h * 4
    if (this.pending.length < n) return false
    if (n > 0) this.screen.put(x, y, w, h, opaque(this.pending.take(n)))
    this.step = () => this.rect()
    return true
  }

  private copyRect(x: number, y: number, w: number, h: number): boolean {
    if (this.pending.length < 4) return false
    const sx = this.pending.u16(0)
    const sy = this.pending.u16(2)
    this.pending.skip(4)
    this.screen.copy(sx, sy, x, y, w, h)
    this.step = () => this.rect()
    return true
  }

  /** Hextile: 16 × 16 tiles left to right, top to bottom, each read once all of it has come. */
  private hextile(x: number, y: number, w: number, h: number): () => boolean {
    let tx = 0
    let ty = 0
    return () => {
      if (ty >= h) {
        this.step = () => this.rect()
        return true
      }
      const tw = Math.min(16, w - tx)
      const th = Math.min(16, h - ty)
      if (!this.tile(x + tx, y + ty, tw, th)) return false
      tx += 16
      if (tx >= w) {
        tx = 0
        ty += 16
      }
      return true
    }
  }

  private tile(x: number, y: number, w: number, h: number): boolean {
    const p = this.pending
    if (p.length < 1) return false
    const sub = p.peek(0)
    if (sub & 1) {
      const n = 1 + w * h * 4
      if (p.length < n) return false
      this.screen.put(x, y, w, h, opaque(p.take(n).subarray(1)))
      return true
    }
    let n = 1 + (sub & 2 ? 4 : 0) + (sub & 4 ? 4 : 0)
    let count = 0
    if (sub & 8) {
      if (p.length < n + 1) return false
      count = p.peek(n)
      n += 1 + count * (sub & 16 ? 6 : 2)
    }
    if (p.length < n) return false
    const bytes = p.take(n)
    let at = 1
    const colour = () => {
      const c = new Uint8ClampedArray([bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, 255])
      at += 4
      return c
    }
    if (sub & 2) this.bg = colour()
    if (sub & 4) this.fg = colour()
    if (sub & 8) at++
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < rgba.length; i += 4) rgba.set(this.bg, i)
    for (let i = 0; i < count; i++) {
      const c = sub & 16 ? colour() : this.fg
      const xy = bytes[at++] ?? 0
      const wh = bytes[at++] ?? 0
      const sx = xy >> 4
      const sy = xy & 15
      const sw = (wh >> 4) + 1
      const sh = (wh & 15) + 1
      for (let row = sy; row < Math.min(h, sy + sh); row++)
        for (let col = sx; col < Math.min(w, sx + sw); col++) rgba.set(c, (row * w + col) * 4)
    }
    this.screen.put(x, y, w, h, rgba)
    return true
  }
}
