// The board's own small VNC client (web/src/models/rfb.ts) against a fake server's bytes: the
// handshake of RFB 3.8 and 3.3 with no password, what it asks for once in (32-bit pixels it can draw
// as they come, Tight first with JPEG, then CopyRect, Hextile, Raw, the display's new size, fences
// and continuous updates), the pictures it draws (Tight's from real captures of Xvnc too), how it
// keeps the updates coming, what it sends for the mouse and the keys, and why it gives up. Then the
// keys and points it sends (web/src/models/desk-input.ts).
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, deflateSync, inflateSync } from 'node:zlib'
import { rfbInputFilter } from '../../src/core/desktop.ts'
import {
  buttonMask,
  InputQueue,
  keysymOf,
  screenPoint,
  textKeysyms,
  WHEEL_DOWN,
  WHEEL_LEFT,
  WHEEL_RIGHT,
  WHEEL_UP,
} from '../../web/src/models/desk-input.ts'
import { DeskMeter } from '../../web/src/models/desk-meter.ts'
import { RfbClient, type RfbFailure, type RfbOptions, type RfbScreen } from '../../web/src/models/rfb.ts'

const ascii = (text: string) => new TextEncoder().encode(text)
const u16 = (n: number) => [n >> 8, n & 255]
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const s32 = (n: number) => u32(n >>> 0)
const bytes = (...parts: (number | number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap(p => (typeof p === 'number' ? [p] : [...p])))

/** The server's hello after the security: the display's size and name (its own pixel format, which the client replaces). */
const serverInit = (w: number, h: number, name: string) =>
  bytes(u16(w), u16(h), [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0], u32(name.length), ascii(name))
const rect = (x: number, y: number, w: number, h: number, encoding: number) =>
  bytes(u16(x), u16(y), u16(w), u16(h), s32(encoding))
const update = (n: number) => bytes(0, 0, u16(n))

/** A fake server: what the client sent, what it drew, and how it ended. */
function world(options: RfbOptions = {}) {
  const sent: number[][] = []
  const drawn: string[] = []
  const failures: RfbFailure[] = []
  const jpegs: Uint8Array[] = []
  /** Each put's pixels, as RGBA. */
  const pixels: number[][] = []
  const pongs: number[] = []
  /** What the display copied, as handed on; how often its server asked for the page's clipboard. */
  const copies: string[] = []
  let wanted = 0
  let live = ''
  let updates = 0
  const screen: RfbScreen = {
    size: (w, h) => drawn.push(`size ${w}x${h}`),
    put: (x, y, w, h, rgba) => {
      drawn.push(`put ${x},${y} ${w}x${h} ${[...rgba.slice(0, 8)].join(' ')}`)
      pixels.push([...rgba])
    },
    copy: (sx, sy, x, y, w, h) => drawn.push(`copy ${sx},${sy} -> ${x},${y} ${w}x${h}`),
    fill: (x, y, w, h, r, g, b) => drawn.push(`fill ${x},${y} ${w}x${h} ${r} ${g} ${b}`),
    jpeg: (x, y, w, h, data) => {
      drawn.push(`jpeg ${x},${y} ${w}x${h} ${data.length}`)
      jpegs.push(Uint8Array.from(data))
    },
  }
  const client = new RfbClient(
    b => sent.push([...b]),
    screen,
    {
      live: name => {
        live = name
      },
      failed: why => failures.push(why),
      updated: () => updates++,
      pong: ms => pongs.push(ms),
      copied: text => copies.push(text),
      clipboardWanted: () => wanted++,
    },
    options,
  )
  return {
    client,
    sent,
    drawn,
    failures,
    jpegs,
    pixels,
    pongs,
    copies,
    wanted: () => wanted,
    live: () => live,
    updates: () => updates,
  }
}

/** A client through the 3.8 handshake to a display named "agent" (4 × 2), what it sent so far taken. */
function connected(options: RfbOptions = {}, w = 4, h = 2) {
  const it = world(options)
  it.client.receive(ascii('RFB 003.008\n'))
  it.client.receive(bytes(1, 1))
  it.client.receive(bytes(u32(0)))
  it.client.receive(serverInit(w, h, 'agent'))
  it.sent.length = 0
  it.drawn.length = 0
  return it
}

describe('the handshake', () => {
  test('RFB 3.8 with no password: its version, None, shared, then the pixels and encodings it draws and the whole screen', () => {
    const w = world()
    w.client.receive(ascii('RFB 003.008\n'))
    expect(w.sent).toEqual([[...ascii('RFB 003.008\n')]])
    // Two types offered: VNC password (2) and None (1); it picks None.
    w.client.receive(bytes(2, 2, 1))
    expect(w.sent[1]).toEqual([1])
    w.client.receive(bytes(u32(0)))
    // ClientInit: shared, so other viewers stay.
    expect(w.sent[2]).toEqual([1])
    expect(w.client.state).toBe('handshake')
    // The server's hello in two pieces, as a socket may cut it.
    const init = serverInit(1280, 800, 'agent desktop')
    w.client.receive(init.slice(0, 10))
    expect(w.sent).toHaveLength(3)
    w.client.receive(init.slice(10))
    expect(w.client.state).toBe('live')
    expect(w.live()).toBe('agent desktop')
    expect(w.drawn).toEqual(['size 1280x800'])
    expect(w.sent.slice(3)).toEqual([
      // SetPixelFormat: 32 bits, depth 24, little-endian, true colour, 255 each, red at 0, green 8, blue 16.
      [0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0],
      // SetEncodings: CopyRect, then Tight, Hextile and Raw, the server's choice the first it has;
      // the display's new size, fences, continuous updates, Tight's JPEG at quality 6, its zlib at 2,
      // the extended clipboard (UTF-8 both ways).
      [2, 0, 0, 10, ...[1, 7, 5, 0, -223, -312, -313, -26, -254, -1063131698].flatMap(s32)],
      // The whole screen, not incremental.
      [3, 0, 0, 0, 0, 0, ...u16(1280), ...u16(800)],
    ])
  })

  test('RFB 3.3: the server names the type itself, and no result follows None', () => {
    const w = world()
    w.client.receive(ascii('RFB 003.003\n'))
    expect(w.sent).toEqual([[...ascii('RFB 003.003\n')]])
    w.client.receive(bytes(u32(1)))
    expect(w.sent[1]).toEqual([1])
    w.client.receive(serverInit(2, 2, 'x'))
    expect(w.client.state).toBe('live')
  })

  test('a newer minor version is answered as 3.8; 3.7 as 3.7, with no result after None', () => {
    const newer = world()
    newer.client.receive(ascii('RFB 003.889\n'))
    expect(newer.sent[0]).toEqual([...ascii('RFB 003.008\n')])
    const seven = world()
    seven.client.receive(ascii('RFB 003.007\n'))
    expect(seven.sent[0]).toEqual([...ascii('RFB 003.007\n')])
    seven.client.receive(bytes(1, 1))
    expect(seven.sent[2]).toEqual([1])
    seven.client.receive(serverInit(2, 2, 'x'))
    expect(seven.client.state).toBe('live')
  })

  test('it gives up: not VNC, a password only, the server’s reason, a failed result', () => {
    const http = world()
    http.client.receive(ascii('HTTP/1.1 404'))
    expect(http.failures).toEqual([{ code: 'protocol', detail: 'HTTP/1.1 404' }])
    expect(http.client.state).toBe('failed')
    // Nothing more is read or sent after.
    http.client.receive(ascii('RFB 003.008\n'))
    expect(http.sent).toEqual([])

    const password = world()
    password.client.receive(ascii('RFB 003.008\n'))
    password.client.receive(bytes(1, 2))
    expect(password.failures).toEqual([{ code: 'security', detail: '2' }])
    expect(password.sent).toHaveLength(1)

    const reason = world()
    reason.client.receive(ascii('RFB 003.008\n'))
    reason.client.receive(bytes(0, u32(9), ascii('too many!')))
    expect(reason.failures).toEqual([{ code: 'refused', detail: 'too many!' }])

    const result = world()
    result.client.receive(ascii('RFB 003.008\n'))
    result.client.receive(bytes(1, 1))
    result.client.receive(bytes(u32(1), u32(4), ascii('nope')))
    expect(result.failures).toEqual([{ code: 'refused', detail: 'nope' }])
  })
})

describe('pictures', () => {
  test('Raw: its pixels as they come, made opaque; the next update asked for (incremental) as soon as this one starts to come', () => {
    const w = connected()
    const px = [10, 20, 30, 0, 40, 50, 60, 0]
    w.client.receive(update(1))
    // asked for before the rest of this one has come: no round trip between the two
    expect(w.sent).toEqual([[3, 1, 0, 0, 0, 0, ...u16(4), ...u16(2)]])
    w.client.receive(bytes(rect(1, 1, 2, 1, 0), px))
    expect(w.drawn).toEqual(['put 1,1 2x1 10 20 30 255 40 50 60 255'])
    expect(w.sent).toHaveLength(1)
    expect(w.updates()).toBe(1)
  })

  test('a rectangle cut across messages waits for the rest; two in one update', () => {
    const w = connected()
    const all = bytes(update(2), rect(0, 0, 1, 1, 0), [1, 2, 3, 0], rect(0, 0, 2, 1, 1), u16(2), u16(1))
    for (const b of all) w.client.receive(bytes(b))
    expect(w.drawn).toEqual(['put 0,0 1x1 1 2 3 255', 'copy 2,1 -> 0,0 2x1'])
    expect(w.sent).toHaveLength(1)
  })

  test('Hextile: a background, a foreground subrect and a coloured one, then a raw tile', () => {
    const w = connected()
    const bg = [9, 9, 9, 0]
    const fg = [1, 1, 1, 0]
    // 18 × 1: a 16 × 1 tile and a 2 × 1 one.
    const first = bytes(2 | 4 | 8, bg, fg, 1, 0x10, 0x00) // bg, fg, one plain subrect at (1,0) 1 × 1
    const second = bytes(1, [5, 5, 5, 0, 6, 6, 6, 0]) // raw
    w.client.receive(bytes(update(1), rect(0, 0, 18, 1, 5), first, second))
    expect(w.drawn).toEqual(['put 0,0 16x1 9 9 9 255 1 1 1 255', 'put 16,0 2x1 5 5 5 255 6 6 6 255'])
    // Coloured subrects; the next tile keeps the background and has none.
    w.drawn.length = 0
    const coloured = bytes(2 | 8 | 16, bg, 1, [7, 7, 7, 0], 0x00, 0x00)
    w.client.receive(bytes(update(1), rect(0, 0, 17, 1, 5), coloured, 0))
    expect(w.drawn).toEqual(['put 0,0 16x1 7 7 7 255 9 9 9 255', 'put 16,0 1x1 9 9 9 255'])
  })

  test('the display’s new size, bell, cut text and colour map are taken without a picture', () => {
    const w = connected()
    w.client.receive(bytes(update(1), rect(0, 0, 8, 6, -223)))
    expect(w.drawn).toEqual(['size 8x6'])
    // the request that went as the update came was for the old size: the new one asked for too
    expect(w.sent).toEqual([
      [3, 1, 0, 0, 0, 0, ...u16(4), ...u16(2)],
      [3, 1, 0, 0, 0, 0, ...u16(8), ...u16(6)],
    ])
    w.client.receive(bytes(2, 3, 0, 0, 0, u32(2), ascii('hi'), 1, 0, u16(0), u16(1), [0, 0, 0, 0, 0, 0]))
    expect(w.client.state).toBe('live')
  })

  test('an encoding it did not ask for, or an unknown message: it stops', () => {
    const w = connected()
    w.client.receive(bytes(update(1), rect(0, 0, 1, 1, 16)))
    expect(w.failures).toEqual([{ code: 'data', detail: 'encoding 16' }])
    const m = connected()
    m.client.receive(bytes(99))
    expect(m.failures).toEqual([{ code: 'data', detail: 'message 99' }])
  })
  test('an empty rectangle draws nothing and reads on; a display past 8192 on a side stops it', () => {
    const w = connected()
    w.client.receive(bytes(update(3), rect(0, 0, 0, 16, 5), rect(0, 0, 16, 0, 0), rect(1, 1, 0, 2, 1), u16(0), u16(0)))
    expect(w.drawn).toEqual([])
    expect(w.client.state).toBe('live')
    expect(w.sent).toHaveLength(1)
    const big = connected()
    big.client.receive(bytes(update(1), rect(0, 0, 0xffff, 0xffff, -223)))
    expect(big.drawn).toEqual([])
    expect(big.failures).toEqual([{ code: 'data', detail: 'size 65535x65535' }])
    const init = world()
    init.client.receive(ascii('RFB 003.008\n'))
    init.client.receive(bytes(1, 1))
    init.client.receive(bytes(u32(0)))
    init.client.receive(serverInit(9000, 2, 'agent'))
    expect(init.failures).toEqual([{ code: 'data', detail: 'size 9000x2' }])
  })
})

/** A zlib stream's first part, flushed as Tight sends one. */
const zlibPart = (data: number[]) => [...deflateSync(Uint8Array.from(data), { finishFlush: constants.Z_SYNC_FLUSH })]
/** Tight's length of what follows: 1 to 3 bytes, 7 bits each, lowest first. */
const compact = (n: number) =>
  n < 128 ? [n] : n < 16384 ? [(n & 127) | 128, n >> 7] : [(n & 127) | 128, ((n >> 7) & 127) | 128, n >> 14]
/** RGBA of these R G B colours. */
const rgba = (...colours: number[][]) => colours.flatMap(c => [...c, 255])
const TIGHT = 7

describe('Tight', () => {
  test('one colour: a fill; JPEG: its bytes to the screen whole, at any length', () => {
    const w = connected()
    const jpeg = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 255)
    w.client.receive(
      bytes(
        update(4),
        rect(1, 0, 3, 2, TIGHT),
        0x80,
        [10, 20, 30],
        // lengths of one, two and three bytes
        rect(0, 0, 2, 2, TIGHT),
        0x90,
        compact(5),
        jpeg(5),
        rect(0, 0, 2, 2, TIGHT),
        0x90,
        compact(200),
        jpeg(200),
        rect(0, 0, 4, 2, TIGHT),
        0x90,
        compact(20_000),
        jpeg(20_000),
      ),
    )
    expect(w.drawn).toEqual(['fill 1,0 3x2 10 20 30', 'jpeg 0,0 2x2 5', 'jpeg 0,0 2x2 200', 'jpeg 0,0 4x2 20000'])
    expect(w.jpegs[2]).toEqual(jpeg(20_000))
    expect(w.updates()).toBe(1)
  })

  test('under 12 bytes the pixels come as they are: three bytes each, or a palette’s indices', () => {
    const w = connected()
    // 3 × 1, no filter named: R G B each
    w.client.receive(bytes(update(2), rect(0, 0, 3, 1, TIGHT), 0x00, [1, 2, 3, 4, 5, 6, 7, 8, 9]))
    // 2 × 2, a palette of three (stream 2, filter named): an index a byte
    w.client.receive(bytes(rect(0, 0, 2, 2, TIGHT), 0x60, 1, 2, [9, 9, 9, 0, 0, 0, 200, 100, 50], [2, 1, 0, 2]))
    expect(w.pixels).toEqual([
      rgba([1, 2, 3], [4, 5, 6], [7, 8, 9]),
      rgba([200, 100, 50], [0, 0, 0], [9, 9, 9], [200, 100, 50]),
    ])
  })

  test('a palette through zlib (stream 2): an index a byte; two colours (stream 1): a bit each, rows to the byte', () => {
    const w = connected()
    const indices = [0, 1, 2, 3, 3, 2, 1, 0, 0, 0, 1, 1, 2, 2, 3, 3]
    const four = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]
    // 10 × 6 in two colours: two bytes a row, the first pixel the highest bit
    const bits = [0b1000_0000, 0b0100_0000, 0, 0, 0xff, 0xc0, 0, 0, 0, 0, 0b0101_0101, 0]
    w.client.receive(
      bytes(
        update(2),
        rect(0, 0, 4, 4, TIGHT),
        0x60,
        1,
        3,
        four,
        compact(zlibPart(indices).length),
        zlibPart(indices),
        rect(0, 0, 10, 6, TIGHT),
        0x50,
        1,
        1,
        [255, 255, 255, 16, 48, 112],
        compact(zlibPart(bits).length),
        zlibPart(bits),
      ),
    )
    expect(w.failures).toEqual([])
    const colour = (i: number) => four.slice(i * 3, i * 3 + 3)
    expect(w.pixels[0]).toEqual(rgba(...indices.map(colour)))
    const [white, blue] = [
      [255, 255, 255],
      [16, 48, 112],
    ]
    const row = (pattern: string) => [...pattern].map(c => (c === '1' ? blue : white)) as number[][]
    expect(w.pixels[1]).toEqual(
      rgba(
        ...row('1000000001'),
        ...row('0000000000'),
        ...row('1111111111'),
        ...row('0000000000'),
        ...row('0000000000'),
        ...row('0101010100'),
      ),
    )
  })

  test('the gradient filter: each colour the difference from left + above − above left', () => {
    const w = connected()
    const want = [
      [10, 200, 30],
      [20, 190, 60],
      [40, 100, 255],
      [5, 0, 128],
    ]
    // 2 × 2: what is sent is each colour less its guess (0 off the picture), within a byte
    const at = (i: number, c: number) => want[i]?.[c] ?? 0
    const guess = (i: number, c: number) => {
      const left = i % 2 ? at(i - 1, c) : 0
      const up = i >= 2 ? at(i - 2, c) : 0
      const upLeft = i === 3 ? at(0, c) : 0
      return Math.max(0, Math.min(255, left + up - upLeft))
    }
    const sent = want.flatMap((p, i) => p.map((v, c) => (v - guess(i, c)) & 255))
    w.client.receive(bytes(update(1), rect(0, 0, 2, 2, TIGHT), 0x40, 2, compact(zlibPart(sent).length), zlibPart(sent)))
    expect(w.pixels).toEqual([rgba(...want)])
  })

  test('a stream’s reset bit starts it again; without it a new stream’s bytes are not that stream: it stops', () => {
    const w = connected()
    const indices = Array.from({ length: 16 }, (_, i) => i % 3)
    const part = zlibPart(indices)
    const tight = (control: number) =>
      bytes(rect(0, 0, 4, 4, TIGHT), control, 1, 2, [1, 1, 1, 2, 2, 2, 3, 3, 3], compact(part.length), part)
    // stream 1 begun, then begun again with its reset bit (2): both read
    w.client.receive(bytes(update(2), tight(0x50), tight(0x50 | 0b0010)))
    expect(w.pixels).toHaveLength(2)
    expect(w.pixels[1]).toEqual(w.pixels[0] as number[])
    // the same again with no reset: not the stream's next part
    w.client.receive(bytes(update(1), tight(0x50)))
    expect(w.failures).toEqual([{ code: 'data', detail: 'tight zlib' }])
  })

  test('a rectangle cut anywhere waits for the rest', () => {
    const indices = Array.from({ length: 64 }, (_, i) => (i >> 2) % 4)
    const all = bytes(
      update(3),
      rect(0, 0, 8, 8, TIGHT),
      0x60,
      1,
      3,
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      compact(zlibPart(indices).length),
      zlibPart(indices),
      rect(1, 1, 2, 1, TIGHT),
      0x80,
      [7, 7, 7],
      rect(0, 0, 3, 3, TIGHT),
      0x90,
      compact(300),
      new Uint8Array(300),
    )
    const whole = connected()
    whole.client.receive(all)
    const cut = connected()
    for (const b of all) cut.client.receive(bytes(b))
    expect(cut.drawn).toEqual(whole.drawn)
    expect(cut.pixels).toEqual(whole.pixels)
    expect(cut.drawn).toHaveLength(3)
  })

  test('what it cannot read on from (PNG, an unknown filter, broken zlib): it stops', () => {
    const png = connected()
    png.client.receive(bytes(update(1), rect(0, 0, 1, 1, TIGHT), 0xa0, 1, 0))
    expect(png.failures).toEqual([{ code: 'data', detail: 'tight 10' }])
    const filter = connected()
    filter.client.receive(bytes(update(1), rect(0, 0, 1, 1, TIGHT), 0x40, 3))
    expect(filter.failures).toEqual([{ code: 'data', detail: 'tight filter 3' }])
    const broken = connected()
    broken.client.receive(bytes(update(1), rect(0, 0, 4, 1, TIGHT), 0x00, compact(4), [0x78, 0x9c, 0xff, 0xff]))
    expect(broken.failures).toEqual([{ code: 'data', detail: 'tight zlib' }])
  })
})

