// How the link to an agent's display goes while its view is open (hooks/useDesktop.ts): the round
// trip to the server (the VNC client's pings, models/rfb.ts), the frames a second the picture got,
// and what the picture comes by: `h264` (video, models/desk-video.ts) or `vnc` with JPEG's quality
// asked for. Shown small in the picture's corner; once a minute a line of it for the board's log,
// so the owner's real latency can be read there without them.

/** What the picture comes by: H.264 video, VNC's pictures, or not known yet (null). */
export type MeterVia = 'h264' | 'vnc' | null

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** The round trips shown are the median of this many last ones: one slow answer does not jump it. */
const SHOWN = 5

export class DeskMeter {
  /** Frames a second, in the last whole second. */
  fps = 0
  private frames = 0
  private recent: number[] = []
  /** This minute's round trips, and its seconds' frames (the seconds that had any). */
  private trips: number[] = []
  private seconds: number[] = []
  /** This minute's video bytes. */
  private videoBytes = 0

  /** A ping's answer: the round trip, in ms. */
  pong(ms: number): void {
    this.recent = [...this.recent, ms].slice(-SHOWN)
    this.trips.push(ms)
  }

  /** A frame (an update, or a video frame drawn) came. */
  frame(): void {
    this.frames++
  }

  /** Video's bytes came (a frame's message). */
  bytes(n: number): void {
    this.videoBytes += n
  }

  /** A second went by. */
  second(): void {
    this.fps = this.frames
    if (this.frames) this.seconds.push(this.frames)
    this.frames = 0
  }

  /** The round trip shown (ms), null before any answer. */
  rtt(): number | null {
    return this.recent.length ? Math.round(median(this.recent)) : null
  }

  /** What the corner shows: "42 ms · 30 fps · h264", "42 ms · 24 fps · vnc q6", "– ms · 0 fps" before it is known. */
  text(via: MeterVia, quality: number): string {
    const by = via === 'h264' ? ' · h264' : via === 'vnc' ? ` · vnc q${quality}` : ''
    return `${this.rtt() ?? '–'} ms · ${this.fps} fps${by}`
  }

  /** A minute went by: its line for the board's log, or null when nothing came in it. */
  minute(what: { key: string; via: MeterVia; quality: number; mbps: number }): string | null {
    const { trips, seconds, videoBytes } = this
    this.trips = []
    this.seconds = []
    this.videoBytes = 0
    if (!trips.length && !seconds.length) return null
    const rtt = trips.length
      ? `rtt median ${Math.round(median(trips))} ms (min ${Math.round(Math.min(...trips))}, max ${Math.round(Math.max(...trips))}, ${trips.length} pings)`
      : 'rtt –'
    const fps = seconds.length
      ? `fps median ${median(seconds)} (max ${Math.max(...seconds)}, ${seconds.length} s with frames)`
      : 'no frames'
    if (what.via === 'h264')
      return `browser view ${what.key}: ${rtt}, ${fps}, h264 ${((videoBytes * 8) / 60 / 1e6).toFixed(1)} Mbit/s`
    const link = what.mbps ? `, link ${what.mbps.toFixed(1)} Mbit/s` : ''
    return `browser view ${what.key}: ${rtt}, ${fps}, vnc JPEG q${what.quality}${link}`
  }
}
