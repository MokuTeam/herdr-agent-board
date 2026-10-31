// An agent's display as H.264 video (core/desktop-video.ts): ffmpeg's arguments (x11grab, x264 for
// latency, one key frame, FLV on stdout), its FLV cut into frames in Annex B however the bytes come
// (a real stream of ffmpeg 4.4's, Ubuntu 22.04's, and ones made here), each frame's message to the
// page and back, and a key frame's codec string.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ackText,
  annexBUnits,
  avcCodec,
  ffmpegArgs,
  flvUnits,
  hasParams,
  KEY_TEXT,
  readVideoMessage,
  readViewerText,
  type VideoUnit,
  videoMessage,
} from '../../src/core/desktop-video.ts'

const u24 = (n: number) => [(n >> 16) & 255, (n >> 8) & 255, n & 255]
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const bytes = (...parts: (number | number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap(p => (typeof p === 'number' ? [p] : [...p])))
const START = [0, 0, 0, 1]

const SPS = [0x67, 0x42, 0xc0, 0x28, 0xda, 0x01]
const PPS = [0x68, 0xce, 0x3c, 0x80]
const SEI = [0x06, 0x05, 0x01, 0x80]
const IDR = [0x65, 0x88, 0x84, 0x00, 0x21]
const SLICE = [0x41, 0x9a, 0x02]

/** FLV's header and the first "previous tag size". */
const header = () => bytes(0x46, 0x4c, 0x56, 1, 1, u32(9), u32(0))
/** A tag (its type, its data), then its own size. */
const tag = (type: number, data: Uint8Array, ms = 0) =>
  bytes(type, u24(data.length), u24(ms), 0, u24(0), data, u32(11 + data.length))
/** The AVC sequence header: the SPS and the PPS, NAL units' sizes in 4 bytes. */
const sequence = () =>
  tag(9, bytes(0x17, 0, 0, 0, 0, [1, 0x42, 0xc0, 0x28, 0xff, 0xe1], 0, SPS.length, SPS, 1, 0, PPS.length, PPS))
/** A frame's tag: its NAL units, each after its size. */
const frame = (key: boolean, ...nals: number[][]) =>
  tag(9, bytes(key ? 0x17 : 0x27, 1, 0, 0, 0, ...nals.flatMap(n => [u32(n.length), n])))
const script = () => tag(18, bytes(2, 0, 10, ...new TextEncoder().encode('onMetaData'), 8, 0, 0, 0, 0, 0, 0, 9))

const flat = (units: VideoUnit[] | null) => units?.map(u => ({ key: u.key, data: [...u.data] })) ?? null

test('ffmpeg’s arguments: the display grabbed with its pointer, x264 for latency, one key frame, at most 8 Mbit/s, FLV on stdout', () => {
  const args = ffmpegArgs({ display: 104, zscale: true })
  const after = (flag: string) => args[args.indexOf(flag) + 1]
  expect(after('-f')).toBe('x11grab')
  expect(after('-i')).toBe(':104')
  expect(after('-framerate')).toBe('30')
  expect(after('-video_size')).toBe('1440x900')
  expect(after('-draw_mouse')).toBe('1')
  expect(after('-c:v')).toBe('libx264')
  expect(after('-preset')).toBe('ultrafast')
  expect(after('-tune')).toBe('zerolatency')
  expect(after('-profile:v')).toBe('baseline')
  expect(after('-bf')).toBe('0')
  expect(after('-x264-params')).toBe('keyint=infinite:scenecut=0')
  expect(after('-maxrate')).toBe('8M')
  expect(after('-bufsize')).toBe('2M')
  expect(after('-flush_packets')).toBe('1')
  expect(args.slice(-3)).toEqual(['-f', 'flv', 'pipe:1'])
  // BT.709 4:2:0 by zimg where ffmpeg has it, else by swscale; said in the stream either way
  expect(after('-vf')).toBe('zscale=m=709:r=limited,format=yuv420p')
  expect(ffmpegArgs({ display: 104, zscale: false })[args.indexOf('-vf') + 1]).toBe(
    'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
  )
  expect(after('-colorspace')).toBe('bt709')
  // nothing of the shell: one argument each, no quoting
  expect(args.every(a => !/[\s'"]/.test(a))).toBe(true)
})

test('ffmpeg’s own FLV (4.4, x264 as the board runs it): a key frame with its SPS and PPS ahead, then the deltas, in Annex B', () => {
  const flv = new Uint8Array(readFileSync(join(import.meta.dir, '../fixtures/video/x264-64x48.flv')))
  const units = flvUnits()(flv)
  expect(units?.map(u => u.key)).toEqual([true, false, false])
  const [key, delta] = units ?? []
  expect(avcCodec(key?.data as Uint8Array)).toBe('avc1.42C00A')
  expect(hasParams(key?.data as Uint8Array)).toBe(true)
  // SPS, PPS, the encoder's SEI, the IDR slice; a delta: its slice only
  expect(annexBUnits(key?.data as Uint8Array).map(n => (n[0] as number) & 0x1f)).toEqual([7, 8, 6, 5])
  expect(annexBUnits(delta?.data as Uint8Array).map(n => (n[0] as number) & 0x1f)).toEqual([1])
  expect([...(key?.data.subarray(0, 4) ?? [])]).toEqual(START)
  // the same frames however the pipe cut the bytes: one at a time
  const read = flvUnits()
  const one: VideoUnit[] = []
  for (const b of flv) one.push(...(read(Uint8Array.of(b)) ?? []))
  expect(flat(one)).toEqual(flat(units))
})

test('frames as they come: the sequence header’s SPS and PPS before each key frame, a frame cut off the moment it is whole, two in one read', () => {
  const read = flvUnits()
  expect(read(header())).toEqual([])
  expect(read(bytes(script(), sequence()))).toEqual([])
  const key = frame(true, SEI, IDR)
  // all but its last byte: nothing yet; its last: the frame
  expect(read(key.subarray(0, key.length - 1))).toEqual([])
  expect(flat(read(key.subarray(key.length - 1)))).toEqual([
    { key: true, data: [...START, ...SPS, ...START, ...PPS, ...START, ...SEI, ...START, ...IDR] },
  ])
  expect(flat(read(bytes(frame(false, SLICE), frame(false, SLICE, SLICE))))).toEqual([
    { key: false, data: [...START, ...SLICE] },
    { key: false, data: [...START, ...SLICE, ...START, ...SLICE] },
  ])
  // a key frame that brings its own SPS: not doubled
  expect(flat(read(frame(true, SPS, PPS, IDR)))).toEqual([
    { key: true, data: [...START, ...SPS, ...START, ...PPS, ...START, ...IDR] },
  ])
  // the key is the IDR slice's, not FLV's word for it
  expect(read(frame(true, SLICE))?.map(u => u.key)).toEqual([false])
})

test('not H.264 in FLV: null, and null from then on', () => {
  expect(flvUnits()(new TextEncoder().encode('ffmpeg: no such filter: zscale\n'))).toBeNull()
  const read = flvUnits()
  read(header())
  // VP6 (codec 4), not AVC
  expect(read(tag(9, bytes(0x14, 0, 0, 0, 0, 1, 2, 3)))).toBeNull()
  expect(read(frame(false, SLICE))).toBeNull()
  // a NAL unit's size past the tag's end
  const bad = flvUnits()
  bad(bytes(header(), sequence()))
  expect(bad(tag(9, bytes(0x27, 1, 0, 0, 0, u32(99), SLICE)))).toBeNull()
})

test('a frame’s message: its flags (a key frame), its number big-endian, the frame; read back; too short is none', () => {
  const unit = { key: true, data: Uint8Array.of(0, 0, 0, 1, 0x65, 1) }
  const msg = videoMessage(0x01020304, unit)
  expect([...msg]).toEqual([1, 1, 2, 3, 4, 0, 0, 0, 1, 0x65, 1])
  expect(readVideoMessage(msg)).toEqual({ key: true, seq: 0x01020304, data: unit.data })
  const delta = readVideoMessage(videoMessage(0xfffffffe, { key: false, data: Uint8Array.of(0, 0, 1, 0x41) }))
  expect(delta).toMatchObject({ key: false, seq: 0xfffffffe })
  expect(readVideoMessage(Uint8Array.of(1, 0, 0, 0, 1))).toBeNull()
})

test('a key frame’s codec string from its SPS (3- or 4-byte start codes); none without one', () => {
  expect(avcCodec(bytes(START, SPS, START, PPS, START, IDR))).toBe('avc1.42C028')
  expect(avcCodec(bytes(0, 0, 1, [0x67, 0x64, 0x00, 0x1f, 0xac], 0, 0, 1, PPS))).toBe('avc1.64001F')
  expect(avcCodec(bytes(START, SLICE))).toBeNull()
  expect(hasParams(bytes(START, SPS, START, IDR))).toBe(false)
})

test('what the page says: a frame’s number, or a key frame please; anything else is nothing', () => {
  expect(readViewerText(ackText(42))).toEqual({ ack: 42 })
  expect(readViewerText(ackText(4294967295))).toEqual({ ack: 4294967295 })
  expect(readViewerText(KEY_TEXT)).toEqual({ key: true })
  for (const text of ['', 'a', 'a-1', 'a1 ', 'kk', 'A1', 'a12345678901']) expect(readViewerText(text)).toBeNull()
})
