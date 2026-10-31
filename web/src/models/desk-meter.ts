// How the link to an agent's display goes while its view is open (hooks/useDesktop.ts): the round
// trip to the server (the VNC client's pings, models/rfb.ts), the frames a second the picture got,
// and JPEG's quality asked for. Shown small in the picture's corner; once a minute a line of it for
// the board's log, so the owner's real latency can be read there without them.

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

  /** A ping's answer: the round trip, in ms. */
  pong(ms: number): void {
    this.recent = [...this.recent, ms].slice(-SHOWN)
    this.trips.push(ms)
  }

  /** A frame (an update) came. */
  frame(): void {
    this.frames++
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

  /** What the corner shows: "42 ms · 24 fps · q6". */
  text(quality: number): string {
    return `${this.rtt() ?? '–'} ms · ${this.fps} fps · q${quality}`
  }

  /** A minute went by: its line for the board's log, or null when nothing came in it. */
  minute(what: { key: string; quality: number; mbps: number }): string | null {
    const { trips, seconds } = this
    this.trips = []
    this.seconds = []
    if (!trips.length && !seconds.length) return null
    const rtt = trips.length
      ? `rtt median ${Math.round(median(trips))} ms (min ${Math.round(Math.min(...trips))}, max ${Math.round(Math.max(...trips))}, ${trips.length} pings)`
      : 'rtt –'
    const fps = seconds.length
      ? `fps median ${median(seconds)} (max ${Math.max(...seconds)}, ${seconds.length} s with frames)`
      : 'no frames'
    const link = what.mbps ? `, link ${what.mbps.toFixed(1)} Mbit/s` : ''
    return `browser view ${what.key}: ${rtt}, ${fps}, JPEG q${what.quality}${link}`
  }
}