/**
 * What Xvnc (TigerVNC 1.12) sent for part of its screen, recorded after the handshake (32-bit
 * pixels as this client asks): `tight-lossless.bin` a page scrolled (Tight, no JPEG, 8 updates);
 * `tight-mono.bin` two colours; `tight-jpeg.bin` a photo and its caption (JPEG at 6). With each, the
 * SHA-256 of what Xvnc sent as Raw for the same screen.
 */
const capture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, '../fixtures/vnc', name)))

/** The client on Xvnc's 1440 × 900 screen, drawn into a picture of its own. */
function xvnc() {
  const W = 1440
  const fb = new Uint8ClampedArray(W * 900 * 4)
  const drawn: string[] = []
  let updates = 0
  const screen: RfbScreen = {
    size() {},
    put(x, y, w, h, rgba) {
      for (let r = 0; r < h; r++) fb.set(rgba.subarray(r * w * 4, (r + 1) * w * 4), ((y + r) * W + x) * 4)
      drawn.push(`put ${x},${y} ${w}x${h}`)
    },
    copy() {
      throw new Error('no CopyRect in these captures')
    },
    fill(x, y, w, h, r, g, b) {
      for (let row = y; row < y + h; row++)
        for (let col = x; col < x + w; col++) fb.set([r, g, b, 255], (row * W + col) * 4)
      drawn.push(`fill ${x},${y} ${w}x${h}`)
    },
    jpeg(x, y, w, h, data) {
      // whole: from its start (FF D8) to its end (FF D9)
      const whole = data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9
      drawn.push(`jpeg ${x},${y} ${w}x${h} ${data.length}${whole ? '' : ' broken'}`)
    },
  }
  const failures: RfbFailure[] = []
  const client = new RfbClient(() => {}, screen, { failed: f => failures.push(f), updated: () => updates++ })
  client.receive(ascii('RFB 003.008\n'))
  client.receive(bytes(1, 1))
  client.receive(bytes(u32(0)))
  client.receive(serverInit(W, 900, 'agent'))
  /** The SHA-256 of a part of the picture, its rows one after another. */
  const sha = (x: number, y: number, w: number, h: number) => {
    const hash = createHash('sha256')
    for (let r = 0; r < h; r++) hash.update(fb.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + w) * 4))
    return hash.digest('hex')
  }
  return { client, drawn, failures, sha, updates: () => updates }
}

