// An agent's display as H.264 video (services/desktop-video.ts on the server, models/desk-video.ts
// in the page), the way a remote desktop's app shows one: ffmpeg grabs the X display (x11grab, its
// pointer drawn in) and libx264 encodes it for latency (ultrafast, zerolatency: no B-frames, no
// lookahead, each frame out as soon as it is made), 30 frames a second, at most 8 Mbit/s. One
// key frame, at the start: the link is TCP and loses nothing, so the next one is made only when a
// viewer needs one (a new viewer, a decoder that starts again), by starting the encoder again.
//
// ffmpeg writes FLV on its stdout rather than raw Annex B: an FLV tag says how long it is, so each
// frame is cut off the moment it is all there; in raw Annex B a frame's end is known only when the
// next one begins, a frame (33 ms) later. The board makes each frame Annex B again (its NAL units
// with start codes, a key frame with its SPS and PPS ahead), and sends it as one WebSocket message:
// a byte of flags (1: a key frame), its number (32 bits, big-endian), then the frame. The page
// answers each with its number (`a<n>`): the board sends a viewer no more than it can take (its
// link backs up: it waits for a key frame); and asks for a key frame with `k`.
//
// Here: ffmpeg's arguments, the FLV reader, the messages both ways, a frame's codec string. Pure,
// with no node: import (the page uses it too).
import { SCREEN } from './desktop.ts'

/** Frames a second: 60 does not keep up on one core (the grab, the colours and x264 take their turn). */
export const VIDEO_FPS = 30
/** x264's quality (lower is better): text crisp once still; while it moves the ceiling below sets it. */
export const VIDEO_CRF = 23
/** At most this many bits a second, and in a quarter second's buffer: a frame never much more than 250 KB. */
export const VIDEO_MAXRATE = '8M'
export const VIDEO_BUFSIZE = '2M'
/** x264's threads (slices of a frame, each on a core of its own: no frame waits for another). */
export const VIDEO_THREADS = 4

/**
 * ffmpeg's arguments for the display `:display` (its cookie in XAUTHORITY): x11grab at VIDEO_FPS,
 * the whole screen and the pointer; its colours made BT.709 4:2:0 by zimg where ffmpeg has it
 * (`zscale`: three times swscale's speed, which does not keep 30 a second at this size on an arm64
 * core), else by swscale; libx264 constrained baseline (any decoder, Safari's hardware too), one
 * key frame; FLV on stdout, each frame written out as it is made.
 */
export function ffmpegArgs(o: { display: number; zscale: boolean }): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    // a live display: nothing to probe, nothing held back
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-fflags',
    'nobuffer',
    '-f',
    'x11grab',
    '-framerate',
    String(VIDEO_FPS),
    '-video_size',
    `${SCREEN.width}x${SCREEN.height}`,
    '-draw_mouse',
    '1',
    '-i',
    `:${o.display}`,
    '-an',
    '-vf',
    o.zscale ? 'zscale=m=709:r=limited,format=yuv420p' : 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-profile:v',
    'baseline',
    '-bf',
    '0',
    '-x264-params',
    'keyint=infinite:scenecut=0',
    '-crf',
    String(VIDEO_CRF),
    '-maxrate',
    VIDEO_MAXRATE,
    '-bufsize',
    VIDEO_BUFSIZE,
    '-threads',
    String(VIDEO_THREADS),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-flush_packets',
    '1',
    '-flvflags',
    'no_duration_filesize',
    '-f',
    'flv',
    'pipe:1',
  ]
}

/** A frame (an access unit) in Annex B; `key`: an IDR, its SPS and PPS ahead of it. */
export interface VideoUnit {
  key: boolean
  data: Uint8Array
}

const START = Uint8Array.of(0, 0, 0, 1)
const nalType = (nal: Uint8Array): number => (nal[0] ?? 0) & 0x1f
const NAL_IDR = 5
const NAL_SPS = 7
const NAL_PPS = 8

function annexB(nals: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nals.reduce((n, nal) => n + START.length + nal.length, 0))
  let at = 0
  for (const nal of nals) {
    out.set(START, at)
    out.set(nal, at + START.length)
    at += START.length + nal.length
  }
  return out
}

/**
 * ffmpeg's FLV (its stdout) read as it comes, into frames: each call takes the bytes that came and
 * returns the frames now whole, in order. The AVC sequence header gives the SPS and PPS and the
 * length of each NAL unit's size; a frame's NAL units come with their sizes. Null, from then on:
 * not FLV, or not H.264 in it.
 */
