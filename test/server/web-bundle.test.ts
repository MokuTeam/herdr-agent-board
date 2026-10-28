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

test('the source map apart, which the script names; the names stay for component stacks', async () => {
  const root = site({
    'app.js': [
      "import { Lane } from './lane.js'",
      'function SessionCard() { return null }',
      'class Boundary {}',
      'const Wrapped = (f => f)(function MenuItem() { return null })',
      'globalThis.names = [SessionCard.name, Lane.name, Boundary.name, Wrapped.name]',
      '',
    ].join('\n'),
    'lane.js': 'export const Lane = () => null\n',
  })
  try {
    const bundle = await createWebBundle({ root, entry: join(root, 'web', 'app.js'), log: () => {} })
    expect(bundle.js()).not.toContain('sourceMappingURL=data:')
    expect(bundle.js().trimEnd().endsWith('//# sourceMappingURL=app.js.map')).toBe(true)
    const map = JSON.parse(bundle.map()) as { sources: string[]; sourcesContent: string[] }
    expect(map.sources.map(s => s.split(/[\\/]/).pop())).toEqual(['lane.js', 'app.js'])
    expect(map.sourcesContent.join('')).toContain('function SessionCard()')
    // Minified (no indentation, no line per statement), yet every component keeps its name.
    expect(bundle.js()).not.toContain('\n  ')
    const scope: { names?: string[] } = {}
    new Function('globalThis', bundle.js())(scope)
    expect(scope.names).toEqual(['SessionCard', 'Lane', 'Boundary', 'MenuItem'])
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
  // The page's own script: the boundary that reports a component stack by its name, and the map
  // with the TypeScript sources for devtools.
  expect(bundle.js()).toMatch(/\bclass ErrorBoundary\b/)
  const map = JSON.parse(bundle.map()) as { sources: string[] }
  expect(map.sources.some(s => s.endsWith('web/src/components/ErrorBoundary.tsx'))).toBe(true)
})

test('theme.js puts the style on <html> only for a kept Terminal, beside the theme, and never throws (#161)', async () => {
  const root = join(import.meta.dir, '..', '..')
  const bundle = await createWebBundle({
    root,
    entry: join(root, 'web', 'src', 'main.tsx'),
    early: join(root, 'web', 'src', 'theme.ts'),
    log: () => {},
  })
  const run = (theme: string | null, look: string | null, broken = false, lookDefault?: string) => {
    const dataset: Record<string, string> = lookDefault ? { lookDefault } : {}
    const kept: Record<string, string | null> = { 'board.theme': theme, 'board.look': look }
    const localStorage = {
      getItem: (key: string) => {
        if (broken) throw new Error('denied')
        return kept[key] ?? null
      },
    }
    new Function('localStorage', 'document', bundle.early())(localStorage, { documentElement: { dataset } })
    return dataset
  }
  expect([
    run(null, 'terminal'),
    run('light', 'terminal'),
    run('dark', 'classic'),
    run(null, 'sepia'),
    run(null, null),
    run('dark', 'terminal', true),
  ]).toEqual([{ look: 'terminal' }, { theme: 'light', look: 'terminal' }, { theme: 'dark' }, {}, {}, {}])
  // config.json's look (data-look-default on <html>): Terminal, unless this browser picked Classic;
  // also where the browser keeps nothing it will say.
  const start = { lookDefault: 'terminal' }
  expect([
    run(null, null, false, 'terminal'),
    run(null, 'classic', false, 'terminal'),
    run('dark', 'terminal', false, 'terminal'),
    run(null, null, true, 'terminal'),
  ]).toEqual([
    { ...start, look: 'terminal' },
    start,
    { ...start, theme: 'dark', look: 'terminal' },
    { ...start, look: 'terminal' },
  ])
})

test('theme.js wraps card text on <html> only for a kept Wrap, beside the theme and the style, and never throws (#183)', async () => {
  const root = join(import.meta.dir, '..', '..')
  const bundle = await createWebBundle({
    root,
    entry: join(root, 'web', 'src', 'main.tsx'),
    early: join(root, 'web', 'src', 'theme.ts'),
    log: () => {},
  })
  const run = (kept: Record<string, string | null>, broken = false) => {
    const dataset: Record<string, string> = {}
    const localStorage = {
      getItem: (key: string) => {
        if (broken) throw new Error('denied')
        return kept[key] ?? null
      },
    }
    new Function('localStorage', 'document', bundle.early())(localStorage, { documentElement: { dataset } })
    return dataset
  }
  expect([
    run({ 'board.cardText': 'wrap' }),
    run({ 'board.cardText': 'wrap', 'board.theme': 'light', 'board.look': 'terminal' }),
    run({ 'board.cardText': 'cut', 'board.theme': 'dark' }),
    run({ 'board.cardText': 'ellipsis' }),
    run({}),
    run({ 'board.cardText': 'wrap' }, true),
  ]).toEqual([
    { cardText: 'wrap' },
    { theme: 'light', look: 'terminal', cardText: 'wrap' },
    { theme: 'dark' },
    {},
    {},
    {},
  ])
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

// The quick look's viewers (server/viewers.ts, #176): each bundled apart, so app.js stays as it was.
test('viewers are bundled apart from the page, each with its map; one that fails leaves the rest', async () => {
  const root = site({
    'app.js': "console.log('marker-of-the-page')\n",
    'viewer.js': "import { v } from './lib.js'\nexport const mount = () => v\n",
    'lib.js': "export const v = 'marker-of-the-viewer'\n",
    'broken.js': "import { nothing } from 'no-such-package'\nexport const mount = nothing\n",
  })
  mkdirSync(join(root, 'node_modules', 'some-lib'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'some-lib', 'package.json'), '{"name":"some-lib","version":"1.0.0"}')
  writeFileSync(join(root, 'node_modules', 'some-lib', 'worker.mjs'), 'self.onmessage = () => {}\n')
  const logs: string[] = []
  try {
    const bundle = await createWebBundle({
      root,
      entry: join(root, 'web', 'app.js'),
      viewers: { 'viewer.js': join(root, 'web', 'viewer.js'), 'broken.js': join(root, 'web', 'broken.js') },
      copies: { 'worker.js': 'some-lib/worker.mjs', 'gone.js': 'some-lib/gone.mjs' },
      log: text => logs.push(text),
    })
    expect(bundle.js()).toContain('marker-of-the-page')
    expect(bundle.js()).not.toContain('marker-of-the-viewer')
    const viewer = String(bundle.file('viewer.js') ?? '')
    expect(viewer).toContain('marker-of-the-viewer')
    expect(viewer).toMatch(/export\s*\{/)
    expect(viewer.trimEnd().endsWith('//# sourceMappingURL=viewer.js.map')).toBe(true)
    const { sources } = JSON.parse(String(bundle.file('viewer.js.map') ?? '{}')) as { sources: string[] }
    expect(sources.some(s => s.endsWith('lib.js'))).toBe(true)
    expect(String(bundle.file('worker.js'))).toBe('self.onmessage = () => {}\n')
    // Not built, not there: logged by name, the page and the other viewer as they are.
    expect(bundle.file('broken.js')).toBeUndefined()
    expect(bundle.file('gone.js')).toBeUndefined()
    expect(logs.some(l => l.includes('broken.js'))).toBe(true)
    expect(logs.some(l => l.includes('gone.js'))).toBe(true)
    // A viewer changed is a new page version.
    const v = bundle.version()
    writeFileSync(join(root, 'web', 'lib.js'), "export const v = 'changed'\n")
    await bundle.rebuild()
    expect(bundle.version()).not.toBe(v)
    expect(bundle.file('viewer.js')).toContain('changed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A viewer that stops building keeps its last good build, as app.js does (a 404 would quietly send
// the page back to the browser's own viewer); a copy is served as its bytes, not as text.
test('a viewer broken later keeps its last good build; a copy keeps its bytes', async () => {
  const root = site({ 'app.js': "console.log('page')\n", 'viewer.js': "export const mount = () => 'first'\n" })
  mkdirSync(join(root, 'node_modules', 'some-lib'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'some-lib', 'package.json'), '{"name":"some-lib","version":"1.0.0"}')
  const bytes = Buffer.from([0, 0xff, 0xfe, 0x80, 0x61])
  writeFileSync(join(root, 'node_modules', 'some-lib', 'decoder.wasm'), bytes)
  const logs: string[] = []
  try {
    const bundle = await createWebBundle({
      root,
      entry: join(root, 'web', 'app.js'),
      viewers: { 'viewer.js': join(root, 'web', 'viewer.js') },
      copies: { 'decoder.wasm': 'some-lib/decoder.wasm' },
      log: text => logs.push(text),
    })
    expect(Buffer.compare(bundle.file('decoder.wasm') as Buffer, bytes)).toBe(0)
    const good = bundle.file('viewer.js')
    expect(good).toContain('first')
    writeFileSync(join(root, 'web', 'viewer.js'), 'export const mount = (')
    await bundle.rebuild()
    expect(logs.some(l => l.includes('viewer.js'))).toBe(true)
    expect(bundle.file('viewer.js')).toBe(good)
    expect(bundle.file('viewer.js.map')).toBeTruthy()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
