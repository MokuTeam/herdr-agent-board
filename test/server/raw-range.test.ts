// Byte ranges of /api/fs/raw, pinned to what main's server (94fdde6) answers: one `bytes=a-b`,
// `bytes=a-` or `bytes=-n` range, the end clamped to the file, 416 when it starts past the end, and
// the whole file for anything else (Bun.serve would range some of those by itself).
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

const BYTES = Buffer.from(Array.from({ length: 100 }, (_, i) => i))

describe('raw file ranges', () => {
  const sandbox = sharedSandbox()
  let raw: (name: string, range?: string) => Promise<Response>
  beforeAll(async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { error: 'offline' } })
    const files = join(box.dir, 'files')
    mkdirSync(files)
    writeFileSync(join(files, 'clip.mp4'), BYTES)
    writeFileSync(join(files, 'empty.mp4'), '')
    writeFileSync(join(files, 'doc.pdf'), '%PDF-1.4')
    const { url } = await serveBoard(box)
    const { fsToken } = (await (await fetch(`${url}/api/board`)).json()) as { fsToken: string }
    raw = (name, range) =>
      fetch(`${url}/api/fs/raw?path=${encodeURIComponent(join(files, name))}&t=${fsToken}`, {
        headers: range === undefined ? {} : { range },
      })
  }, 20_000)

  const bytesOf = async (res: Response) => [...new Uint8Array(await res.arrayBuffer())]

  test('bytes=0-9 of 100 bytes: 206, its Content-Range and the 10 bytes', async () => {
    const res = await raw('clip.mp4', 'bytes=0-9')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100')
    expect(res.headers.get('content-length')).toBe('10')
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
    )
    expect(await bytesOf(res)).toEqual([...BYTES.subarray(0, 10)])
  })

  test('bytes=200- starts past the end: 416 with bytes */100 and nothing else', async () => {
    const res = await raw('clip.mp4', 'bytes=200-')
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
    expect(res.headers.get('content-type')).toBe(null)
    expect(await bytesOf(res)).toEqual([])
  })

  test('a suffix range, an end past the file, and ranges that cannot be met', async () => {
    const suffix = await raw('clip.mp4', 'bytes=-10')
    expect([suffix.status, suffix.headers.get('content-range')]).toEqual([206, 'bytes 90-99/100'])
    expect(await bytesOf(suffix)).toEqual([...BYTES.subarray(90)])
    const clamped = await raw('clip.mp4', 'bytes=90-500')
    expect([clamped.status, clamped.headers.get('content-range')]).toEqual([206, 'bytes 90-99/100'])
    expect(await bytesOf(clamped)).toEqual([...BYTES.subarray(90)])
    const open = await raw('clip.mp4', 'bytes=95-')
    expect([open.status, open.headers.get('content-range')]).toEqual([206, 'bytes 95-99/100'])
    for (const range of ['bytes=-0', 'bytes=5-3']) {
      const res = await raw('clip.mp4', range)
      expect([range, res.status, res.headers.get('content-range')]).toEqual([range, 416, 'bytes */100'])
    }
  })

  test('no range, or one main does not read, gives the whole file', async () => {
    for (const range of [undefined, 'Bytes=0-9', 'bytes= 0-9', 'bytes=0-1,3-4', 'bytes=-', 'items=0-9']) {
      const res = await raw('clip.mp4', range)
      expect([range, res.status, res.headers.get('content-length'), res.headers.get('content-range')]).toEqual([
        range,
        200,
        '100',
        null,
      ])
      expect(await bytesOf(res)).toEqual([...BYTES])
    }
  })

  test('an empty file: 200 with no body, 416 for any range; a PDF gets its own policy', async () => {
    const empty = await raw('empty.mp4')
    expect([empty.status, empty.headers.get('content-length')]).toEqual([200, '0'])
    expect(await bytesOf(empty)).toEqual([])
    const ranged = await raw('empty.mp4', 'bytes=0-')
    expect([ranged.status, ranged.headers.get('content-range')]).toEqual([416, 'bytes */0'])
    const pdf = await raw('doc.pdf')
    expect(pdf.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'self'")
  })
})
