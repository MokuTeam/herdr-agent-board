// The React board bundles for the browser as the server bundles it (src/server/app.ts), in
// React's production build, with no import left for the browser to resolve.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
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
  expect(bundle.js()).toContain('react-dom-client.production')
  expect(bundle.js()).not.toContain('react-dom-client.development')
  expect(bundle.js()).not.toMatch(/^import .* from ['"]\.{1,2}\//m)
})
