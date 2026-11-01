// The desktops' video in the board's process (services/desktop-video.ts), with an ffmpeg of the
// test's own (its stdout written here) and a clock of its own: one encoder per desktop while it has
// viewers, shared, ended with the last; a viewer starts at a key frame, which a viewer that comes
// later, or whose decoder starts again, gets by the encoder starting again (not more often than
// MIN_RESTART_MS); a viewer that does not keep up gets nothing until it does, then a key frame;
// the encoder ending by itself, or no ffmpeg, closes the viewers so their pages show VNC.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegArgs, readVideoMessage } from '../../src/core/desktop-video.ts'
import {
  createDesktopVideo,
  LOW_AHEAD,
  MAX_AHEAD,
  MIN_RESTART_MS,
  VIDEO_ENDED,
  type VideoSource,
  type VideoSystem,
  type VideoViewer,
} from '../../src/services/desktop-video.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const u24 = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255]
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const bytes = (...parts: (number | number[])[]) =>
  Uint8Array.from(parts.flatMap(p => (typeof p === 'number' ? [p] : p)))
const tag = (data: Uint8Array) => bytes(9, u24(data.length), u24(0), 0, u24(0), [...data], u32(11 + data.length))
const SPS = [0x67, 0x42, 0xc0, 0x28, 0xda]
const PPS = [0x68, 0xce, 0x3c, 0x80]
/** What ffmpeg writes first: FLV's header and the AVC sequence header. */
const head = () =>
  bytes([0x46, 0x4c, 0x56, 1, 1], u32(9), u32(0), [
    ...tag(bytes(0x17, 0, 0, 0, 0, [1, 0x42, 0xc0, 0x28, 0xff, 0xe1], 0, SPS.length, SPS, 1, 0, PPS.length, PPS)),
  ])
const keyFrame = () => tag(bytes(0x17, 1, 0, 0, 0, u32(3), [0x65, 0x88, 0x84]))
const delta = () => tag(bytes(0x27, 1, 0, 0, 0, u32(2), [0x41, 0x9a]))

interface Encoder {
  argv: string[]
  env: Record<string, string>
  log: string
  killed: string
  write(b: Uint8Array): void
  end(code: number): void
}

/** An ffmpeg and a clock of the test's own. */
function fakeSystem(o: { ffmpeg?: string | null; zscale?: boolean } = {}) {
  const encoders: Encoder[] = []
  let clock = 1_000_000
  let ids = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let zscaleAsked = 0
  const sys: VideoSystem = {
    which: name => (name === 'ffmpeg' ? (o.ffmpeg === undefined ? '/usr/bin/ffmpeg' : o.ffmpeg) : null),
    zscale: async () => {
      zscaleAsked++
      return o.zscale ?? true
    },
    spawn(argv, env, log) {
      let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
      const stdout = new ReadableStream<Uint8Array>({
        start: c => {
          ctrl = c
        },
      })
      let exit: (code: number) => void = () => {}
      const exited = new Promise<number>(resolve => {
        exit = resolve
      })
      let over = false
      const e: Encoder = {
        argv,
        env,
        log,
        killed: '',
        write: b => {
          if (!over) ctrl?.enqueue(b)
        },
        end: code => {
          if (over) return
          over = true
          try {
            ctrl?.close()
          } catch {}
          exit(code)
        },
      }
      encoders.push(e)
      return {
        pid: 4000 + encoders.length,
        stdout,
        exited,
        kill: signal => {
          e.killed = signal ?? 'SIGTERM'
          e.end(137)
        },
      }
    },
    now: () => clock,
    setTimeout: (fn, ms) => {
      const id = ++ids
      timers.set(id, { at: clock + ms, fn })
      return id
    },
    clearTimeout: id => {
      timers.delete(id as number)
    },
  }
  /** The clock `ms` on, the timers due run. */
  const advance = async (ms: number) => {
    clock += ms
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at))
      if (t.at <= clock) {
        timers.delete(id)
        t.fn()
      }
    await settle()
  }
  return { sys, encoders, advance, zscaleAsked: () => zscaleAsked }
}

