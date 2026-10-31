// An agent's display as H.264 video for its viewers (core/desktop-video.ts), in the board's process:
// one encoder (ffmpeg) per desktop, only while at least one viewer watches it, shared by them all,
// ended when the last one goes. Its frames go to each viewer as they come; a viewer starts at a key
// frame. There is one key frame in a stream, its first: a viewer that comes while it runs, or whose
// decoder starts again, gets one by the encoder starting again (about 0.2 s; the others see their
// picture stand still meanwhile and go on from the new key frame), at most every MIN_RESTART_MS.
//
// Each viewer says which frames it got; one that has more than MAX_AHEAD of them (or their bytes)
// unanswered is behind (its link is slower than the picture changes): it gets no more until the
// ones in flight are down to LOW_AHEAD, then a key frame, so it never sees seconds-old frames. The
// encoder is the board's child: the board gone, its stdout is closed and it ends. Where there is no
// ffmpeg, no viewer is taken (the route says so) and the page shows the VNC picture instead.
import { closeSync, openSync, readFileSync } from 'node:fs'
import { ffmpegArgs, flvUnits, readViewerText, type VideoUnit, videoMessage } from '../core/desktop-video.ts'

export interface VideoProc {
  pid: number
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}

/** What the video asks of the server: tests hand in their own. */
export interface VideoSystem {
  /** ffmpeg on PATH, or null (looked for at each start: one installed later counts). */
  which(name: string): string | null
  /** Whether this ffmpeg has zimg's scaler (`zscale`): asked once per program. */
  zscale(ffmpeg: string): Promise<boolean>
  /** ffmpeg with `argv`, its stdout a pipe, its errors into `log`. */
  spawn(argv: string[], env: Record<string, string>, log: string): VideoProc
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

/** The display a desktop's video grabs: its number, its X cookie, the log ffmpeg writes to. */
export interface VideoSource {
  pane: string
  display: number
  auth: string
  log: string
}

/** A viewer's socket: a frame's message sent, and closed with a code and a word. */
export interface VideoViewer {
  send(bytes: Uint8Array): void
  close(code: number, reason: string): void
}

export interface DesktopVideo {
  /** ffmpeg is on this server. */
  available(): boolean
  /** A viewer of the desktop: its encoder started for it, or started again for a key frame. */
  join(src: VideoSource, viewer: VideoViewer): void
  /** A viewer gone: the last one gone, its encoder ends. */
  leave(pane: string, viewer: VideoViewer): void
  /** What a viewer said (core/desktop-video.ts readViewerText). */
  message(pane: string, viewer: VideoViewer, text: string): void
  /** The desktop stopped: its encoder ended, its viewers closed. */
  stop(pane: string): void
  stopAll(): void
  /** How many encoders run (for tests and the log). */
  running(): number
}

/** A viewer with this many frames (or bytes) unanswered is behind: it gets none until it is down to LOW_AHEAD. */
export const MAX_AHEAD = 20
export const MAX_AHEAD_BYTES = 3 << 20
export const LOW_AHEAD = 2
/** The encoder starts again (for a key frame) at most this often. */
export const MIN_RESTART_MS = 1500
/** A viewer's socket closed as the video ended (the encoder failed, its display gone): the page shows VNC. */
export const VIDEO_ENDED = 4011
/** Closed: the video cannot be made here (no ffmpeg). */
export const VIDEO_NONE = 4010

const PATH = '/usr/local/bin:/usr/bin:/bin'

/** The server's own. */
export const realVideoSystem: VideoSystem = {
  which: name => Bun.which(name, { PATH: `${process.env.PATH ?? ''}:${PATH}` }),
  zscale: async ffmpeg => {
    try {
      const p = Bun.spawn([ffmpeg, '-hide_banner', '-filters'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
      const out = await new Response(p.stdout).text()
      await p.exited
      return /^\s*\S+\s+zscale\s/m.test(out)
    } catch {
      return false
    }
  },
  spawn(argv, env, log) {
    const fd = openSync(log, 'a', 0o600)
    try {
      const p = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: fd })
      return {
        pid: p.pid,
        stdout: p.stdout as ReadableStream<Uint8Array>,
        exited: p.exited,
        kill: signal => p.kill(signal),
      }
    } finally {
      closeSync(fd)
    }
  },
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
}

/** A viewer's place in a stream: waiting for a key frame, what it was sent and has not said it got. */
interface Seat {
  waitKey: boolean
  /** Behind: nothing until what is in flight is down to LOW_AHEAD. */
  behind: boolean
  flight: { seq: number; bytes: number }[]
}

interface Stream {
  src: VideoSource
  viewers: Map<VideoViewer, Seat>
  proc: VideoProc | null
  /** Which start of the encoder is the current one: an earlier one's frames and end are not its. */
  gen: number
  /** The current start has made its key frame. */
  keyed: boolean
  seq: number
  startedAt: number
  /** A start again waits for its turn (MIN_RESTART_MS). */
  again: unknown
  ending: boolean
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A log's last lines, on one line. */
function tailOf(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-3).join(' | ').slice(-400)
  } catch {
    return ''
  }
}

