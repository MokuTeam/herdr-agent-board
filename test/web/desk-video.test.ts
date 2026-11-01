// An agent's display as H.264 video in the page (web/src/models/desk-video.ts), with a WebCodecs of
// the test's own: a key frame first, its codec string read from its SPS and checked before the
// decoder is set up for latency; each frame a chunk (key or delta) numbered by its message and
// answered once drawn; frames before a key frame not decoded but answered; a codec the browser does
// not decode, or a decoder that never decoded a frame, and the view falls back to VNC; one that
// fails after it worked starts again from a key frame it asks the board for.
import { expect, test } from 'bun:test'
import { KEY_TEXT, videoMessage } from '../../src/core/desktop-video.ts'
import { type Codecs, DeskVideo, webCodecs } from '../../web/src/models/desk-video.ts'

const START = [0, 0, 0, 1]
const KEY = Uint8Array.from([
  ...START,
  ...[0x67, 0x42, 0xc0, 0x28, 0xda],
  ...START,
  ...[0x68, 0xce, 0x3c, 0x80],
  ...START,
  ...[0x65, 0x88, 0x84],
])
const DELTA = Uint8Array.from([...START, 0x41, 0x9a])
const key = (seq: number) => videoMessage(seq, { key: true, data: KEY })
const delta = (seq: number) => videoMessage(seq, { key: false, data: DELTA })

interface Chunk {
  type: string
  timestamp: number
  data: Uint8Array
}

/** A WebCodecs of the test's own: the configs it was asked about, its decoders and what each was given. */
function fakeCodecs(o: { supported?: boolean | 'throws' } = {}) {
  const asked: VideoDecoderConfig[] = []
  const decoders: FakeDecoder[] = []
  class FakeChunk {
    type: string
    timestamp: number
    data: Uint8Array
    constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
      this.type = init.type
      this.timestamp = init.timestamp
      this.data = Uint8Array.from(init.data)
    }
  }
  class FakeDecoder {
    state = 'unconfigured'
    config: VideoDecoderConfig | null = null
    chunks: Chunk[] = []
    constructor(readonly init: VideoDecoderInit) {
      decoders.push(this)
    }
    configure(c: VideoDecoderConfig) {
      this.config = c
      this.state = 'configured'
    }
    decode(chunk: Chunk) {
      this.chunks.push({ type: chunk.type, timestamp: chunk.timestamp, data: chunk.data })
    }
    close() {
      this.state = 'closed'
    }
    static async isConfigSupported(c: VideoDecoderConfig) {
      asked.push(c)
      if (o.supported === 'throws') throw new TypeError('invalid codec')
      return { supported: o.supported ?? true, config: c }
    }
    /** A frame out of it (the chunk numbered `ts`): what the page drew, and whether it was let go. */
    out(ts: number) {
      const frame = {
        timestamp: ts,
        displayWidth: 1440,
        displayHeight: 900,
        closed: false,
        close() {
          frame.closed = true
        },
      }
      this.init.output(frame as unknown as VideoFrame)
      return frame
    }
    fail(message: string) {
      this.state = 'closed'
      this.init.error(new Error(message) as DOMException)
    }
  }
  const codecs: Codecs = {
    VideoDecoder: FakeDecoder as unknown as typeof VideoDecoder,
    EncodedVideoChunk: FakeChunk as unknown as typeof EncodedVideoChunk,
  }
  return { codecs, asked, decoders }
}

function setup(o: Parameters<typeof fakeCodecs>[0] = {}) {
  const fake = fakeCodecs(o)
  const sent: string[] = []
  const drawn: { timestamp: number; closed: boolean }[] = []
  const failed: string[] = []
  const ready: string[] = []
  let clock = 0
  const video = new DeskVideo(
    fake.codecs,
    text => sent.push(text),
    {
      draw: frame =>
        drawn.push({ timestamp: frame.timestamp, closed: (frame as unknown as { closed: boolean }).closed }),
      failed: why => failed.push(why),
      ready: codec => ready.push(codec),
    },
    () => clock,
  )
  return { ...fake, video, sent, drawn, failed, ready, tick: (ms: number) => (clock += ms) }
}