/** What runs on (the encoder's start, its stdout read) has run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Bun.sleep(1)
}

/** A viewer's socket: the frames it got (key or not, their numbers), how it was closed. */
function viewer() {
  const v = {
    got: [] as { key: boolean; seq: number }[],
    closed: null as [number, string] | null,
    send(b: Uint8Array) {
      const m = readVideoMessage(b)
      if (m) v.got.push({ key: m.key, seq: m.seq })
    },
    close(code: number, reason: string) {
      v.closed = [code, reason]
    },
  }
  return v as typeof v & VideoViewer
}

function setup(o: Parameters<typeof fakeSystem>[0] = {}) {
  const fake = fakeSystem(o)
  const logs: string[] = []
  const video = createDesktopVideo({ log: line => logs.push(line), system: fake.sys })
  const dir = mkdtempSync(join(tmpdir(), 'video-'))
  dirs.push(dir)
  const src: VideoSource = { pane: 'w0:p1', display: 104, auth: join(dir, 'Xauthority'), log: join(dir, 'video.log') }
  return { ...fake, logs, video, src }
}

test('one encoder per desktop while it has viewers: started for the first, its frames to each from a key frame, ended with the last', async () => {
  const { video, src, encoders, advance, zscaleAsked } = setup()
  const a = viewer()
  video.join(src, a)
  await settle()
  expect(encoders).toHaveLength(1)
  const [first] = encoders
  expect(first?.argv).toEqual(['/usr/bin/ffmpeg', ...ffmpegArgs({ display: 104, zscale: true })])
  expect(first?.env).toMatchObject({ DISPLAY: ':104', XAUTHORITY: src.auth })
  expect(first?.log).toBe(src.log)
  first?.write(head())
  first?.write(keyFrame())
  first?.write(delta())
  await settle()
  expect(a.got).toEqual([
    { key: true, seq: 1 },
    { key: false, seq: 2 },
  ])

  // a second viewer: nothing until a key frame, which the encoder started again brings, once its turn comes
  const b = viewer()
  video.join(src, b)
  first?.write(delta())
  await settle()
  expect(b.got).toEqual([])
  expect(a.got.at(-1)).toEqual({ key: false, seq: 3 })
  expect(encoders).toHaveLength(1)
  await advance(MIN_RESTART_MS)
  expect(first?.killed).toBe('SIGKILL')
  expect(encoders).toHaveLength(2)
  const second = encoders[1]
  second?.write(head())
  second?.write(keyFrame())
  second?.write(delta())
  await settle()
  expect(b.got).toEqual([
    { key: true, seq: 4 },
    { key: false, seq: 5 },
  ])
  // the first viewer goes on from the new key frame, its numbers on from its own
  expect(a.got.slice(-2)).toEqual([
    { key: true, seq: 4 },
    { key: false, seq: 5 },
  ])
  // asked once for this ffmpeg's zscale
  expect(zscaleAsked()).toBe(1)
  expect(video.running()).toBe(1)

  video.leave(src.pane, a)
  expect(second?.killed).toBe('')
  video.leave(src.pane, b)
  expect(second?.killed).toBe('SIGKILL')
  expect(video.running()).toBe(0)
  // the next viewer: a new encoder at once
  video.join(src, viewer())
  await settle()
  expect(encoders).toHaveLength(3)
})

