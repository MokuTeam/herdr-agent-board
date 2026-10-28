// The board's own small VNC client (web/src/models/rfb.ts) against a fake server's bytes: the
// handshake of RFB 3.8 and 3.3 with no password, what it asks for once in (32-bit pixels it can draw
// as they come, CopyRect, Hextile, Raw, the display's new size), the pictures it draws, what it
// sends for the mouse and the keys, and why it gives up. Then the keys and points it sends
// (web/src/models/desk-input.ts).
import { describe, expect, test } from 'bun:test'
import { buttonMask, keysymOf, screenPoint, textKeysyms } from '../../web/src/models/desk-input.ts'
import { RfbClient, type RfbFailure, type RfbScreen } from '../../web/src/models/rfb.ts'

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
function world() {
  const sent: number[][] = []
  const drawn: string[] = []
  const failures: RfbFailure[] = []
  let live = ''
  const screen: RfbScreen = {
    size: (w, h) => drawn.push(`size ${w}x${h}`),
    put: (x, y, w, h, rgba) => drawn.push(`put ${x},${y} ${w}x${h} ${[...rgba.slice(0, 8)].join(' ')}`),
    copy: (sx, sy, x, y, w, h) => drawn.push(`copy ${sx},${sy} -> ${x},${y} ${w}x${h}`),
  }
  const client = new RfbClient(b => sent.push([...b]), screen, {
    live: name => {
      live = name
    },
    failed: why => failures.push(why),
  })
  return { client, sent, drawn, failures, live: () => live }
}

/** A client through the 3.8 handshake to a 4 × 2 display named "agent", what it sent so far taken. */
function connected() {
  const w = world()
  w.client.receive(ascii('RFB 003.008\n'))
  w.client.receive(bytes(1, 1))
  w.client.receive(bytes(u32(0)))
  w.client.receive(serverInit(4, 2, 'agent'))
  w.sent.length = 0
  w.drawn.length = 0
  return w
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
      // SetEncodings: CopyRect, Hextile, Raw, DesktopSize.
      [2, 0, 0, 4, ...s32(1), ...s32(5), ...s32(0), ...s32(-223)],
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
  test('Raw: its pixels as they come, made opaque; then the next update is asked for, incremental', () => {
    const w = connected()
    const px = [10, 20, 30, 0, 40, 50, 60, 0]
    w.client.receive(bytes(update(1), rect(1, 1, 2, 1, 0), px))
    expect(w.drawn).toEqual(['put 1,1 2x1 10 20 30 255 40 50 60 255'])
    expect(w.sent).toEqual([[3, 1, 0, 0, 0, 0, ...u16(4), ...u16(2)]])
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
    expect(w.sent).toEqual([[3, 1, 0, 0, 0, 0, ...u16(8), ...u16(6)]])
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
