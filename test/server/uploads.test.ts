// Files sent to sessions from the board: stored under uploads/<day>/, served back inline for
// raster images and as downloads otherwise, never over 30 MB.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

type Upload = { ok: boolean; path: string; name: string; size: number; url: string; error?: string }

describe('uploads', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let uploads = ''
  const upload = (name: string, body: BodyInit, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/upload`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(name), ...headers },
      body,
    })

  beforeAll(async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { error: 'offline' } })
    uploads = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/uploads')
    ;({ url } = await serveBoard(box))
  }, 20_000)

  test('an image: stored under the day with a safe name, then shown inline', async () => {
    const res = await upload('Скрин шот (1).png', new Uint8Array([1, 2, 3]))
    expect(res.status).toBe(200)
    const r = (await res.json()) as Upload
    const day = new Date().toISOString().slice(0, 10)
    expect(r.ok).toBe(true)
    expect(r.size).toBe(3)
    expect(r.name).toMatch(/^\d{6}-Скрин-шот-1\.png$/)
    expect(r.path).toBe(join(uploads, day, r.name))
    expect(r.url).toBe(`/uploads/${day}/${encodeURIComponent(r.name)}`)
    expect([...readFileSync(r.path)]).toEqual([1, 2, 3])
    const back = await fetch(url + r.url)
    expect(back.status).toBe(200)
    expect(back.headers.get('content-type')).toBe('image/png')
    expect(back.headers.get('content-disposition')).toBe('inline')
    expect(back.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(back.headers.get('x-content-type-options')).toBe('nosniff')
    expect(back.headers.get('cache-control')).toBe('private, max-age=86400')
    expect([...new Uint8Array(await back.arrayBuffer())]).toEqual([1, 2, 3])
  })

  test('anything else only downloads; unsafe or unknown names are not found', async () => {
    const r = (await (await upload('../page.html', '<script>alert(1)</script>')).json()) as Upload
    expect(r.name).toMatch(/^\d{6}-page\.html$/)
    const back = await fetch(url + r.url)
    expect(back.headers.get('content-type')).toBe('application/octet-stream')
    expect(back.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(r.name)}`)
    const day = r.url.split('/')[2]
    for (const path of [`/uploads/${day}/a%20b.png`, `/uploads/${day}/missing.png`, '/uploads/2020-1-1/x.png'])
      expect([path, (await fetch(url + path)).status]).toEqual([path, 404])
  })

  test('the header guard, and no name at all', async () => {
    expect((await upload('x.png', 'x', {})).status).toBe(403)
    const res = await fetch(`${url}/api/upload`, { method: 'POST', headers: { 'x-board': '1' }, body: '' })
    const r = (await res.json()) as Upload
    expect([res.status, r.size]).toEqual([200, 0])
    expect(r.name).toMatch(/^\d{6}-file$/)
  })

  test('over 30 MB: 413 with the reason, and nothing left on disk', async () => {
    const before = existsSync(uploads) ? readdirSync(uploads, { recursive: true }).length : 0
    const res = await upload('big.bin', new Uint8Array((30 << 20) + 1))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ ok: false, error: 'File larger than 30 MB' })
    expect(readdirSync(uploads, { recursive: true }).length).toBe(before)
  }, 20_000)
})
