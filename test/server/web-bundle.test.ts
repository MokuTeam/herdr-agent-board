import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebBundle } from '../../src/server/web-bundle.ts'

function site(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'web-bundle-'))
  mkdirSync(join(root, 'web'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'web', name), text)
  return root
}

test('bundles imports into one script', async () => {
  const root = site({
    'app.js': "import { b } from './b.js'\nconsole.log(b)\n",
    'b.js': "export const b = 'marker-from-b'\n",
  })
  const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
  try {
    expect(bundle.js()).toContain('marker-from-b')
    expect(bundle.js()).not.toMatch(/^import .* from ['"]\.\//m)
  } finally {
    bundle.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps the last good bundle when a file breaks', async () => {
  const root = site({ 'app.js': "import { b } from './b.js'\nconsole.log(b)\n", 'b.js': 'export const b = 1\n' })
  const logs: string[] = []
  const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: text => logs.push(text) })
  try {
    const before = bundle.js()
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'b.js'), 'export const x = (')
    await bundle.rebuild()
    expect(bundle.js()).toBe(before)
    expect(bundle.version()).toBe(v)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.startsWith('web bundle:')).toBe(true)
  } finally {
    bundle.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('version changes when css changes', async () => {
  const root = site({ 'app.js': 'console.log(1)\n', 'index.html': '<html></html>' })
  const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
  try {
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'app.css'), 'body { color: red }')
    await bundle.rebuild()
    expect(bundle.version()).not.toBe(v)
  } finally {
    bundle.close()
    rmSync(root, { recursive: true, force: true })
  }
})
