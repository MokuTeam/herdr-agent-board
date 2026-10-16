// The React board bundles in the browser target the server uses (served from Task 27 on), and the
// old page it replaces still does.
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createWebBundle } from '../../src/server/web-bundle.ts'

const ROOT = join(import.meta.dir, '..', '..')

for (const entry of [join('web', 'src', 'main.tsx'), join('web', 'app.js')])
  test(`${entry} bundles`, async () => {
    const logs: string[] = []
    const bundle = await createWebBundle({ root: ROOT, entry: join(ROOT, entry), log: text => logs.push(text) })
    expect(logs).toEqual([])
    expect(bundle.js()).toContain('limits-pop')
    expect(bundle.js()).not.toMatch(/^import .* from ['"]\.{1,2}\//m)
  })