export function createDesktopVideo(o: { log(line: string): void; system?: VideoSystem }): DesktopVideo {
  const sys = o.system ?? realVideoSystem
  const streams = new Map<string, Stream>()
  const zscales = new Map<string, Promise<boolean>>()

  const inFlight = (s: Seat) => s.flight.reduce((n, f) => n + f.bytes, 0)

  function deliver(st: Stream, unit: VideoUnit): void {
    st.seq = (st.seq + 1) >>> 0
    if (unit.key) st.keyed = true
    const msg = videoMessage(st.seq, unit)
    for (const [viewer, seat] of st.viewers) {
      if (seat.behind && seat.flight.length > LOW_AHEAD) continue
      if (seat.waitKey && !unit.key) continue
      if (!unit.key && (seat.flight.length >= MAX_AHEAD || inFlight(seat) >= MAX_AHEAD_BYTES)) {
        // its link backs up: nothing more until it catches up, then a key frame
        seat.behind = true
        seat.waitKey = true
        continue
      }
      seat.waitKey = false
      seat.behind = false
      seat.flight.push({ seq: st.seq, bytes: msg.length })
      try {
        viewer.send(msg)
      } catch {}
    }
  }

  async function start(st: Stream): Promise<void> {
    const gen = ++st.gen
    st.keyed = false
    st.startedAt = sys.now()
    const ffmpeg = sys.which('ffmpeg')
    if (!ffmpeg) return end(st, gen, 'no ffmpeg')
    let zscale = zscales.get(ffmpeg)
    if (!zscale) {
      zscale = sys.zscale(ffmpeg)
      zscales.set(ffmpeg, zscale)
    }
    const z = await zscale
    if (st.gen !== gen || st.ending) return
    let proc: VideoProc
    try {
      proc = sys.spawn(
        [ffmpeg, ...ffmpegArgs({ display: st.src.display, zscale: z })],
        {
          DISPLAY: `:${st.src.display}`,
          XAUTHORITY: st.src.auth,
          HOME: process.env.HOME ?? '',
          PATH: `${process.env.PATH ?? ''}:${PATH}`,
        },
        st.src.log,
      )
    } catch (err) {
      return end(st, gen, messageOf(err))
    }
    st.proc = proc
    void proc.exited.then(code => {
      if (st.gen === gen && !st.ending) end(st, gen, `ffmpeg ended (${code}): ${tailOf(st.src.log) || 'no word'}`)
    })
    const read = flvUnits()
    try {
      for await (const chunk of proc.stdout) {
        if (st.gen !== gen) break
        const units = read(chunk)
        if (!units) return end(st, gen, 'ffmpeg wrote what is not H.264 in FLV')
        for (const unit of units) deliver(st, unit)
      }
    } catch {}
  }

  /** The stream over (it failed, or ended by itself): its viewers told, so their pages show VNC. */
  function end(st: Stream, gen: number, why: string): void {
    if (st.gen !== gen || streams.get(st.src.pane) !== st) return
    o.log(`desktop :${st.src.display}: video ended: ${why}`)
    halt(st)
    for (const viewer of st.viewers.keys()) viewer.close(VIDEO_ENDED, 'video ended')
    st.viewers.clear()
  }

  function halt(st: Stream): void {
    st.ending = true
    st.gen++
    sys.clearTimeout(st.again)
    st.again = undefined
    st.proc?.kill('SIGKILL')
    st.proc = null
    if (streams.get(st.src.pane) === st) streams.delete(st.src.pane)
  }

  /** A key frame for whoever waits for one: the encoder started again, now or when its turn comes. */
  function keyFrame(st: Stream): void {
    if (st.again !== undefined || st.ending) return
    // a start whose key frame has not come yet brings one anyway
    if (!st.keyed) return
    const wait = Math.max(0, st.startedAt + MIN_RESTART_MS - sys.now())
    st.again = sys.setTimeout(() => {
      st.again = undefined
      if (st.ending || streams.get(st.src.pane) !== st) return
      st.proc?.kill('SIGKILL')
      st.proc = null
      void start(st)
    }, wait)
  }

  return {
    available: () => sys.which('ffmpeg') !== null,

    join(src, viewer) {
      let st = streams.get(src.pane)
      if (!st) {
        st = {
          src,
          viewers: new Map(),
          proc: null,
          gen: 0,
          keyed: false,
          seq: 0,
          startedAt: 0,
          again: undefined,
          ending: false,
        }
        streams.set(src.pane, st)
        st.viewers.set(viewer, { waitKey: true, behind: false, flight: [] })
        o.log(`desktop :${src.display}: video for its viewers`)
        void start(st)
        return
      }
      st.viewers.set(viewer, { waitKey: true, behind: false, flight: [] })
      keyFrame(st)
    },

    leave(pane, viewer) {
      const st = streams.get(pane)
      if (!st?.viewers.delete(viewer) || st.viewers.size) return
      halt(st)
      o.log(`desktop :${st.src.display}: video stopped (no viewer)`)
    },

    message(pane, viewer, text) {
      const st = streams.get(pane)
      const seat = st?.viewers.get(viewer)
      const says = readViewerText(text)
      if (!st || !seat || !says) return
      if ('key' in says) {
        seat.waitKey = true
        keyFrame(st)
        return
      }
      seat.flight = seat.flight.filter(f => f.seq > says.ack)
      // caught up after it was behind: a key frame to go on from
      if (seat.behind && seat.flight.length <= LOW_AHEAD) keyFrame(st)
    },

    stop(pane) {
      const st = streams.get(pane)
      if (!st) return
      halt(st)
      for (const viewer of st.viewers.keys()) viewer.close(1001, 'stopped')
      st.viewers.clear()
    },

    stopAll() {
      for (const pane of [...streams.keys()]) this.stop(pane)
    },

    running: () => [...streams.values()].filter(s => s.proc !== null).length,
  }
}