describe('Tight from Xvnc (captured)', () => {
  test('a page scrolled, no JPEG: zlib streams 0 and 2 going on through 8 updates end on exactly Xvnc’s Raw pixels', () => {
    const x = xvnc()
    const data = capture('tight-lossless.bin')
    // in pieces as a socket cuts them
    for (let at = 0; at < data.length; at += 1000) x.client.receive(data.subarray(at, at + 1000))
    expect(x.failures).toEqual([])
    expect(x.updates()).toBe(8)
    expect(x.drawn.filter(d => d.startsWith('fill'))).toHaveLength(3)
    expect(x.sha(240, 590, 160, 100)).toBe('20e9cba5b4fbff853e53a28abb9d79efd81e8d12ef268902f0f05afffcbb0240')
  })

  test('two colours (stream 1): exactly Xvnc’s Raw pixels', () => {
    const x = xvnc()
    x.client.receive(capture('tight-mono.bin'))
    expect(x.drawn).toEqual(['put 90,330 120x60'])
    expect(x.sha(90, 330, 120, 60)).toBe('b99247489691a0c61c59654d19379fcc9d03c54ca0b4837adb2f68b83ad78ee2')
  })

  test('JPEG at 6: the photo’s parts to the screen as JPEG, each whole; the text beside them as a palette', () => {
    const x = xvnc()
    x.client.receive(capture('tight-jpeg.bin'))
    expect(x.failures).toEqual([])
    expect(x.drawn).toEqual([
      'jpeg 240,560 200x72 4148',
      'jpeg 240,632 76x16 927',
      'jpeg 325,632 115x16 1186',
      'jpeg 240,648 200x32 3207',
      'put 316,632 9x16',
    ])
  })
})

