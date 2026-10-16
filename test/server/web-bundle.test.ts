import { expect, spyOn, test } from 'bun:test'
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
  try {
    const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
    expect(bundle.js()).toContain('marker-from-b')
    expect(bundle.js()).not.toMatch(/^import .* from ['"]\.\//m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps the last good bundle when a file breaks', async () => {
  const root = site({ 'app.js': "import { b } from './b.js'\nconsole.log(b)\n", 'b.js': 'export const b = 1\n' })
  const logs: string[] = []
  try {
    const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: text => logs.push(text) })
    const before = bundle.js()
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'b.js'), 'export const x = (')
    await bundle.rebuild()
    expect(bundle.js()).toBe(before)
    expect(bundle.version()).toBe(v)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.startsWith('web bundle:')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('version changes when css changes', async () => {
  const root = site({ 'app.js': 'console.log(1)\n', 'index.html': '<html></html>' })
  try {
    const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'app.css'), 'body { color: red }')
    await bundle.rebuild()
    expect(bundle.version()).not.toBe(v)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('version changes when another file the page loads changes, as the icon', async () => {
  const root = site({ 'app.js': 'console.log(1)\n', 'index.html': '<html></html>', 'icon.svg': '<svg/>' })
  try {
    const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'icon.svg'), '<svg viewBox="0 0 1 1"/>')
    await bundle.rebuild()
    expect(bundle.version()).not.toBe(v)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rebuilds run one at a time, so the newest bundle is the one kept', async () => {
  const root = site({ 'app.js': "import { b } from './b.js'\nconsole.log(b)\n", 'b.js': "export const b = 'one'\n" })
  const real = Bun.build
  let running = 0
  let most = 0
  // The first rebuild is the slow one: unserialised, it would finish last and win.
  const delays = [0, 200, 0]
  const build = spyOn(Bun, 'build').mockImplementation(async config => {
    running++
    most = Math.max(most, running)
    try {
      const output = await real(config)
      await Bun.sleep(delays.shift() ?? 0)
      return output
    } finally {
      running--
    }
  })
  try {
    const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
    writeFileSync(join(root, 'web', 'b.js'), "export const b = 'two'\n")
    const first = bundle.rebuild()
    writeFileSync(join(root, 'web', 'b.js'), "export const b = 'three'\n")
    const second = bundle.rebuild()
    await Promise.all([first, second])
    expect(most).toBe(1)
    expect(bundle.js()).toContain('three')
  } finally {
    build.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
