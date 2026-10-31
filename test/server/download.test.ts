// GET /api/fs/download: any file the quick look can reach, saved on the viewer's device (the board
// seen from another computer), behind the same per-run token as the raw bytes.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attachment } from '../../src/server/routes/fs.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

const BYTES = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) & 0xff))

describe('file downloads', () => {
  const sandbox = sharedSandbox()
  let files = ''
  let token = ''
  let get: (path: string, t?: string, headers?: Record<string, string>) => Promise<Response>
  beforeAll(async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { error: 'offline' } })
    files = join(box.dir, 'files')
    mkdirSync(join(files, 'sub'), { recursive: true })
    writeFileSync(join(files, 'build.tar.zst'), BYTES)
    writeFileSync(join(files, 'Отчёт за май 100%.txt'), 'привет')
    writeFileSync(join(files, 'page.html'), '<script>alert(1)</script>')
    writeFileSync(join(files, 'empty.bin'), '')
    const { url } = await serveBoard(box)
    token = ((await (await fetch(`${url}/api/board`)).json()) as { fsToken: string }).fsToken
    get = (path, t = token, headers = {}) =>
      fetch(`${url}/api/fs/download?path=${encodeURIComponent(path)}&t=${encodeURIComponent(t)}`, { headers })
  }, 20_000)

  test('a file that is not media comes whole as an attachment, never shown inline', async () => {
    const res = await get(join(files, 'build.tar.zst'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="build.tar.zst"; filename*=UTF-8''build.tar.zst`,
    )
    expect(res.headers.get('content-length')).toBe(String(BYTES.length))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-range')).toBe(null)
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true)
  })

  test('a Cyrillic name with spaces and % keeps its name in filename*, an ASCII stand-in in filename', async () => {
    const res = await get(join(files, 'Отчёт за май 100%.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="_____ __ ___ 100_.txt"; filename*=UTF-8''${encodeURIComponent('Отчёт за май 100%.txt')}`,
    )
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength('привет')))
    expect(await res.text()).toBe('привет')
  })

  test('HTML goes as bytes to save, not as a page on this origin', async () => {
    const res = await get(join(files, 'page.html'))
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toStartWith('attachment;')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
  })

  test('an empty file is an empty attachment', async () => {
    const res = await get(join(files, 'empty.bin'))
    expect([res.status, res.headers.get('content-length'), await res.text()]).toEqual([200, '0', ''])
  })

  test('a folder, a missing file and a path the board cannot resolve answer 404 as raw does', async () => {
    for (const path of [files, join(files, 'sub'), join(files, 'nope.txt'), 'relative/build.tar.zst', '']) {
      const res = await get(path)
      expect([path, res.status, await res.json()]).toEqual([path, 404, { error: 'not found' }])
    }
  })

  test('without the token: 403, nothing of the file', async () => {
    const res = await get(join(files, 'build.tar.zst'), 'wrong')
    expect([res.status, res.headers.get('content-disposition')]).toEqual([403, null])
  })
})

test('Content-Disposition: quotes, backslashes and RFC 5987 specials are escaped', () => {
  expect(attachment('a "b"\\c.txt')).toBe(`attachment; filename="a _b__c.txt"; filename*=UTF-8''a%20%22b%22%5Cc.txt`)
  expect(attachment("it's (1)*.md")).toBe(
    `attachment; filename="it's (1)*.md"; filename*=UTF-8''it%27s%20%281%29%2A.md`,
  )
  expect(attachment('日本.pdf')).toBe(`attachment; filename="__.pdf"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf`)
})