describe('updates as they come (Xvnc’s continuous updates and fences)', () => {
  test('its opening answered: its fence, then continuous updates of the whole display; then none asked for', () => {
    const w = connected()
    // a fence asking for an answer (1 << 31, one byte of its own), then: it can send continuous updates
    for (const b of bytes(248, 0, 0, 0, u32(0x80000000), 1, 0, 150)) w.client.receive(bytes(b))
    expect(w.sent).toEqual([
      // the same back, not asking
      [248, 0, 0, 0, ...u32(0), 1, 0],
      // continuous updates of all of it
      [150, 1, 0, 0, 0, 0, ...u16(4), ...u16(2)],
    ])
    w.sent.length = 0
    w.client.receive(bytes(update(1), rect(0, 0, 1, 1, 0), [1, 2, 3, 0]))
    w.client.receive(bytes(update(1), rect(1, 0, 1, 1, 0), [4, 5, 6, 0]))
    expect(w.drawn).toHaveLength(2)
    expect(w.updates()).toBe(2)
    expect(w.sent).toEqual([])
  })

  test('its round trips answered at once: the blocking flags kept, SyncNext (not done here) left out; an answer gets none', () => {
    const w = connected()
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000001), 1, 1))
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000007), 2, 5, 6))
    w.client.receive(bytes(248, 0, 0, 0, u32(1), 0))
    expect(w.sent).toEqual([
      [248, 0, 0, 0, ...u32(1), 1, 1],
      [248, 0, 0, 0, ...u32(3), 2, 5, 6],
    ])
  })

  test('a new size: continuous updates of all of it; the server stopping them: asked for again', () => {
    const w = connected()
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000000), 0, 150))
    w.sent.length = 0
    w.client.receive(bytes(update(1), rect(0, 0, 8, 6, -223)))
    expect(w.sent).toEqual([[150, 1, 0, 0, 0, 0, ...u16(8), ...u16(6)]])
    w.sent.length = 0
    w.client.receive(bytes(150))
    expect(w.sent).toEqual([[3, 1, 0, 0, 0, 0, ...u16(8), ...u16(6)]])
    w.client.receive(update(0))
    expect(w.sent).toHaveLength(2)
  })

  test('all it sends for the picture goes through the board’s bridge while the owner only watches', () => {
    let t = 0
    const w = world({ now: () => t })
    w.client.receive(ascii('RFB 003.008\n'))
    w.client.receive(bytes(1, 1))
    w.client.receive(bytes(u32(0)))
    w.client.receive(serverInit(200, 200, 'agent'))
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000000), 1, 0, 150))
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000001), 1, 1))
    // a slow update: the quality asked for again
    const pixels = new Uint8Array(160 * 160 * 4)
    w.client.receive(bytes(update(1), rect(0, 0, 160, 160, 0), pixels.subarray(0, 100)))
    t = 1000
    w.client.receive(pixels.subarray(100))
    w.client.receive(bytes(update(1), rect(0, 0, 300, 300, -223)))
    expect(w.client.ping()).toBe(true)
    expect(w.sent.map(m => m[0])).toEqual([...ascii('R'), 1, 1, 0, 2, 3, 248, 150, 248, 2, 150, 248])
    const all = Uint8Array.from(w.sent.flat())
    expect([...(rfbInputFilter()(all, false) ?? [])]).toEqual([...all])
  })
})

