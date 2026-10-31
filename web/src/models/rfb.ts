// The board's own small VNC client: RFB 3.3 to 3.8 (RFC 6143) over bytes that come and go however
// the page carries them (api/desktop.ts: a WebSocket through the board). The display of an agent's
// browser lives on the board's own server, reached only through the board's login, so the security
// is None and nothing else. It asks for 32-bit pixels laid out as the canvas takes them (red,
// green, blue, a spare byte), and for Tight first: a picture's flat parts as one colour, its
// few-colour parts (text) as a palette through zlib, its photos and the like as JPEG, which the
// browser decodes (models/desk-screen.ts); a frame of a page scrolling, about 150 KB rather than
// Hextile's 1 MB and more. The zlib is the client's own (models/inflate.ts). CopyRect, Hextile and
// Raw stay as they were, for a server that does not do Tight. With Xvnc (TigerVNC) the server sends
// what changed as it changes (continuous updates, which it does only with fences: it paces itself
// by the fences' round trips); with a server that does not, the next update is asked for as soon as
// one starts to come, so no round trip waits between them. A display that changes size says so
// (DesktopSize). Its cursor is drawn into the picture by the server. What it draws goes to
// `screen`; what it sends, to `send`.
import { Inflater } from './inflate.ts'

/** Where the picture goes (models/desk-screen.ts: a canvas), each in the order it came. */
export interface RfbScreen {
  /** The display is now `width` × `height`: at the server's hello, and when it changes size. */
  size(width: number, height: number): void
  /** These pixels (RGBA, opaque) at (x, y), `width` × `height`. */
  put(x: number, y: number, width: number, height: number, rgba: Uint8ClampedArray<ArrayBuffer>): void
  /** What is at (sx, sy) copied to (x, y), `width` × `height`. */
  copy(sx: number, sy: number, x: number, y: number, width: number, height: number): void
  /** One colour over (x, y), `width` × `height`. */
  fill(x: number, y: number, width: number, height: number, r: number, g: number, b: number): void
  /** A JPEG picture of (x, y), `width` × `height`: decoded and drawn after what came before it, before what comes after. */
  jpeg(x: number, y: number, width: number, height: number, data: Uint8Array): void
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
  /** An update all read and handed to the screen. */
  updated?(): void
  /** The answer to a ping (RfbClient.ping): the round trip to the server, in ms. */
  pong?(ms: number): void
}

export type RfbState = 'handshake' | 'live' | 'failed'

export interface RfbOptions {
  /** JPEG's quality while the link is fast, 0 to 9 (QUALITY). */
  quality?: number
  /** Lower it while the link is slow (SLOW_QUALITY); on unless false. */
  adapt?: boolean
  /** The clock (ms) the link's speed is read by. */
  now?: () => number
}

const RAW = 0
const COPY_RECT = 1
const HEXTILE = 5
const TIGHT = 7
const DESKTOP_SIZE = -223
const FENCE = -312
const CONTINUOUS_UPDATES = -313
/** Tight's JPEG quality, 0 to 9: -32 + it. */
const QUALITY_0 = -32
/** Tight's zlib level, 0 to 9: -256 + it. */
const COMPRESS_0 = -256
/** JPEG at 6: TigerVNC's own viewer's choice below 16 Mbit/s (its JPEG quality 79, no chroma subsampling: text stays clean). */
export const QUALITY = 6
/** zlib at 2: little of the server's time for most of what more would save. */
export const COMPRESSION = 2
/**
 * While the link is slow, JPEG at 4 (its quality 62, colour at half width): a scrolled page's
 * frames a third smaller, so they keep up; the server sends the picture again at its best once it
 * stops changing. Slow: updates come slower than SLOW_MBPS; fast again: faster than FAST_MBPS.
 */
export const SLOW_QUALITY = 4
const SLOW_MBPS = 6
const FAST_MBPS = 10
/** An update tells the link's speed when this much of it came after its first piece. */
const MEASURED_BYTES = 64 * 1024

/** The server's: it can send continuous updates (or it stopped); the client's (the same number): send them. */
const END_OF_CONTINUOUS_UPDATES = 150
const ENABLE_CONTINUOUS_UPDATES = 150
const SERVER_FENCE = 248
/** A fence's flags: the other end asks for an answer; what before it, and what after it, must be done first. */
const FENCE_REQUEST = 0x80000000
const FENCE_BLOCK = 0b11
/** A ping's fence says so in its first two bytes ("pp"), then its number. */
const PING = 0x70
/** A display larger than this on a side is not one Xvnc makes: the client stops instead of making a canvas that big. */
const MAX_SIDE = 8192
/** Tight's data shorter than this comes as it is, not through zlib. */
const TIGHT_MIN_TO_COMPRESS = 12

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
function opaque(pixels: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(pixels)
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
  return rgba
}

