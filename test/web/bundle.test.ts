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

// The quick look's PDF viewer (#176) is a script of its own: app.js carries none of PDF.js, and
// imports the viewer by a URL it makes when a PDF is opened.
test('the PDF viewer and its worker build apart from app.js', async () => {
  const logs: string[] = []
  const bundle = await createWebBundle({
    root: ROOT,
    entry: join(ROOT, 'web', 'src', 'main.tsx'),
    viewers: viewerEntries(join(ROOT, 'web')),
    copies: VIEWER_COPIES,
    log: text => logs.push(text),
  })
  expect(logs).toEqual([])
  const { sources } = JSON.parse(bundle.map()) as { sources: string[] }
  expect(sources.some(s => s.includes('pdfjs-dist'))).toBe(false)
  expect(sources.some(s => s.endsWith('viewers/pdf.ts'))).toBe(false)
  const viewer = bundle.file('pdf-viewer.js') ?? ''
  const own = JSON.parse(bundle.file('pdf-viewer.js.map') ?? '{}') as { sources: string[] }
  expect(own.sources.some(s => s.includes('pdfjs-dist'))).toBe(true)
  expect(viewer).not.toMatch(/^import .* from /m)
  expect(bundle.file('pdf.worker.js')).toContain('WorkerMessageHandler')
})