describe('while the picture comes as video (pictures: false)', () => {
  test('through the handshake no picture is asked for; the server able to send continuous updates is not asked to; its fences answered, pings and input go', () => {
    const clock = { t: 0 }
    const w = world({ pictures: false, now: () => clock.t })
    w.client.receive(ascii('RFB 003.008\n'))
    w.client.receive(bytes(1, 1))
    w.client.receive(bytes(u32(0)))
    w.client.receive(serverInit(1440, 900, 'agent'))
    expect(w.client.state).toBe('live')
    // its pixel format and encodings (fences, continuous updates among them), no update request
    expect(w.sent.slice(3).map(m => m[0])).toEqual([0, 2])
    w.sent.length = 0
    // its fence and its word that it can send continuous updates: the fence answered, nothing asked
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000000), 1, 0, 150))
    expect(w.sent).toEqual([[248, 0, 0, 0, ...u32(0), 1, 0]])
    w.sent.length = 0
    expect(w.client.ping()).toBe(true)
    w.client.pointer(10, 20, 1)
    w.client.key(0x61, true)
    expect(w.sent.map(m => m[0])).toEqual([248, 5, 4])
    clock.t = 131
    w.client.receive(bytes(248, 0, 0, 0, u32(0), 4, 0x70, 0x70, 0, 1))
    expect(w.pongs).toEqual([131])
    // an update the server sent anyway (one asked for before): drawn, and no next one asked for
    w.sent.length = 0
    w.client.receive(bytes(update(1), rect(0, 0, 1, 1, 0), [1, 2, 3, 0]))
    expect(w.sent).toEqual([])
  })

  test('watch(): the video gone, the whole picture asked for, then continuous updates; before the handshake is through, asked for then', () => {
    const w = connected({ pictures: false }, 4, 2)
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000000), 1, 0, 150))
    w.sent.length = 0
    w.client.watch()
    expect(w.sent).toEqual([
      [3, 0, 0, 0, 0, 0, ...u16(4), ...u16(2)],
      [150, 1, 0, 0, 0, 0, ...u16(4), ...u16(2)],
    ])
    // again: nothing more
    w.client.watch()
    expect(w.sent).toHaveLength(2)
    // a server without continuous updates: the whole picture, then an update asked for as each comes
    const plain = connected({ pictures: false }, 4, 2)
    plain.client.watch()
    expect(plain.sent).toEqual([[3, 0, 0, 0, 0, 0, ...u16(4), ...u16(2)]])
    plain.client.receive(bytes(update(1), rect(0, 0, 1, 1, 0), [1, 2, 3, 0]))
    expect(plain.sent.at(-1)).toEqual([3, 1, 0, 0, 0, 0, ...u16(4), ...u16(2)])
    // watched before it was live: the handshake asks for it as always
    const early = world({ pictures: false })
    early.client.watch()
    early.client.receive(ascii('RFB 003.008\n'))
    early.client.receive(bytes(1, 1))
    early.client.receive(bytes(u32(0)))
    early.client.receive(serverInit(4, 2, 'agent'))
    expect(early.sent.at(-1)).toEqual([3, 0, 0, 0, 0, 0, ...u16(4), ...u16(2)])
  })
})