/** Tight's pixels, three bytes each (red, green, blue), as RGBA. */
function fromRgb(rgb: Uint8Array, n: number): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(n * 4)
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const o = i * 4
    rgba[o] = rgb[j] as number
    rgba[o + 1] = rgb[j + 1] as number
    rgba[o + 2] = rgb[j + 2] as number
    rgba[o + 3] = 255
  }
  return rgba
}

/** Tight's palette: each pixel its colour's index, one bit each for two colours (rows to a byte), a byte each for more. */
function fromPalette(data: Uint8Array, palette: Uint8Array, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const colours = palette.length / 3
  const rgba = new Uint8ClampedArray(w * h * 4)
  const row = colours <= 2 ? (w + 7) >> 3 : w
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const index =
        colours <= 2 ? ((data[y * row + (x >> 3)] as number) >> (7 - (x & 7))) & 1 : (data[y * row + x] as number)
      const c = (index < colours ? index : 0) * 3
      const o = (y * w + x) * 4
      rgba[o] = palette[c] as number
      rgba[o + 1] = palette[c + 1] as number
      rgba[o + 2] = palette[c + 2] as number
      rgba[o + 3] = 255
    }
  return rgba
}

/** Tight's gradient: each colour the difference from left + above - above left (kept within 0 to 255). */
function fromGradient(data: Uint8Array, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const left = x > 0 ? (rgba[o - 4 + c] as number) : 0
        const up = y > 0 ? (rgba[o - w * 4 + c] as number) : 0
        const upLeft = x > 0 && y > 0 ? (rgba[o - w * 4 - 4 + c] as number) : 0
        const guess = Math.max(0, Math.min(255, left + up - upLeft))
        rgba[o + c] = ((data[(y * w + x) * 3 + c] as number) + guess) & 255
      }
      rgba[o + 3] = 255
    }
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
  /** Tight's four zlib streams, each going on from rectangle to rectangle. */
  private readonly zlib = [new Inflater(), new Inflater(), new Inflater(), new Inflater()]
  /** The server sends what changes as it changes (asked for once it said it can), instead of an update per request. */
  private continuous = false
  /** JPEG's quality while the link is fast, and now. */
  private readonly fast: number
  private quality: number
  private readonly adapt: boolean
  private readonly now: () => number
  /** The link's speed (Mbit/s) as updates came, smoothed; 0 before any told it. */
  private mbps = 0
  /** When the bytes being read came, and how many came in all. */
  private at = 0
  private received = 0
  /** The update being read: when its first piece came, and where that piece ended. */
  private started = { at: 0, end: 0 }
  /** The server answers fences (it sent one); the client's pings out, by number, when each went. */
  private fences = false
  private readonly pings = new Map<number, number>()
  private pinged = 0

  constructor(
    private readonly send: (bytes: Uint8Array<ArrayBuffer>) => void,
    private readonly screen: RfbScreen,
    private readonly events: RfbEvents = {},
    options: RfbOptions = {},
  ) {
    this.fast = Math.max(0, Math.min(9, Math.round(options.quality ?? QUALITY)))
    this.quality = this.fast
    this.adapt = options.adapt ?? true
    this.now = options.now ?? (() => performance.now())
  }

  /** Bytes from the server. */
  receive(bytes: Uint8Array): void {
    if (this.state === 'failed') return
    this.at = this.now()
    this.received += bytes.length
    this.pending.push(bytes)
    // A step that fails says so and returns false: nothing after it is read.
    while (this.step()) {}
  }

  /** The mouse at (x, y) on the display with these buttons down (1 left, 2 middle, 4 right, 8/16 the wheel, 32/64 to the side). */
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

  /** JPEG's quality asked for now (0 to 9). */
  get jpegQuality(): number {
    return this.quality
  }

  /** The link's speed as updates came (Mbit/s, smoothed), 0 before any told it. */
  get linkMbps(): number {
    return this.mbps
  }

  /**
   * A ping: a fence of the client's own, which the server answers in its turn, after what it was
   * sending (`pong` then has the round trip). False where the server does no fences (it has not
   * sent one), or before the handshake is through.
   */
  ping(): boolean {
    if (this.state !== 'live' || !this.fences) return false
    const n = ++this.pinged & 0xffff
    this.pings.set(n, this.now())
    // only the last few wait for their answer
    for (const old of this.pings.keys()) if (this.pings.size > 8) this.pings.delete(old)
    this.send(Uint8Array.of(SERVER_FENCE, 0, 0, 0, 0x80, 0, 0, 0, 4, PING, PING, n >> 8, n & 255))
    return true
  }

  /**
   * An update read: the bytes of it that came after its first piece, over the time they took,
   * are the link's speed (the server writes an update all at once). Slow, JPEG at SLOW_QUALITY;
   * fast again, as it was.
   */
  private measure(): void {
    const later = this.received - this.pending.length - this.started.end
    const ms = this.at - this.started.at
    if (later < MEASURED_BYTES || ms <= 0) return
    const mbps = (later * 8) / ms / 1000
    this.mbps = this.mbps ? 0.7 * this.mbps + 0.3 * mbps : mbps
    if (!this.adapt) return
    const q =
      this.mbps < SLOW_MBPS ? Math.min(this.fast, SLOW_QUALITY) : this.mbps > FAST_MBPS ? this.fast : this.quality
    if (q === this.quality) return
    this.quality = q
    this.encodings()
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
    const width = this.pending.u16(0)
    const height = this.pending.u16(2)
    if (width > MAX_SIDE || height > MAX_SIDE) return this.fail('data', `size ${width}x${height}`)
    this.width = width
    this.height = height
    const name = text(this.pending.take(24 + n).subarray(24))
    this.screen.size(this.width, this.height)
    // 32 bits, depth 24, little-endian, true colour, 255 each; red at 0, green 8, blue 16: R G B spare.
    this.send(Uint8Array.of(0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0))
    this.encodings()
    this.request(false)
    this.state = 'live'
    this.step = () => this.message()
    this.events.live?.(name)
    return true
  }

  /** What it reads, the server's choice the first it knows of Tight, Hextile and Raw; and what else it can do. */
  private encodings(): void {
    const list = [
      COPY_RECT,
      TIGHT,
      HEXTILE,
      RAW,
      DESKTOP_SIZE,
      FENCE,
      CONTINUOUS_UPDATES,
      QUALITY_0 + this.quality,
      COMPRESS_0 + COMPRESSION,
    ]
    const bytes = new Uint8Array(4 + 4 * list.length)
    const view = new DataView(bytes.buffer)
    view.setUint8(0, 2)
    view.setUint16(2, list.length)
    for (const [i, e] of list.entries()) view.setInt32(4 + 4 * i, e)
    this.send(bytes)
  }

  private request(incremental: boolean): void {
    const { width: w, height: h } = this
    this.send(Uint8Array.of(3, incremental ? 1 : 0, 0, 0, 0, 0, w >> 8, w & 255, h >> 8, h & 255))
  }

  /** Continuous updates of the whole display (again after it changed size). */
  private enableContinuous(): void {
    const { width: w, height: h } = this
    this.send(Uint8Array.of(ENABLE_CONTINUOUS_UPDATES, 1, 0, 0, 0, 0, w >> 8, w & 255, h >> 8, h & 255))
  }

  private message(): boolean {
    const p = this.pending
    if (p.length < 1) return false
    const type = p.peek(0)
    switch (type) {
      case 0: // FramebufferUpdate
        if (p.length < 4) return false
        this.rects = p.u16(2)
        this.started = { at: this.at, end: this.received }
        p.skip(4)
        // asked for already, while this one comes: the server sends the next as soon as there is one
        if (!this.continuous) this.request(true)
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
      case END_OF_CONTINUOUS_UPDATES:
        p.skip(1)
        // The first says the server can (it answers the encodings so); a later one, that it stopped.
        if (!this.continuous) {
          this.continuous = true
          this.enableContinuous()
        } else {
          this.continuous = false
          this.request(true)
        }
        return true
      case SERVER_FENCE: {
        if (p.length < 9) return false
        const n = p.peek(8)
        if (p.length < 9 + n) return false
        const flags = p.u32(4)
        const fence = p.take(9 + n)
        this.fences = true
        // Answered at once: what came before it is read (and a picture drawn in its order).
        if (flags & FENCE_REQUEST) {
          const answer = new Uint8Array(9 + n)
          answer.set(fence)
          new DataView(answer.buffer).setUint32(4, flags & FENCE_BLOCK)
          this.send(answer)
        } else if (n === 4 && fence[9] === PING && fence[10] === PING) {
          // the answer to a ping
          const k = ((fence[11] as number) << 8) | (fence[12] as number)
          const sent = this.pings.get(k)
          this.pings.delete(k)
          if (sent !== undefined) this.events.pong?.(this.now() - sent)
        }
        return true
      }
      default:
        return this.fail('data', `message ${type}`)
    }
  }

  private rect(): boolean {
    const p = this.pending
    if (this.rects === 0) {
      this.step = () => this.message()
      this.measure()
      this.events.updated?.()
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
        // an empty one has no tiles
        this.step = w > 0 && h > 0 ? this.hextile(x, y, w, h) : () => this.rect()
        return true
      case TIGHT:
        this.step = () => this.tight(x, y, w, h)
        return true
      case DESKTOP_SIZE:
        if (w > MAX_SIDE || h > MAX_SIDE) return this.fail('data', `size ${w}x${h}`)
        this.width = w
        this.height = h
        this.screen.size(w, h)
        // the new size asked for: the request sent as this update came was for the old one
        if (this.continuous) this.enableContinuous()
        else this.request(true)
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
    if (w > 0 && h > 0) this.screen.copy(sx, sy, x, y, w, h)
    this.step = () => this.rect()
    return true
  }

  /** Tight's length of what follows at `at`: 1 to 3 bytes, 7 bits each (the last 8), lowest first. Null: not all here yet. */
  private compact(at: number): { bytes: number; size: number } | null {
    const p = this.pending
    if (p.length < at + 1) return null
    const b0 = p.peek(at)
    if (!(b0 & 0x80)) return { bytes: 1, size: b0 }
    if (p.length < at + 2) return null
    const b1 = p.peek(at + 1)
    if (!(b1 & 0x80)) return { bytes: 2, size: (b0 & 0x7f) | (b1 << 7) }
    if (p.length < at + 3) return null
    return { bytes: 3, size: (b0 & 0x7f) | ((b1 & 0x7f) << 7) | (p.peek(at + 2) << 14) }
  }

  /**
   * Tight, read once all of the rectangle has come: its control byte (the zlib streams it starts
   * again, then what it is: one colour, JPEG, or pixels through a filter and zlib stream 0 to 3),
   * then that.
   */
  private tight(x: number, y: number, w: number, h: number): boolean {
    const p = this.pending
    if (p.length < 1) return false
    const control = p.peek(0)
    const kind = control >> 4
    const resets = () => {
      for (let i = 0; i < 4; i++) if (control & (1 << i)) this.zlib[i]?.reset()
    }
    const done = () => {
      this.step = () => this.rect()
      return true
    }
    if (kind === 8) {
      if (p.length < 4) return false
      resets()
      const c = p.take(4)
      if (w > 0 && h > 0) this.screen.fill(x, y, w, h, c[1] as number, c[2] as number, c[3] as number)
      return done()
    }
    if (kind === 9) {
      const n = this.compact(1)
      if (!n || p.length < 1 + n.bytes + n.size) return false
      resets()
      p.skip(1 + n.bytes)
      this.screen.jpeg(x, y, w, h, p.take(n.size))
      return done()
    }
    if (kind > 9) return this.fail('data', `tight ${kind}`)
    // basic: bits 4 and 5 the stream, bit 6 a filter named
    let at = 1
    let filter = 0
    if (kind & 4) {
      if (p.length < 2) return false
      filter = p.peek(1)
      at = 2
    }
    if (filter > 2) return this.fail('data', `tight filter ${filter}`)
    let colours = 0
    if (filter === 1) {
      if (p.length < at + 1) return false
      colours = p.peek(at) + 1
      at += 1 + 3 * colours
    }
    const size = (colours ? (colours <= 2 ? (w + 7) >> 3 : w) : w * 3) * h
    const n = size < TIGHT_MIN_TO_COMPRESS ? { bytes: 0, size } : this.compact(at)
    if (!n || p.length < at + n.bytes + n.size) return false
    resets()
    const head = p.take(at)
    p.skip(n.bytes)
    let data: Uint8Array | null = p.take(n.size)
    if (size >= TIGHT_MIN_TO_COMPRESS) {
      data = (this.zlib[kind & 3] as Inflater).inflate(data, size)
      if (!data) return this.fail('data', 'tight zlib')
    }
    if (w > 0 && h > 0) {
      const rgba =
        filter === 1
          ? fromPalette(data, head.subarray(at - 3 * colours, at), w, h)
          : filter === 2
            ? fromGradient(data, w, h)
            : fromRgb(data, w * h)
      this.screen.put(x, y, w, h, rgba)
    }
    return done()
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