const settle = () => new Promise(done => setTimeout(done, 1))

test('a key frame first: its codec from its SPS checked, the decoder set for latency, each frame a chunk numbered by its message, each drawn answered', async () => {
  const { video, asked, decoders, sent, drawn, ready } = setup()
  // before any key frame: nothing to decode, answered at once (the board does not count it on its way)
  video.receive(delta(1))
  expect(decoders).toEqual([])
  expect(sent).toEqual(['a1'])
  video.receive(key(2))
  // what comes while the codec is checked waits behind it, in order
  video.receive(delta(3))
  await settle()
  expect(asked).toEqual([{ codec: 'avc1.42C028', optimizeForLatency: true }])
  expect(decoders).toHaveLength(1)
  const [d] = decoders
  expect(d?.config).toEqual({ codec: 'avc1.42C028', optimizeForLatency: true })
  expect(d?.chunks).toEqual([
    { type: 'key', timestamp: 2, data: KEY },
    { type: 'delta', timestamp: 3, data: DELTA },
  ])
  expect(ready).toEqual(['avc1.42C028'])
  video.receive(delta(4))
  expect(d?.chunks.at(-1)).toMatchObject({ type: 'delta', timestamp: 4 })
  // drawn, let go after, answered with its number
  const frame = d?.out(2)
  expect(drawn).toEqual([{ timestamp: 2, closed: false }])
  expect(frame?.closed).toBe(true)
  expect(sent).toEqual(['a1', 'a2'])
  // a later key frame of the same codec: the same decoder, no check again
  video.receive(key(5))
  expect(asked).toHaveLength(1)
  expect(d?.chunks.at(-1)).toMatchObject({ type: 'key', timestamp: 5 })
  // too short to be a frame: nothing
  video.receive(Uint8Array.of(1, 0, 0))
  expect(d?.chunks).toHaveLength(4)
})

test('a codec the browser does not decode (or cannot say): the video given up, nothing decoded', async () => {
  for (const supported of [false, 'throws'] as const) {
    const { video, decoders, failed } = setup({ supported })
    video.receive(key(1))
    await settle()
    expect(decoders).toEqual([])
    expect(failed).toEqual(['the browser does not decode avc1.42C028'])
    // given up: what comes after is nothing
    video.receive(key(2))
    await settle()
    expect(failed).toHaveLength(1)
  }
})

test('the decoder failing before it decoded a frame: given up (the device cannot); after: started again from a key frame it asks for', async () => {
  const never = setup()
  never.video.receive(key(1))
  await settle()
  never.decoders[0]?.fail('Decoding error.')
  expect(never.failed).toEqual(['the decoder failed: Decoding error.'])

  const { video, decoders, sent, failed, tick } = setup()
  video.receive(key(1))
  await settle()
  decoders[0]?.out(1)
  decoders[0]?.fail('Codec reclaimed due to inactivity.')
  expect(failed).toEqual([])
  expect(sent).toEqual(['a1', KEY_TEXT])
  // until the key frame: not decoded, answered
  video.receive(delta(2))
  expect(sent.at(-1)).toBe('a2')
  video.receive(key(3))
  await settle()
  expect(decoders).toHaveLength(2)
  expect(decoders[1]?.chunks.map(c => c.type)).toEqual(['key'])
  // a third failure within a minute: given up
  decoders[1]?.out(3)
  tick(10_000)
  decoders[1]?.fail('again')
  video.receive(key(4))
  await settle()
  decoders[2]?.out(4)
  tick(10_000)
  decoders[2]?.fail('and again')
  expect(failed).toEqual(['the decoder failed: and again'])
})