describe('the link’s speed', () => {
  /** An update of 100 KB of Raw, its first 1000 bytes at `from` ms, the rest at `to`. */
  const slowly = (w: ReturnType<typeof connected>, clock: { t: number }, from: number, to: number) => {
    const all = bytes(update(1), rect(0, 0, 160, 160, 0), new Uint8Array(160 * 160 * 4))
    clock.t = from
    w.client.receive(all.subarray(0, 1000))
    clock.t = to
    w.client.receive(all.subarray(1000))
  }
  const qualityAsked = (w: ReturnType<typeof connected>) =>
    w.sent
      .filter(m => m[0] === 2)
      .map(m => (new DataView(Uint8Array.from(m).buffer).getInt32(4 + 7 * 4) as number) + 32)

  test('updates coming slowly: JPEG at 4; coming fast again: at 6 again', () => {
    const clock = { t: 0 }
    const w = connected({ now: () => clock.t }, 200, 200)
    // 100 KB over a second: 0.8 Mbit/s
    slowly(w, clock, 0, 1000)
    expect(qualityAsked(w)).toEqual([4])
    // still slow: asked for no more
    slowly(w, clock, 2000, 3000)
    expect(qualityAsked(w)).toEqual([4])
    // over 10 ms: 80 Mbit/s, fast enough on its own (smoothed with the slow ones)
    slowly(w, clock, 4000, 4010)
    expect(qualityAsked(w)).toEqual([4, 6])
  })

  test('an update in one piece, or a small one, says nothing of the link; and none of this when asked not to', () => {
    const clock = { t: 0 }
    const w = connected({ now: () => clock.t }, 200, 200)
    w.client.receive(bytes(update(1), rect(0, 0, 160, 160, 0), new Uint8Array(160 * 160 * 4)))
    clock.t = 5000
    w.client.receive(bytes(update(1), rect(0, 0, 10, 10, 0)))
    clock.t = 9000
    w.client.receive(new Uint8Array(400))
    expect(qualityAsked(w)).toEqual([])
    const fixed = connected({ now: () => clock.t, adapt: false }, 200, 200)
    slowly(fixed, clock, 0, 1000)
    expect(qualityAsked(fixed)).toEqual([])
    const sharp = connected({ now: () => clock.t, quality: 8 }, 200, 200)
    slowly(sharp, clock, 0, 1000)
    expect(qualityAsked(sharp)).toEqual([4])
  })
})

describe('the round trip (pings)', () => {
  test('none before the server has sent a fence; then a fence of its own, whose answer is the round trip', () => {
    const clock = { t: 0 }
    const w = world({ now: () => clock.t })
    w.client.receive(ascii('RFB 003.008\n'))
    expect(w.client.ping()).toBe(false)
    const c = connected({ now: () => clock.t })
    // live, but the server has not said it does fences
    expect(c.client.ping()).toBe(false)
    c.client.receive(bytes(248, 0, 0, 0, u32(0x80000000), 1, 0))
    c.sent.length = 0
    clock.t = 1000
    expect(c.client.ping()).toBe(true)
    // asking for an answer, four bytes: "pp" and its number
    expect(c.sent).toEqual([[248, 0, 0, 0, ...u32(0x80000000), 4, 0x70, 0x70, 0, 1]])
    clock.t = 1042
    // the server's answer: the same, not asking
    c.client.receive(bytes(248, 0, 0, 0, u32(0), 4, 0x70, 0x70, 0, 1))
    expect(c.pongs).toEqual([42])
    // an answer to no ping of its own, or the same again: nothing
    c.client.receive(bytes(248, 0, 0, 0, u32(0), 4, 0x70, 0x70, 0, 9))
    c.client.receive(bytes(248, 0, 0, 0, u32(0), 4, 0x70, 0x70, 0, 1))
    expect(c.pongs).toEqual([42])
    expect(c.sent).toHaveLength(1)
    expect(c.client.jpegQuality).toBe(6)
  })
})

describe('the link’s meter', () => {
  test('the corner: the round trip (the median of the last five), the last second’s frames, what the picture comes by', () => {
    const m = new DeskMeter()
    // not known yet (the video tried first): no word for it
    expect(m.text(null, 6)).toBe('– ms · 0 fps')
    expect(m.text('vnc', 6)).toBe('– ms · 0 fps · vnc q6')
    for (const ms of [40, 300, 44, 41, 43]) m.pong(ms)
    for (let i = 0; i < 12; i++) m.frame()
    m.second()
    expect(m.text('vnc', 4)).toBe('43 ms · 12 fps · vnc q4')
    // video: no JPEG quality to say
    expect(m.text('h264', 4)).toBe('43 ms · 12 fps · h264')
    // only the last five count: the slow one gone
    m.pong(50)
    expect(m.rtt()).toBe(44)
    m.second()
    expect(m.fps).toBe(0)
  })

  test('a line a minute for the board’s log: the round trip’s median, the frames’ median while there were any; none for a still minute', () => {
    const m = new DeskMeter()
    for (const ms of [30, 35, 33, 90]) m.pong(ms)
    for (const n of [10, 0, 20, 30]) {
      for (let i = 0; i < n; i++) m.frame()
      m.second()
    }
    expect(m.minute({ key: 'a b', via: 'vnc', quality: 6, mbps: 14.26 })).toBe(
      'browser view a b: rtt median 34 ms (min 30, max 90, 4 pings), fps median 20 (max 30, 3 s with frames), vnc JPEG q6, link 14.3 Mbit/s',
    )
    // the next minute starts empty: nothing in it, no line
    m.second()
    expect(m.minute({ key: 'a b', via: 'vnc', quality: 6, mbps: 0 })).toBeNull()
  })

  test('a minute of video: its frames and its bytes over the minute (Mbit/s), no JPEG', () => {
    const m = new DeskMeter()
    m.pong(131)
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 30; i++) m.frame()
      m.second()
    }
    m.bytes(15_000_000)
    m.bytes(7_500_000)
    expect(m.minute({ key: 'k', via: 'h264', quality: 6, mbps: 0 })).toBe(
      'browser view k: rtt median 131 ms (min 131, max 131, 1 pings), fps median 30 (max 30, 3 s with frames), h264 3.0 Mbit/s',
    )
    // the bytes are the minute's: the next one counts from nothing
    m.frame()
    m.second()
    expect(m.minute({ key: 'k', via: 'h264', quality: 6, mbps: 0 })).toContain('h264 0.0 Mbit/s')
  })
})