export function flvUnits(): (bytes: Uint8Array) => VideoUnit[] | null {
  let buf: Uint8Array = new Uint8Array(0)
  let header = true
  let failed = false
  let params: Uint8Array[] = []
  let lengthSize = 4
  const fail = (): null => {
    failed = true
    return null
  }
  /** The AVCDecoderConfigurationRecord: its SPS and PPS, and the size of a NAL unit's length. */
  const config = (c: Uint8Array): boolean => {
    if (c.length < 7 || c[0] !== 1) return false
    lengthSize = ((c[4] as number) & 3) + 1
    const out: Uint8Array[] = []
    let at = 5
    for (const mask of [0x1f, 0xff]) {
      const n = ((c[at] as number) ?? 0) & mask
      at++
      for (let i = 0; i < n; i++) {
        const len = (((c[at] as number) ?? 0) << 8) | ((c[at + 1] as number) ?? 0)
        if (at + 2 + len > c.length) return false
        out.push(c.slice(at + 2, at + 2 + len))
        at += 2 + len
      }
    }
    params = out
    return true
  }
  /** A frame's NAL units, each after its length; null when they do not add up. */
  const units = (p: Uint8Array): Uint8Array[] | null => {
    const out: Uint8Array[] = []
    let at = 0
    while (at < p.length) {
      if (at + lengthSize > p.length) return null
      let len = 0
      for (let i = 0; i < lengthSize; i++) len = len * 256 + (p[at + i] as number)
      at += lengthSize
      if (at + len > p.length) return null
      if (len) out.push(p.subarray(at, at + len))
      at += len
    }
    return out
  }
  return bytes => {
    if (failed) return null
    if (buf.length) {
      const joined = new Uint8Array(buf.length + bytes.length)
      joined.set(buf)
      joined.set(bytes, buf.length)
      buf = joined
    } else buf = bytes
    const out: VideoUnit[] = []
    let at = 0
    if (header) {
      if (buf.length < 9) return out
      if (buf[0] !== 0x46 || buf[1] !== 0x4c || buf[2] !== 0x56) return fail()
      const size =
        (((buf[5] as number) << 24) | ((buf[6] as number) << 16) | ((buf[7] as number) << 8) | (buf[8] as number)) >>> 0
      // the header, then the first tag's "previous tag size" (0)
      if (buf.length < size + 4) return out
      at = size + 4
      header = false
    }
    while (buf.length - at >= 11) {
      const type = (buf[at] as number) & 0x1f
      const size = ((buf[at + 1] as number) << 16) | ((buf[at + 2] as number) << 8) | (buf[at + 3] as number)
      if (buf.length - at < 11 + size + 4) break
      const body = buf.subarray(at + 11, at + 11 + size)
      at += 11 + size + 4
      // video only (ffmpeg writes its metadata first, a script tag)
      if (type !== 9 || body.length < 5) continue
      if (((body[0] as number) & 0x0f) !== 7) return fail()
      const payload = body.subarray(5)
      if (body[1] === 0) {
        if (!config(payload)) return fail()
        continue
      }
      if (body[1] !== 1) continue
      const nals = units(payload)
      if (!nals) return fail()
      if (!nals.length) continue
      const key = nals.some(n => nalType(n) === NAL_IDR)
      const own = nals.some(n => nalType(n) === NAL_SPS)
      out.push({ key, data: annexB(key && !own ? [...params, ...nals] : nals) })
    }
    // what is left waits in a copy of its own: the chunk's buffer is the stream's
    buf = at >= buf.length ? new Uint8Array(0) : buf.slice(at)
    return out
  }
}

/** A frame's message's flags: a key frame. */
export const VIDEO_KEY = 1
const HEAD = 5

/** The WebSocket message of frame `seq`: its flags, its number, the frame. */
export function videoMessage(seq: number, unit: VideoUnit): Uint8Array {
  const out = new Uint8Array(HEAD + unit.data.length)
  out[0] = unit.key ? VIDEO_KEY : 0
  out[1] = (seq >>> 24) & 255
  out[2] = (seq >>> 16) & 255
  out[3] = (seq >>> 8) & 255
  out[4] = seq & 255
  out.set(unit.data, HEAD)
  return out
}

/** A frame's message read: null for one too short to be one. */
export function readVideoMessage(bytes: Uint8Array): { key: boolean; seq: number; data: Uint8Array } | null {
  if (bytes.length <= HEAD) return null
  const seq =
    (((bytes[1] as number) << 24) |
      ((bytes[2] as number) << 16) |
      ((bytes[3] as number) << 8) |
      (bytes[4] as number)) >>>
    0
  return { key: ((bytes[0] as number) & VIDEO_KEY) !== 0, seq, data: bytes.subarray(HEAD) }
}

/** The NAL units of an Annex B frame (after 00 00 01 or 00 00 00 01). */
export function annexBUnits(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; from: number }[] = []
  for (let i = 0; i + 2 < data.length; i++)
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push({ at: i > 0 && data[i - 1] === 0 ? i - 1 : i, from: i + 3 })
      i += 2
    }
  return starts.map((s, n) => data.subarray(s.from, starts[n + 1]?.at ?? data.length))
}

/**
 * The codec string (`avc1.PPCCLL`: profile, constraints, level, in hex) of a frame's SPS, as
 * WebCodecs takes it; null for a frame without one (not a key frame).
 */
export function avcCodec(data: Uint8Array): string | null {
  const sps = annexBUnits(data).find(n => nalType(n) === NAL_SPS && n.length >= 4)
  if (!sps) return null
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0')
  return `avc1.${hex(sps[1] as number)}${hex(sps[2] as number)}${hex(sps[3] as number)}`
}

/** A key frame's SPS and PPS are what a decoder needs first: whether this frame has both. */
export const hasParams = (data: Uint8Array): boolean => {
  const types = annexBUnits(data).map(nalType)
  return types.includes(NAL_SPS) && types.includes(NAL_PPS)
}

/** What the page says on the video's socket: frame `seq` came; or a key frame, please. */
export type ViewerSays = { ack: number } | { key: true }

export const ackText = (seq: number): string => `a${seq}`
export const KEY_TEXT = 'k'

/** A text from the page read; null for anything else. */
export function readViewerText(text: string): ViewerSays | null {
  if (text === KEY_TEXT) return { key: true }
  const m = /^a(\d{1,10})$/.exec(text)
  return m ? { ack: Number(m[1]) } : null
}
