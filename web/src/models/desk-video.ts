// An agent's display as H.264 video in the page (hooks/useDesktop.ts), decoded by the browser's own
// WebCodecs VideoDecoder (the hardware's where it has one: Safari 16.4 and later, Chrome, Firefox),
// set for latency: each frame drawn as soon as it is decoded. The board sends a frame a message
// (core/desktop-video.ts): a key frame first, its codec string read from its SPS and checked with
// the decoder before it is set up; each frame decoded is answered with its number, so the board
// sends no more than the page takes. A decoder that fails after it worked starts again from a key
// frame, which it asks the board for; one that never decoded a frame, a codec it does not take, or
// three failures in a minute, and the view falls back to the VNC picture (`failed`). The board's
// encoder makes 30 frames a second however still the screen is, so a decoder that drew and then
// gives nothing out for STALL_MS (Safari's on an iPad did, with no error) has stopped: it starts
// again the same way (`check`, each second), and, no frame STALL_MS after that either, the view
// opens its video again (`stalled`).
import { ackText, avcCodec, KEY_TEXT, readVideoMessage } from '../../../src/core/desktop-video.ts'

/** WebCodecs as the page has it; tests hand in their own. */
export interface Codecs {
  VideoDecoder: typeof VideoDecoder
  EncodedVideoChunk: typeof EncodedVideoChunk
}

/** The browser's WebCodecs, or null where it has none (an older Safari, a page not on https). */
export function webCodecs(): Codecs | null {
  const g = globalThis as { VideoDecoder?: unknown; EncodedVideoChunk?: unknown }
  if (typeof g.VideoDecoder !== 'function' || typeof g.EncodedVideoChunk !== 'function') return null
  return {
    VideoDecoder: g.VideoDecoder as typeof VideoDecoder,
    EncodedVideoChunk: g.EncodedVideoChunk as typeof EncodedVideoChunk,
  }
}

export interface DeskVideoEvents {
  /** A frame decoded: drawn now (it is closed once this returns). */
  draw(frame: VideoFrame): void
  /** The video cannot be shown here: why (for the board's log); the view shows VNC's picture. */
  failed(why: string): void
  /** The decoder is set up for this codec (for the board's log, once). */
  ready?(codec: string): void
  /** The decoder starts again from a key frame (it failed, or stopped giving frames out): why, for the board's log. */
  restarted?(why: string): void
  /** No frame even after a key frame was asked for: the view opens its video again (without this: `failed`). */
  stalled?(why: string): void
}

/** Failures a decoder may have in a minute (it starts again after each) before the view gives up on video. */
const MAX_FAILURES = 3
const FAILURES_MS = 60_000
/** No frame out of a decoder that drew this long: it has stopped (the board's encoder makes 30 a second, a still screen too). */
export const STALL_MS = 3000

type Message = NonNullable<ReturnType<typeof readVideoMessage>>

export class DeskVideo {
  private decoder: VideoDecoder | null = null
  private codec = ''
  /** Messages that came while the codec was being checked, in order (the first a key frame). */
  private waiting: Message[] | null = null
  /** Nothing to decode until a key frame (at the start, and after the decoder failed). */
  private needKey = true
  private decoded = 0
  private failures: number[] = []
  private over = false
  /** When a frame last came out (or the decoder last started again for want of one). */
  private lastOut = 0
  /** It started again for want of a frame and none came since: when. */
  private askedAt: number | null = null