describe('input a frame at a time', () => {
  /** A queue whose frame comes when the test says, and what it sent. */
  function queue() {
    const sent: string[] = []
    const frames: (() => void)[] = []
    const q = new InputQueue(
      { pointer: (x, y, m) => sent.push(`p ${x},${y} ${m}`), key: (k, d) => sent.push(`k ${k} ${d ? 'down' : 'up'}`) },
      fn => frames.push(fn),
    )
    const frame = () => {
      for (const fn of frames.splice(0)) fn()
    }
    return { q, sent, frame }
  }

  test('moves wait for the frame, and only the last goes; a press, a let go and a key go at once, after what waits', () => {
    const { q, sent, frame } = queue()
    q.pointer(1, 1, 0)
    q.pointer(2, 2, 0)
    q.pointer(3, 3, 0)
    expect(sent).toEqual([])
    frame()
    expect(sent).toEqual(['p 3,3 0'])
    // a drag: the press at once, its moves a frame at a time, the let go at once after the last move
    q.pointer(3, 3, 1)
    q.pointer(4, 4, 1)
    q.pointer(5, 5, 1)
    q.pointer(5, 5, 0)
    q.key(0x61, true)
    q.key(0x61, false)
    expect(sent.slice(1)).toEqual(['p 3,3 1', 'p 5,5 1', 'p 5,5 0', 'k 97 down', 'k 97 up'])
    // nothing waits: the frame sends nothing more
    frame()
    expect(sent).toHaveLength(6)
  })

  test('wheel steps at a place are summed (up and down too); a move between them keeps its place in the order', () => {
    const { q, sent, frame } = queue()
    q.wheel(5, 5, 0, WHEEL_DOWN)
    q.wheel(5, 5, 0, WHEEL_DOWN)
    q.wheel(5, 5, 0, WHEEL_UP)
    q.wheel(5, 5, 0, WHEEL_DOWN)
    q.wheel(5, 5, 0, WHEEL_RIGHT)
    q.pointer(6, 6, 0)
    q.wheel(6, 6, 0, WHEEL_LEFT)
    expect(sent).toEqual([])
    frame()
    expect(sent).toEqual([
      ...['p 5,5 16', 'p 5,5 0', 'p 5,5 16', 'p 5,5 0'],
      ...['p 5,5 64', 'p 5,5 0'],
      'p 6,6 0',
      ...['p 6,6 32', 'p 6,6 0'],
    ])
    // with a button held, the steps keep it
    q.pointer(6, 6, 1)
    q.wheel(6, 6, 1, WHEEL_UP)
    q.flush()
    expect(sent.slice(-3)).toEqual(['p 6,6 1', 'p 6,6 9', 'p 6,6 1'])
  })
})

describe('the mouse and the keys', () => {
  test('a pointer event and a key event as RFB has them, within the screen', () => {
    const w = connected()
    w.client.pointer(3, 1, 1)
    w.client.pointer(99, -5, 0)
    w.client.key(0xff0d, true)
    w.client.key(0x61, false)
    expect(w.sent).toEqual([
      [5, 1, 0, 3, 0, 1],
      [5, 0, 0, 3, 0, 0],
      [4, 1, 0, 0, ...u32(0xff0d)],
      [4, 0, 0, 0, ...u32(0x61)],
    ])
  })

  test('nothing is sent before the handshake is through', () => {
    const w = world()
    w.client.receive(ascii('RFB 003.008\n'))
    w.client.pointer(1, 1, 1)
    w.client.key(0x61, true)
    expect(w.sent).toHaveLength(1)
  })
})

describe('desk input', () => {
  test('keys: printable characters as Latin-1 or Unicode keysyms, named keys, sides by the code', () => {
    expect(keysymOf('a', 'KeyA')).toBe(0x61)
    expect(keysymOf('A', 'KeyA')).toBe(0x41)
    expect(keysymOf('é', 'Quote')).toBe(0xe9)
    expect(keysymOf('ж', 'Semicolon')).toBe(0x01000436)
    expect(keysymOf(' ', 'Space')).toBe(0x20)
    expect(keysymOf('Enter', 'Enter')).toBe(0xff0d)
    expect(keysymOf('Backspace', 'Backspace')).toBe(0xff08)
    expect(keysymOf('ArrowLeft', 'ArrowLeft')).toBe(0xff51)
    expect(keysymOf('F5', 'F5')).toBe(0xffc2)
    expect(keysymOf('Shift', 'ShiftLeft')).toBe(0xffe1)
    expect(keysymOf('Shift', 'ShiftRight')).toBe(0xffe2)
    expect(keysymOf('Control', 'ControlRight')).toBe(0xffe4)
    expect(keysymOf('Dead', 'Quote')).toBeNull()
    expect(keysymOf('Unidentified', '')).toBeNull()
  })

  test('pasted text typed as keys: lines as Return, Windows line ends once', () => {
    expect(textKeysyms('a\r\nБ\t')).toEqual([0x61, 0xff0d, 0x01000411, 0xff09])
  })

  test('a point on the picture as the display has it, the picture fitted and centred', () => {
    // 1000 × 500 shown in a 500 × 500 box: half size, 125 px bands above and below.
    const box = { left: 10, top: 20, width: 500, height: 500 }
    expect(screenPoint(box, 1000, 500, 10, 145)).toEqual({ x: 0, y: 0 })
    expect(screenPoint(box, 1000, 500, 260, 270)).toEqual({ x: 500, y: 250 })
    expect(screenPoint(box, 1000, 500, 600, 900)).toEqual({ x: 999, y: 499 })
    expect(screenPoint(box, 0, 0, 1, 1)).toBeNull()
  })

  test('buttons: the page’s left, right and middle as VNC’s 1, 3 and 2', () => {
    expect(buttonMask(1)).toBe(1)
    expect(buttonMask(2)).toBe(4)
    expect(buttonMask(4)).toBe(2)
    expect(buttonMask(7)).toBe(7)
  })
})

