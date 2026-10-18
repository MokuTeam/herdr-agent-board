import { expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
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

test('version changes when css changes, in web/styles as the page has it', async () => {
  const root = site({ 'app.js': 'console.log(1)\n', 'index.html': '<html></html>' })
  try {
    mkdirSync(join(root, 'web', 'styles'))
    const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'styles', 'app.css'), 'body { color: red }')
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

test('the script before the page paints is built beside the entry, on its own, and moves the version', async () => {
  const root = site({
    'app.js': "import { b } from './b.js'\nconsole.log(b, 'marker-app')\n",
    'b.js': "export const b = 'shared'\n",
    'early.js': "import { b } from './b.js'\nglobalThis.early = b + '-early'\n",
  })
  try {
    const bundle = await createWebBundle({
      root,
      entry: join(root, 'web', 'app.js'),
      early: join(root, 'web', 'early.js'),
      log: () => {},
    })
    expect(bundle.js()).toContain('marker-app')
    expect(bundle.early()).not.toContain('marker-app')
    expect(bundle.early()).toContain('-early')
    // A classic script: everything inlined, nothing imported.
    expect(bundle.early()).not.toMatch(/^\s*(import|export)\b/m)
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'early.js'), "globalThis.early = 'other'\n")
    await bundle.rebuild()
    expect(bundle.early()).toContain('other')
    expect(bundle.version()).not.toBe(v)
    // Broken, it keeps the last good pair.
    const good = bundle.early()
    writeFileSync(join(root, 'web', 'early.js'), 'globalThis.early = (')
    await bundle.rebuild()
    expect(bundle.early()).toBe(good)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the board’s own: theme.js puts only a kept light or dark on <html>, and never throws', async () => {
  const root = join(import.meta.dir, '..', '..')
  const bundle = await createWebBundle({
    root,
    entry: join(root, 'web', 'src', 'main.tsx'),
    early: join(root, 'web', 'src', 'theme.ts'),
    log: () => {},
  })
  const run = (kept: string | null, broken = false) => {
    const dataset: Record<string, string> = {}
    const localStorage = {
      getItem: (key: string) => {
        if (broken) throw new Error('denied')
        return key === 'board.theme' ? kept : null
      },
    }
    new Function('localStorage', 'document', bundle.early())(localStorage, { documentElement: { dataset } })
    return dataset.theme
  }
  expect([run('dark'), run('light'), run('auto'), run(null), run('dark', true)]).toEqual([
    'dark',
    'light',
    undefined,
    undefined,
    undefined,
  ])
  // A classic script on the page: its names stay its own, as upstream's theme.js declared none.
  const dataset: Record<string, string> = {}
  const page = createContext({ localStorage: { getItem: () => 'dark' }, document: { documentElement: { dataset } } })
  runInContext(bundle.early(), page)
  expect(dataset.theme).toBe('dark')
  expect(Object.keys(page).sort()).toEqual(['document', 'localStorage'])
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