  constructor(
    private readonly codecs: Codecs,
    /** A text to the board on the video's socket. */
    private readonly send: (text: string) => void,
    private readonly events: DeskVideoEvents,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A message from the board's video socket. */
  receive(bytes: Uint8Array): void {
    if (this.over) return
    const m = readVideoMessage(bytes)
    if (!m) return
    if (this.waiting) this.waiting.push(m)
    else this.decode(m)
  }

  /**
   * Each second or so while the video is on: a decoder that drew and has given nothing out for
   * STALL_MS starts again from a key frame it asks for; still nothing STALL_MS after that, `stalled`.
   * Before its first frame the view's own wait applies.
   */
  check(): void {
    if (this.over || !this.decoded) return
    const at = this.now()
    if (at - this.lastOut < STALL_MS) return
    const secs = STALL_MS / 1000
    if (this.askedAt === null) {
      this.askedAt = at
      this.lastOut = at
      this.again(`no frame in ${secs} s`)
      return
    }
    const why = `no frame in ${secs} s after a key frame was asked for`
    if (!this.events.stalled) {
      this.fail(why)
      return
    }
    this.close()
    this.events.stalled(why)
  }

  /** The view closed (or went to VNC): the decoder let go. */
  close(): void {
    this.over = true
    this.waiting = null
    this.release()
  }

  private decode(m: Message): void {
    if (m.key) {
      const codec = avcCodec(m.data)
      if (codec && (codec !== this.codec || this.decoder?.state !== 'configured')) {
        this.waiting = [m]
        void this.configure(codec)
        return
      }
      this.needKey = false
    }
    const decoder = this.decoder
    if (this.needKey || decoder?.state !== 'configured') {
      // not decoded: said at once, so the board does not count it as still on its way
      this.send(ackText(m.seq))
      return
    }
    try {
      decoder.decode(
        new this.codecs.EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.seq, data: m.data }),
      )
    } catch (err) {
      this.broken(err)
    }
  }

  private async configure(codec: string): Promise<void> {
    const config: VideoDecoderConfig = { codec, optimizeForLatency: true }
    let supported = false
    try {
      supported = (await this.codecs.VideoDecoder.isConfigSupported(config)).supported === true
    } catch {}
    if (this.over) return
    if (!supported) return this.fail(`the browser does not decode ${codec}`)
    this.release()
    try {
      const decoder = new this.codecs.VideoDecoder({
        output: frame => this.output(frame),
        error: err => this.broken(err),
      })
      decoder.configure(config)
      this.decoder = decoder
    } catch (err) {
      return this.fail(`${codec}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!this.codec) this.events.ready?.(codec)
    this.codec = codec
    this.needKey = false
    const waiting = this.waiting ?? []
    this.waiting = null
    for (const [i, m] of waiting.entries()) {
      if (this.over) return
      // set up again meanwhile (a key frame of another codec): the rest waits behind it
      const again = this.waiting as Message[] | null
      if (again) {
        again.push(...waiting.slice(i))
        return
      }
      this.decode(m)
    }
  }

  private output(frame: VideoFrame): void {
    if (this.over) {
      frame.close()
      return
    }
    this.decoded++
    this.lastOut = this.now()
    this.askedAt = null
    const seq = frame.timestamp
    try {
      this.events.draw(frame)
    } finally {
      frame.close()
    }
    this.send(ackText(seq))
  }

  /** The decoder failed: started again from a key frame, or, before it decoded any (or too often), video given up. */
  private broken(err: unknown): void {
    if (this.over) return
    const why = `the decoder failed: ${err instanceof Error ? err.message : String(err)}`
    if (this.decoded) this.again(why)
    else this.fail(why)
  }

  /** Started again from a key frame it asks the board for (a new decoder for it); too often in a minute, video given up. */
  private again(why: string): void {
    const at = this.now()
    this.failures = [...this.failures.filter(t => at - t < FAILURES_MS), at]
    if (this.failures.length >= MAX_FAILURES) {
      this.fail(why)
      return
    }
    this.release()
    this.codec = ''
    this.needKey = true
    this.send(KEY_TEXT)
    this.events.restarted?.(why)
  }

  private fail(why: string): void {
    if (this.over) return
    this.close()
    this.events.failed(why)
  }

  private release(): void {
    const d = this.decoder
    this.decoder = null
    if (d && d.state !== 'closed')
      try {
        d.close()
      } catch {}
  }
}