describe('the clipboard', () => {
  const CAPS = 1 << 24
  const REQUEST = 1 << 25
  const PEEK = 1 << 26
  const NOTIFY = 1 << 27
  const PROVIDE = 1 << 28
  const TEXT = 1
  /** The server's extended cut text: its flags and what follows them. */
  const serverClip = (flags: number, ...body: (number[] | Uint8Array)[]) => {
    const rest = bytes(...body)
    return bytes(3, 0, 0, 0, s32(-(4 + rest.length)), u32(flags), rest)
  }
  /** The text a provide carries: its zlib stream of the length, the bytes. */
  const provided = (text: string) => {
    const raw = ascii(text)
    return deflateSync(bytes(u32(raw.length), raw))
  }
  /** A client's extended cut text read back: its flags and its body. */
  const clientClip = (m: number[]) => {
    expect(m.slice(0, 4)).toEqual([6, 0, 0, 0])
    const view = new DataView(Uint8Array.from(m).buffer)
    expect(-view.getInt32(4)).toBe(m.length - 8)
    return { flags: view.getUint32(8), body: Uint8Array.from(m.slice(12)) }
  }
  /** Connected to a server that does the extended clipboard (its caps answered), what was sent taken. */
  const extended = () => {
    const w = connected()
    w.client.receive(serverClip(CAPS | TEXT | REQUEST | PEEK | NOTIFY | PROVIDE, u32(10 << 20)))
    w.sent.length = 0
    return w
  }

  test('a server with the extended clipboard: the client answers with what it can (text, up to 256 KB, every action); without it, plain', () => {
    const w = connected()
    expect(w.client.clipboard).toBe(false)
    w.client.receive(serverClip(CAPS | TEXT | REQUEST | NOTIFY | PROVIDE, u32(1 << 20)))
    expect(w.client.clipboard).toBe(true)
    expect(w.sent).toHaveLength(1)
    const caps = clientClip(w.sent[0] as number[])
    expect(caps.flags).toBe((CAPS | TEXT | REQUEST | PEEK | NOTIFY | PROVIDE) >>> 0)
    expect([...caps.body]).toEqual(u32(256 * 1024))
    // caps with no text: not this client's kind
    const other = connected()
    other.client.receive(serverClip(CAPS | 2, u32(100)))
    expect(other.client.clipboard).toBe(false)
  })

  test('what the display copied: asked for and handed on (UTF-8, its line ends LF, no NUL) only while copies are on; plain cut text as Latin-1', () => {
    const w = extended()
    // off (the owner does not have it): a copy there is not even asked for
    w.client.receive(serverClip(NOTIFY | TEXT))
    expect(w.sent).toEqual([])
    // on (the owner took it): what the client can do said again (a filter may have dropped it at the handshake)
    w.client.copies = true
    expect(w.sent.map(m => clientClip(m).flags)).toEqual([(CAPS | TEXT | REQUEST | PEEK | NOTIFY | PROVIDE) >>> 0])
    w.client.copies = true
    expect(w.sent).toHaveLength(1)
    w.sent.length = 0
    w.client.receive(serverClip(NOTIFY | TEXT))
    expect(w.sent.map(m => clientClip(m).flags)).toEqual([(REQUEST | TEXT) >>> 0])
    // it has nothing now: nothing asked
    w.client.receive(serverClip(NOTIFY))
    expect(w.sent).toHaveLength(1)
    w.client.receive(serverClip(PROVIDE | TEXT, provided('Скопируй\r\nменя ✓\0')))
    expect(w.copies).toEqual(['Скопируй\nменя ✓'])
    // in two pieces, as a socket may cut it
    const again = serverClip(PROVIDE | TEXT, provided('second'))
    w.client.receive(again.slice(0, 9))
    w.client.receive(again.slice(9))
    expect(w.copies).toEqual(['Скопируй\nменя ✓', 'second'])
    // off again: what comes is dropped
    w.client.copies = false
    w.client.receive(serverClip(PROVIDE | TEXT, provided('third')))
    expect(w.copies).toHaveLength(2)
    // a server without it: plain Latin-1 cut text
    const plain = connected()
    plain.client.copies = true
    plain.client.receive(bytes(3, 0, 0, 0, u32(5), [0x63, 0x61, 0x66, 0xe9, 0x21]))
    expect(plain.copies).toEqual(['café!'])
    expect(plain.client.state).toBe('live')
  })

  test('the page’s text for the display’s clipboard: announced, sent as the server asks (UTF-8, CR LF, a NUL, one zlib stream), and taken back', () => {
    const w = extended()
    w.client.announce(true)
    w.client.receive(serverClip(REQUEST | TEXT))
    expect(w.wanted()).toBe(1)
    w.client.provide('Привет\nмир')
    w.client.announce(false)
    const [has, text, none] = w.sent.map(clientClip)
    expect(has?.flags).toBe((NOTIFY | TEXT) >>> 0)
    expect(text?.flags).toBe((PROVIDE | TEXT) >>> 0)
    const out = inflateSync(text?.body as Uint8Array, { finishFlush: constants.Z_SYNC_FLUSH })
    const n = new DataView(out.buffer, out.byteOffset).getUint32(0)
    expect(n).toBe(out.length - 4)
    expect(new TextDecoder().decode(out.subarray(4))).toBe('Привет\r\nмир\0')
    expect(none?.flags).toBe(NOTIFY >>> 0)
    // the server peeks: what the page has, said again
    w.sent.length = 0
    w.client.receive(serverClip(PEEK))
    expect(w.sent.map(m => clientClip(m).flags)).toEqual([NOTIFY >>> 0])
    // a server without it: nothing of this goes
    const plain = connected()
    plain.client.announce(true)
    plain.client.provide('x')
    expect(plain.sent).toEqual([])
  })

  test('settled: once the server answered a fence of its own (its turn came); where it does no fences, a moment later', async () => {
    const w = connected()
    const done: string[] = []
    w.client.settled(() => done.push('no fences'))
    expect(w.sent).toEqual([])
    await new Promise(r => setTimeout(r, 200))
    expect(done).toEqual(['no fences'])
    // it does fences (it sent one, answered at once)
    w.client.receive(bytes(248, 0, 0, 0, u32(0x80000000), 0))
    w.sent.length = 0
    w.client.settled(() => done.push('first'))
    w.client.settled(() => done.push('second'))
    expect(w.sent.map(m => m.slice(0, 11))).toEqual([
      [248, 0, 0, 0, 0x80, 0, 0, 0, 4, 0x73, 0x73],
      [248, 0, 0, 0, 0x80, 0, 0, 0, 4, 0x73, 0x73],
    ])
    expect(done).toEqual(['no fences'])
    // the server's answers: its flags without "request", the client's bytes back
    for (const m of w.sent) w.client.receive(bytes(248, 0, 0, 0, u32(0), 4, m.slice(9)))
    expect(done).toEqual(['no fences', 'first', 'second'])
  })

  test('a cut text far too long for a clipboard: the client stops instead of waiting for it', () => {
    const w = connected()
    w.client.receive(bytes(3, 0, 0, 0, u32(64 << 20)))
    expect(w.failures).toEqual([{ code: 'data', detail: `cut text ${64 << 20}` }])
  })
})
