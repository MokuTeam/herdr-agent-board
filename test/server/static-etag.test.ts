// The page's files and their ETag (routes/static.ts): a new build is a new tag, and the tag the
// browser kept from the old one gets the whole new file, not a 304.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../../src/server/http.ts'
import { matchesTag, staticRoute } from '../../src/server/routes/static.ts'

describe('the static route by ETag', () => {
  test('a new build or a changed file: a new tag, and the old one no longer answers 304', async () => {
    const web = mkdtempSync(join(tmpdir(), 'board-static-'))
    writeFileSync(join(web, 'icon.svg'), '<svg>one</svg>')
    let js = 'console.log(1)'
    const route = staticRoute(web, { js: () => js, map: () => '{}', early: () => '' })
    const get = async (path: string, ifNoneMatch?: string) =>
      (await route.handle(
        new Request(`http://127.0.0.1${path}`, { headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {} }),
        { path } as RouteContext,
      )) as Response

    const first = (await get('/app.js')).headers.get('etag') ?? ''
    expect((await get('/app.js', first)).status).toBe(304)
    js = 'console.log(2)'
    const rebuilt = await get('/app.js', first)
    expect(rebuilt.status).toBe(200)
    expect(await rebuilt.text()).toBe('console.log(2)')
    expect(rebuilt.headers.get('etag')).not.toBe(first)

    const icon = (await get('/icon.svg')).headers.get('etag') ?? ''
    expect((await get('/icon.svg', icon)).status).toBe(304)
    writeFileSync(join(web, 'icon.svg'), '<svg>two</svg>')
    expect((await get('/icon.svg', icon)).status).toBe(200)
  })

  test('If-None-Match: one of its tags, weakly compared, or *', () => {
    expect(matchesTag('"a"', '"a"')).toBe(true)
    expect(matchesTag('W/"a"', '"a"')).toBe(true)
    expect(matchesTag(' "b" ,"a"', '"a"')).toBe(true)
    expect(matchesTag('*', '"a"')).toBe(true)
    expect(matchesTag('"b"', '"a"')).toBe(false)
    expect(matchesTag('"a-br"', '"a"')).toBe(false)
    expect(matchesTag('', '"a"')).toBe(false)
    expect(matchesTag(null, '"a"')).toBe(false)
  })
})

// The quick look's viewers (#176): their scripts from the bundle, compressed and tagged as app.js
// is; a package's folders by name, nothing around them; the page's policy as it was.
describe('the static route for the viewers', () => {
  test('a viewer and its worker from the bundle, what it loads from its package, nothing else', async () => {
    const web = mkdtempSync(join(tmpdir(), 'board-static-'))
    writeFileSync(join(web, 'index.html'), '<html></html>')
    const pkg = mkdtempSync(join(tmpdir(), 'board-pkg-'))
    mkdirSync(join(pkg, 'wasm'))
    writeFileSync(join(pkg, 'wasm', 'jbig2.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]))
    writeFileSync(join(pkg, 'package.json'), '{"name":"secret"}')
    const files: Record<string, string> = { 'pdf-viewer.js': 'export const mount = 1', 'pdf.worker.js': 'self.x = 1' }
    const route = staticRoute(
      web,
      { js: () => 'app', map: () => '{}', early: () => '', file: name => files[name] },
      undefined,
      { 'pdfjs/wasm': join(pkg, 'wasm') },
    )
    const get = async (address: string, headers: Record<string, string> = {}) => {
      const url = new URL(`http://127.0.0.1${address}`)
      return (await route.handle(new Request(url, { headers }), { path: url.pathname } as RouteContext)) as Response
    }

    const viewer = await get('/pdf-viewer.js', { 'accept-encoding': 'br' })
    expect(viewer.status).toBe(200)
    expect(viewer.headers.get('content-encoding')).toBe('br')
    expect(viewer.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const tag = viewer.headers.get('etag') ?? ''
    expect((await get('/pdf-viewer.js', { 'accept-encoding': 'br', 'if-none-match': tag })).status).toBe(304)
    expect(await (await get('/pdf.worker.js')).text()).toBe('self.x = 1')
    expect((await get('/pdf-viewer.js?v=abc')).status).toBe(200)

    const wasm = await get('/pdfjs/wasm/jbig2.wasm')
    expect(wasm.status).toBe(200)
    expect(wasm.headers.get('content-type')).toBe('application/wasm')
    expect([...new Uint8Array(await wasm.arrayBuffer())]).toEqual([0, 0x61, 0x73, 0x6d])
    for (const outside of ['/pdfjs/package.json', '/pdfjs/cmaps/x.bcmap', '/pdfjs/wasm/x/y.wasm', '/src/main.tsx'])
      expect((await get(outside)).status).toBe(404)

    const page = await get('/')
    expect(page.headers.get('content-security-policy')).toBe(
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    )
  })
})