test('a decoder that drew and then gives nothing out, with no error (Safari’s on the owner’s iPad): STALL_MS on it starts again from a key frame it asks for, said; still nothing as long after: stalled', async () => {
  const STALL_MS: number = Reflect.get(await import('../../web/src/models/desk-video.ts'), 'STALL_MS') ?? 3000
  const fake = fakeCodecs()
  const sent: string[] = []
  const said: string[] = []
  let clock = 0
  const video = new DeskVideo(
    fake.codecs,
    text => sent.push(text),
    {
      draw() {},
      failed: why => said.push(`failed: ${why}`),
      restarted: why => said.push(`restarted: ${why}`),
      stalled: why => said.push(`stalled: ${why}`),
    },
    () => clock,
  )
  // before its first frame: the view's own wait (VIDEO_WAIT_MS), not this one
  video.receive(key(1))
  await settle()
  clock += STALL_MS * 2
  video.check()
  expect(sent).toEqual([])
  fake.decoders[0]?.out(1)
  // frames out: nothing to do; then none for STALL_MS
  video.receive(delta(2))
  clock += STALL_MS - 1
  video.check()
  expect(sent).toEqual(['a1'])
  clock += 1
  video.check()
  expect(sent).toEqual(['a1', KEY_TEXT])
  expect(fake.decoders[0]?.state).toBe('closed')
  expect(said).toEqual([`restarted: no frame in ${STALL_MS / 1000} s`])
  // asked once: it waits for that key frame
  clock += STALL_MS - 1
  video.check()
  expect(sent).toEqual(['a1', KEY_TEXT])
  // it came, a decoder of its own draws again: the watch starts over
  video.receive(key(3))
  await settle()
  expect(fake.decoders).toHaveLength(2)
  fake.decoders[1]?.out(3)
  clock += STALL_MS - 1
  video.check()
  expect(said).toHaveLength(1)
  // stuck again, and no key frame comes after the ask either: stalled (the view opens its video again)
  clock += 1
  video.check()
  expect(sent.at(-1)).toBe(KEY_TEXT)
  clock += STALL_MS
  video.check()
  expect(said.at(-1)).toBe(`stalled: no frame in ${STALL_MS / 1000} s after a key frame was asked for`)
  // said once; nothing more from it
  clock += STALL_MS
  video.check()
  expect(said.filter(s => s.startsWith('stalled'))).toHaveLength(1)
  expect(said.filter(s => s.startsWith('failed'))).toEqual([])
})

test('the decoder failing after it drew is said too (the board’s log), as it starts again', async () => {
  const fake = fakeCodecs()
  const said: string[] = []
  const video = new DeskVideo(fake.codecs, () => {}, {
    draw() {},
    failed: why => said.push(`failed: ${why}`),
    restarted: why => said.push(`restarted: ${why}`),
  })
  video.receive(key(1))
  await settle()
  fake.decoders[0]?.out(1)
  fake.decoders[0]?.fail('Decoding error.')
  expect(said).toEqual(['restarted: the decoder failed: Decoding error.'])
})

test('closed with the view: the decoder let go, nothing after', async () => {
  const { video, decoders, sent } = setup()
  video.receive(key(1))
  await settle()
  video.close()
  expect(decoders[0]?.state).toBe('closed')
  video.receive(delta(2))
  expect(decoders[0]?.chunks).toHaveLength(1)
  expect(sent).toEqual([])
})

test('WebCodecs where the page has it, none where not', () => {
  const saved = { d: Reflect.get(globalThis, 'VideoDecoder'), c: Reflect.get(globalThis, 'EncodedVideoChunk') }
  try {
    Reflect.deleteProperty(globalThis, 'VideoDecoder')
    expect(webCodecs()).toBeNull()
    const fake = fakeCodecs().codecs
    Reflect.set(globalThis, 'VideoDecoder', fake.VideoDecoder)
    expect(webCodecs()).toBeNull()
    Reflect.set(globalThis, 'EncodedVideoChunk', fake.EncodedVideoChunk)
    expect(webCodecs()).toEqual(fake)
  } finally {
    Reflect.set(globalThis, 'VideoDecoder', saved.d)
    Reflect.set(globalThis, 'EncodedVideoChunk', saved.c)
    if (saved.d === undefined) Reflect.deleteProperty(globalThis, 'VideoDecoder')
    if (saved.c === undefined) Reflect.deleteProperty(globalThis, 'EncodedVideoChunk')
  }
})
