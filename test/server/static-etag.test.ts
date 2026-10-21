// The page's files and their ETag (routes/static.ts): a new build is a new tag, and the tag the
// browser kept from the old one gets the whole new file, not a 304.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