test('a viewer that does not keep up: no more frames past MAX_AHEAD unanswered, then a key frame once it caught up; one that does is not held', async () => {
  const { video, src, encoders, advance } = setup()
  const slow = viewer()
  const quick = viewer()
  const answer = (v: ReturnType<typeof viewer>) => {
    const last = v.got.at(-1)
    if (last) video.message(src.pane, v, `a${last.seq}`)
  }
  video.join(src, slow)
  video.join(src, quick)
  await settle()
  const [enc] = encoders
  enc?.write(head())
  enc?.write(keyFrame())
  for (let i = 0; i < MAX_AHEAD + 5; i++) {
    enc?.write(delta())
    await settle()
    answer(quick)
  }
  // the slow one got as many as may be in flight, the quick one all of them
  expect(slow.got).toHaveLength(MAX_AHEAD)
  expect(quick.got).toHaveLength(MAX_AHEAD + 6)
  // still behind with more than LOW_AHEAD in flight: no key frame asked for yet
  video.message(src.pane, slow, `a${(slow.got[MAX_AHEAD - LOW_AHEAD - 2] as { seq: number }).seq}`)
  await advance(MIN_RESTART_MS)
  expect(encoders).toHaveLength(1)
  // caught up: the encoder starts again for a key frame; the slow one goes on from it
  answer(slow)
  await advance(MIN_RESTART_MS)
  expect(encoders).toHaveLength(2)
  encoders[1]?.write(head())
  encoders[1]?.write(delta())
  encoders[1]?.write(keyFrame())
  encoders[1]?.write(delta())
  await settle()
  const after = slow.got.slice(MAX_AHEAD)
  expect(after.map(f => f.key)).toEqual([true, false])
})

test('a decoder that starts again asks for a key frame: it gets none of the frames before it, and two asks make one start', async () => {
  const { video, src, encoders, advance } = setup()
  const a = viewer()
  video.join(src, a)
  await settle()
  encoders[0]?.write(head())
  encoders[0]?.write(keyFrame())
  await settle()
  video.message(src.pane, a, 'k')
  video.message(src.pane, a, 'k')
  encoders[0]?.write(delta())
  await settle()
  expect(a.got.map(f => f.key)).toEqual([true])
  await advance(MIN_RESTART_MS)
  expect(encoders).toHaveLength(2)
  encoders[1]?.write(head())
  encoders[1]?.write(keyFrame())
  await settle()
  expect(a.got.map(f => f.key)).toEqual([true, true])
  // anything else it says is nothing
  video.message(src.pane, a, 'hello')
  await advance(MIN_RESTART_MS)
  expect(encoders).toHaveLength(2)
})

test('a viewer behind whose frames will never be answered (its decoder gone with them) asks for a key frame: it starts over from the next one, not held for good', async () => {
  const { video, src, encoders, advance } = setup()
  const a = viewer()
  video.join(src, a)
  await settle()
  encoders[0]?.write(head())
  encoders[0]?.write(keyFrame())
  // its decoder gives nothing out (no answers): past MAX_AHEAD it gets no more
  for (let i = 0; i < MAX_AHEAD + 5; i++) encoders[0]?.write(delta())
  await settle()
  expect(a.got).toHaveLength(MAX_AHEAD)
  // the decoder fails with them in it: they are never answered; the page starts over and asks for a key frame
  video.message(src.pane, a, 'k')
  await advance(MIN_RESTART_MS)
  expect(encoders).toHaveLength(2)
  encoders[1]?.write(head())
  encoders[1]?.write(keyFrame())
  encoders[1]?.write(delta())
  await settle()
  expect(a.got.slice(MAX_AHEAD).map(f => f.key)).toEqual([true, false])
  // and it goes on as any viewer: answered, it keeps getting them
  video.message(src.pane, a, `a${a.got.at(-1)?.seq}`)
  encoders[1]?.write(delta())
  await settle()
  expect(a.got.slice(MAX_AHEAD).map(f => f.key)).toEqual([true, false, false])
})

test('the encoder ending by itself (its display gone): its viewers closed so their pages show VNC, its log’s last words in the board’s', async () => {
  const { video, src, encoders, logs } = setup()
  const a = viewer()
  video.join(src, a)
  await settle()
  writeFileSync(src.log, '[x11grab @ 0x1] Cannot open display :104, error 1.\n')
  encoders[0]?.end(1)
  await settle()
  expect(a.closed).toEqual([VIDEO_ENDED, 'video ended'])
  expect(logs.at(-1)).toBe(
    'desktop :104: video ended: ffmpeg ended (1): [x11grab @ 0x1] Cannot open display :104, error 1.',
  )
  expect(video.running()).toBe(0)
  // its next viewer: started again
  video.join(src, viewer())
  await settle()
  expect(encoders).toHaveLength(2)
})

