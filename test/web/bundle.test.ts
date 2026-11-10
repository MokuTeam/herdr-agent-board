// The React board bundles for the browser as the server bundles it (src/server/app.ts), in
// React's production build, with no import left for the browser to resolve.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { VIEWER_COPIES, viewerEntries } from '../../src/server/viewers.ts'
import { createWebBundle } from '../../src/server/web-bundle.ts'

const ROOT = join(import.meta.dir, '..', '..')

test('web/src/main.tsx bundles', async () => {
  const logs: string[] = []
  const bundle = await createWebBundle({
    root: ROOT,
    entry: join(ROOT, 'web', 'src', 'main.tsx'),
    log: text => logs.push(text),
  })
  expect(logs).toEqual([])
  expect(bundle.js()).toContain('limits-pop')
  expect(bundle.js()).not.toContain('react-dom-client.development')
  // What went into it, by its source map: the minified script names no files.
  const { sources } = JSON.parse(bundle.map()) as { sources: string[] }
  expect(sources.some(s => s.endsWith('react-dom-client.production.js'))).toBe(true)
  expect(sources.some(s => s.includes('react-dom-client.development'))).toBe(false)
  expect(bundle.js()).not.toMatch(/^import .* from ['"]\.{1,2}\//m)
})

// The quick look's viewers (#176) are scripts of their own: app.js carries none of their
// libraries, and imports a viewer by a URL it makes when such a file is opened.
test('every viewer builds apart from app.js, which carries none of their libraries', async () => {
  const logs: string[] = []
  const bundle = await createWebBundle({
    root: ROOT,
    entry: join(ROOT, 'web', 'src', 'main.tsx'),
    viewers: viewerEntries(join(ROOT, 'web')),
    copies: VIEWER_COPIES,
    log: text => logs.push(text),
  })
  expect(logs).toEqual([])
  const sourcesOf = (map: string | Buffer | undefined) =>
    (JSON.parse(String(map ?? '{}')) as { sources: string[] }).sources
  const page = new Set(sourcesOf(bundle.map()))
  for (const name of Object.keys(viewerEntries(join(ROOT, 'web')))) {
    const script = String(bundle.file(name) ?? '')
    expect([name, script.length > 0]).toEqual([name, true])
    expect(script).not.toMatch(/^import .* from /m)
    // What a viewer bundles from its packages, app.js has none of.
    const packages = sourcesOf(bundle.file(`${name}.map`)).filter(s => s.includes('node_modules'))
    expect([name, packages.filter(s => page.has(s))]).toEqual([name, []])
  }
  expect([...page].some(s => s.includes('viewers/'))).toBe(false)
  for (const name of Object.keys(VIEWER_COPIES)) expect(bundle.file(name)?.length).toBeGreaterThan(0)
  expect(String(bundle.file('pdf.worker.js'))).toContain('WorkerMessageHandler')
  // Each library in the one script that needs it: PDF.js in the PDF viewer, DOMPurify where the
  // document is drawn, mammoth and SheetJS in their workers.
  const has = (name: string, lib: string) => sourcesOf(bundle.file(`${name}.map`)).some(s => s.includes(lib))
  expect(has('pdf-viewer.js', 'pdfjs-dist')).toBe(true)
  expect([has('document-viewer.js', 'dompurify'), has('document-viewer.js', 'mammoth')]).toEqual([true, false])
  expect([has('document-worker.js', 'mammoth'), has('document-worker.js', 'dompurify')]).toEqual([true, false])
  expect([has('spreadsheet-worker.js', 'xlsx'), has('spreadsheet-viewer.js', 'xlsx')]).toEqual([true, false])
})

// The page imports the peer network's wire constants (#231) from team-wire.ts, which has no node:
// import and no Buffer; importing src/core/team.ts would bundle a crypto shim for every setup.
test('the page bundle carries no node:crypto shim and nothing of src/core/team.ts', async () => {
  const bundle = await createWebBundle({
    root: ROOT,
    entry: join(ROOT, 'web', 'src', 'main.tsx'),
    log: () => {},
  })
  const { sources } = JSON.parse(bundle.map()) as { sources: string[] }
  const shim = sources.filter(s =>
    /crypto-browserify|create-hash|browserify|node_modules\/buffer\/|core\/team\.ts$/.test(s),
  )
  expect(shim).toEqual([])
  expect(bundle.js()).not.toContain('crypto-browserify')
})