test('what is not H.264 in FLV on its stdout: the video ended', async () => {
  const { video, src, encoders, logs } = setup()
  const a = viewer()
  video.join(src, a)
  await settle()
  encoders[0]?.write(new TextEncoder().encode('Unknown encoder libx264\n'))
  await settle()
  expect(a.closed?.[0]).toBe(VIDEO_ENDED)
  expect(encoders[0]?.killed).toBe('SIGKILL')
  expect(logs.at(-1)).toContain('not H.264 in FLV')
})

test('no ffmpeg on the server: not available, and a viewer that comes anyway is closed, nothing started', async () => {
  const { video, src, encoders } = setup({ ffmpeg: null })
  expect(video.available()).toBe(false)
  const a = viewer()
  video.join(src, a)
  await settle()
  expect(encoders).toHaveLength(0)
  expect(a.closed?.[0]).toBe(VIDEO_ENDED)
})

test('ffmpeg without zimg: swscale makes the colours', async () => {
  const { video, src, encoders } = setup({ zscale: false })
  video.join(src, viewer())
  await settle()
  expect(encoders[0]?.argv).toEqual(['/usr/bin/ffmpeg', ...ffmpegArgs({ display: 104, zscale: false })])
})

test('the desktop stopped: its encoder ended, its viewers closed; another desktop’s goes on', async () => {
  const { video, src, encoders } = setup()
  const a = viewer()
  const other = viewer()
  video.join(src, a)
  video.join({ ...src, pane: 'w0:p2', display: 105 }, other)
  await settle()
  expect(video.running()).toBe(2)
  video.stop(src.pane)
  expect(a.closed).toEqual([1001, 'stopped'])
  expect(encoders[0]?.killed).toBe('SIGKILL')
  expect(encoders[1]?.killed).toBe('')
  expect(other.closed).toBeNull()
  video.stopAll()
  expect(other.closed).toEqual([1001, 'stopped'])
  expect(video.running()).toBe(0)
})

// ------------------------------------------------ end to end: the board's video and the page's decoder

/** ffmpeg 4.4's own FLV (x264 as the board runs it): what it writes before its first frame, its key frame, its deltas. */
function realStream() {
  const flv = new Uint8Array(readFileSync(join(import.meta.dir, '../fixtures/video/x264-64x48.flv')))
  const tags: Uint8Array[] = []
  for (let at = 13; at + 11 <= flv.length; ) {
    const size = ((flv[at + 1] as number) << 16) | ((flv[at + 2] as number) << 8) | (flv[at + 3] as number)
    tags.push(flv.subarray(at, at + 11 + size + 4))
    at += 11 + size + 4
  }
  // a frame's tag: video, AVC, its NAL units (not the sequence header); a key frame's type 1
  const isFrame = (t: Uint8Array) => t[0] === 9 && t[12] === 1
  const first = tags.findIndex(isFrame)
  const frames = tags.slice(first)
  const deltas = frames.filter(t => (t[11] as number) >> 4 !== 1)
  return {
    head: Uint8Array.from([...flv.subarray(0, 13), ...tags.slice(0, first).flatMap(t => [...t])]),
    key: frames[0] as Uint8Array,
    delta: (i: number) => deltas[i % deltas.length] as Uint8Array,
  }
}

/**
 * The owner's page on a viewer's socket, both ways: models/desk-video.ts as the page runs it, with
 * a WebCodecs of the test's own whose decoder gives frames out only when told (keepUp), or fails.
 */
async function page(video: ReturnType<typeof createDesktopVideo>, pane: string, now: () => number) {
  const { DeskVideo } = await import('../../web/src/models/desk-video.ts')
  const decoders: { init: VideoDecoderInit; state: string; given: number[]; fail(): void }[] = []
  class Decoder {
    state = 'unconfigured'
    given: number[] = []
    constructor(readonly init: VideoDecoderInit) {
      decoders.push(this)
    }
    configure() {
      this.state = 'configured'
    }
    decode(c: { timestamp: number }) {
      this.given.push(c.timestamp)
    }
    close() {
      this.state = 'closed'
    }
    fail() {
      this.state = 'closed'
      this.init.error(new Error('Decoding error.') as DOMException)
    }
    static isConfigSupported = async (config: VideoDecoderConfig) => ({ supported: true, config })
  }
  class Chunk {
    constructor(init: object) {
      Object.assign(this, init)
    }
  }
  const drawn: number[] = []
  const failed: string[] = []
  const socket: VideoViewer = {
    send: b => desk.receive(b),
    close: () => {},
  }
  const desk = new DeskVideo(
    {
      VideoDecoder: Decoder as unknown as typeof VideoDecoder,
      EncodedVideoChunk: Chunk as unknown as typeof EncodedVideoChunk,
    },
    text => video.message(pane, socket, text),
    { draw: f => drawn.push(f.timestamp), failed: why => failed.push(why) },
    now,
  )
  /** The decoder gives out all it was given (drawn and answered), as one that keeps up. */
  const keepUp = () => {
    const d = decoders.at(-1)
    for (const ts of d?.given.splice(0) ?? [])
      d?.init.output({ timestamp: ts, displayWidth: 64, displayHeight: 48, close() {} } as unknown as VideoFrame)
  }
  return { socket, desk, decoders, drawn, failed, keepUp }
}

/** The page drawing as it should: a key frame and `n` deltas, each given out at once. */
async function watching(n: number) {
  const s = setup()
  const p = await page(s.video, s.src.pane, s.sys.now)
  const stream = realStream()
  s.video.join(s.src, p.socket)
  await settle()
  s.encoders[0]?.write(stream.head)
  s.encoders[0]?.write(stream.key)
  await settle()
  p.keepUp()
  for (let i = 0; i < n; i++) {
    s.encoders[0]?.write(stream.delta(i))
    await settle()
    p.keepUp()
  }
  expect(p.drawn).toHaveLength(n + 1)
  // then its decoder gives nothing out: the board stops at MAX_AHEAD unanswered, the rest held
  for (let i = 0; i < MAX_AHEAD + 10; i++) s.encoders[0]?.write(stream.delta(i))
  await settle()
  expect(p.decoders[0]?.given).toHaveLength(MAX_AHEAD)
  return { ...s, p, stream }
}

test('the owner’s iPad, end to end with ffmpeg’s own frames: its decoder stops giving frames out and then fails with them in it; the page starts over and draws again', async () => {
  const { p, encoders, advance, stream } = await watching(10)
  p.decoders[0]?.fail()
  await advance(MIN_RESTART_MS)
  expect(encoders).toHaveLength(2)
  encoders[1]?.write(stream.head)
  encoders[1]?.write(stream.key)
  await settle()
  p.keepUp()
  encoders[1]?.write(stream.delta(0))
  await settle()
  p.keepUp()
  // the key frame and the delta after it: drawn by a decoder of its own
  expect(p.decoders).toHaveLength(2)
  expect(p.drawn).toHaveLength(13)
  expect(p.failed).toEqual([])
})

test('end to end, its decoder stops giving frames out with no error: STALL_MS on, the page starts it again from a key frame and draws again', async () => {
  const { p, encoders, advance, stream } = await watching(10)
  const stall: number = Reflect.get(await import('../../web/src/models/desk-video.ts'), 'STALL_MS') ?? 3000
  // nothing out for a while: nothing to do yet
  await advance(stall - 1)
  p.desk.check()
  expect(p.decoders).toHaveLength(1)
  await advance(1)
  p.desk.check()
  await advance(MIN_RESTART_MS)
  expect(encoders).toHaveLength(2)
  encoders[1]?.write(stream.head)
  encoders[1]?.write(stream.key)
  await settle()
  p.keepUp()
  encoders[1]?.write(stream.delta(0))
  await settle()
  p.keepUp()
  expect(p.decoders).toHaveLength(2)
  expect(p.decoders[0]?.state).toBe('closed')
  expect(p.drawn).toHaveLength(13)
  expect(p.failed).toEqual([])
})
