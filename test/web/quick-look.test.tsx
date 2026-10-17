// The React quick look and file chips against the old page's: every scene is stepped through on
// both sides — the old page's files.js (at the parity baseline) on a fake <body> and the React
// steps drawn by <QuickLookView> (support/old-files.tsx) — with the same server answers; after each
// step the two must read the same. Then the chips, one candidate at a time, and how the chips are
// looked up.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { FileIcon } from '../../web/src/components/files/FileChip.tsx'
import { fileChips } from '../../web/src/hooks/useFileChips.ts'
import { ICON_PATHS, type IconName, type PathInfo, type Preview } from '../../web/src/models/files.ts'
import { type HistoryReply, quickLookNav } from '../../web/src/models/quick-look.ts'
import { FakeWorld } from './support/fake-dom.ts'
import { canonical, parseHtml, reactMarkup } from './support/markup.ts'
import { oldCode } from './support/old-app.ts'
import { BothLooks, type FilesServer, NewLook, OldLook } from './support/old-files.tsx'

const isIconName = (name: string): name is IconName => Object.hasOwn(ICON_PATHS, name)

const en = translator('en')
const ru = translator('ru')
const AT = Date.UTC(2026, 9, 17, 9, 30)

const file = (path: string, fields: Record<string, unknown>) => ({
  path,
  name: path.split(/[\\/]/).pop(),
  exists: true,
  dir: false,
  size: 2048,
  mtime: AT,
  ...fields,
})

const PREVIEWS: Record<string, unknown> = {
  'C:\\work\\app\\src\\app.ts': file('C:\\work\\app\\src\\app.ts', {
    kind: 'text',
    text: 'const a = 1\n\nexport { a } // <ok>\n',
    truncated: true,
    lines: 3,
  }),
  '/home/me/notes.md': file('/home/me/notes.md', {
    kind: 'markdown',
    text: '# Notes\n\nSee `src/app.ts` and **this**, then [the docs](https://example.com/docs).\n',
    truncated: false,
    lines: 3,
  }),
  '/data/x.csv': file('/data/x.csv', {
    kind: 'csv',
    text: 'a,b\n1,"2,5"\n',
    rows: [
      ['a', 'b'],
      ['1', '2,5'],
    ],
    lines: 2,
  }),
  '/data/empty.csv': file('/data/empty.csv', { kind: 'csv', text: '', rows: [], lines: 1 }),
  '/data/x.json': file('/data/x.json', { kind: 'json', text: '{\n  "a": 1\n}', lines: 3 }),
  '/pics/a b.png': file('/pics/a b.png', { kind: 'image', size: 5_000_000 }),
  '/docs/spec.pdf': file('/docs/spec.pdf', { kind: 'pdf' }),
  '/media/clip.mp4': file('/media/clip.mp4', { kind: 'video' }),
  '/media/song.mp3': file('/media/song.mp3', { kind: 'audio', mtime: null }),
  '/bin/tool.exe': file('/bin/tool.exe', { kind: 'binary', size: 900 }),
  '/bin/blob': file('/bin/blob', { kind: 'file', size: 10 }),
  'C:\\work\\app': {
    path: 'C:\\work\\app',
    name: 'app',
    exists: true,
    dir: true,
    size: null,
    mtime: AT,
    kind: 'dir',
    total: 3,
    entries: [
      { name: 'src', dir: true, size: null, mtime: AT, kind: 'dir' },
      { name: 'README.md', dir: false, size: 1200, mtime: AT, kind: 'markdown' },
      { name: 'logo.png', dir: false, size: 3_000_000, mtime: null, kind: 'image' },
    ],
  },
  '/big': {
    path: '/big',
    name: 'big',
    exists: true,
    dir: true,
    mtime: AT,
    kind: 'dir',
    total: 900,
    entries: [{ name: 'a.txt', dir: false, size: 5, mtime: AT, kind: 'text' }],
  },
  '/empty': { path: '/empty', name: 'empty', exists: true, dir: true, mtime: null, kind: 'dir', total: 0, entries: [] },
  '/gone.txt': { path: '/gone.txt', name: 'gone.txt', exists: false, error: 'missing' },
  '/root': { path: '/root', name: 'root', exists: true, dir: true, mtime: AT, kind: 'dir', error: 'denied' },
  '/locked.txt': file('/locked.txt', { kind: 'text', error: 'EBUSY: resource busy' }),
  'bad\u0000path': { error: 'Path missing: bad', httpStatus: 400 },
}

const CHANGES = {
  available: true,
  root: 'C:\\work\\app',
  branch: 'main',
  status: [
    ' M src/app.ts',
    'A  docs/new.md',
    ' D gone.md',
    'R  old.txt -> renamed.txt',
    '?? draft.json',
    'UU both.js',
    ' M logo.png',
  ].join('\n'),
  diff: [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1..2 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,4 @@ export',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+',
    ' export { a }',
    '\\ No newline at end of file',
    'diff --git a/docs/new.md b/docs/new.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/docs/new.md',
    '@@ -0,0 +1 @@',
    '+# New',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n'),
  truncated: true,
  collectedAt: AT,
}

const HISTORY = {
  results: [
    {
      session: 'abcdef1234567',
      role: 'user',
      text: 'Please fix the login form now',
      excerpt: 'fix the **login** form',
      date: '2026-10-16T08:00:00Z',
      source: 'x',
      byteOffset: 0,
      title: 'Login work',
    },
    {
      session: '0123456789abc',
      role: 'assistant',
      text: 'Login fixed, see `src/login.ts`',
      excerpt: 'Login fixed, see `src/login.ts`',
      date: null,
      source: 'y',
      byteOffset: 9,
      title: '',
    },
  ],
  truncated: true,
}

const server = (fields: FilesServer = {}): FilesServer => ({
  preview: path => PREVIEWS[path] ?? { path, name: path, exists: false, error: 'missing' },
  changes: () => CHANGES,
  history: (_key, query) =>
    query === 'nothing' ? { results: [] } : query === 'none' ? { unavailable: true } : HISTORY,
  ...fields,
})

function same(b: BothLooks) {
  const { old, react } = b.looks()
  expect(react).toBe(old)
}

const at = (path: string, line: number | null = null) => ({ kind: 'file' as const, path, line })

describe('the quick look of a file', () => {
  test('text at a line: numbered lines, the line lit; its size, lines, cut and date', async () => {
    const b = new BothLooks(en, server())
    await b.open(at('C:\\work\\app\\src\\app.ts', 2))
    same(b)
    expect(b.looks().react).toContain('class="hit ql-ln"')
  })

  test('Markdown rendered, as source, and rendered again', async () => {
    const b = new BothLooks(en, server())
    await b.open(at('/home/me/notes.md'))
    same(b)
    b.mode('source')
    same(b)
    b.mode('view')
    same(b)
    // Source stays the way to show Markdown, until a file of another kind.
    b.mode('source')
    await b.push(at('/home/me/notes.md'))
    same(b)
    await b.push(at('/data/x.json'))
    await b.back()
    same(b)
  })

  test('CSV as a table (as code when it has no rows), JSON and code as text', async () => {
    const b = new BothLooks(en, server())
    for (const path of ['/data/x.csv', '/data/empty.csv', '/data/x.json']) {
      await b.open(at(path))
      same(b)
    }
  })

  test('images, PDF, video and audio from the raw bytes, with the run token', async () => {
    const b = new BothLooks(en, server())
    for (const path of ['/pics/a b.png', '/docs/spec.pdf', '/media/clip.mp4', '/media/song.mp3']) {
      await b.open(at(path))
      same(b)
    }
    expect(b.looks().react).toContain('/api/fs/raw?path=%2Fmedia%2Fsong.mp3&amp;t=tok')
  })

  test('a binary or unknown file: no preview, and a button that opens it', async () => {
    const b = new BothLooks(en, server())
    for (const path of ['/bin/tool.exe', '/bin/blob']) {
      await b.open(at(path))
      same(b)
    }
  })

  test('missing, no access, an error reading it, a refusal', async () => {
    const b = new BothLooks(en, server())
    for (const path of ['/gone.txt', '/root', '/locked.txt', 'bad\u0000path']) {
      await b.open(at(path))
      same(b)
    }
  })

  test('while the next step loads: its name and folders at once, the last one’s actions until the answer', async () => {
    const slow = server({
      preview: path => (path === '/never.txt' ? new Promise(() => {}) : PREVIEWS[path]),
    })
    const b = new BothLooks(en, slow)
    await b.open(at('/never.txt'))
    same(b)
    await b.open(at('/data/x.json'))
    await b.push(at('/never.txt'))
    same(b)
  })
})

describe('the quick look of a folder', () => {
  test('its entries to walk to, a step into one and back', async () => {
    const b = new BothLooks(en, server())
    await b.open(at('C:\\work\\app'))
    same(b)
    await b.push(at('C:\\work\\app\\src\\app.ts'))
    same(b)
    await b.back()
    same(b)
  })

  test('the first entries of a big one; an empty one', async () => {
    const b = new BothLooks(en, server())
    await b.open(at('/big'))
    same(b)
    await b.open(at('/empty'))
    same(b)
  })
})

describe('the changes of a checkout', () => {
  test('the changed files, their diffs and counts, a file from them and back to them, read again', async () => {
    let reads = 0
    const b = new BothLooks(
      en,
      server({
        changes: () => {
          reads++
          return CHANGES
        },
      }),
    )
    await b.open({ kind: 'changes', key: 'k1' })
    same(b)
    await b.push(at('C:\\work\\app\\src\\app.ts'))
    same(b)
    await b.back()
    same(b)
    // Back from the file they were not read again (once by each side); refresh reads them.
    expect(reads).toBe(2)
    await b.refresh()
    same(b)
    expect(reads).toBe(4)
  })

  test('clean; not a checkout; no answer', async () => {
    const clean = new BothLooks(en, server({ changes: () => ({ ...CHANGES, status: '', diff: '', truncated: false }) }))
    await clean.open({ kind: 'changes', key: 'k1' })
    same(clean)
    const none = new BothLooks(en, server({ changes: () => ({ available: false }) }))
    await none.open({ kind: 'changes', key: 'k1' })
    same(none)
    const waiting = new BothLooks(en, server({ changes: () => new Promise(() => {}) }))
    await waiting.open({ kind: 'changes', key: 'k1' })
    same(waiting)
  })
})

describe('the past sessions of a project', () => {
  test('the prompt, a search on its way, the hits with the query marked; nothing found; no history', async () => {
    const slow: FilesServer = { ...server(), history: () => new Promise<HistoryReply>(() => {}) }
    const waiting = new BothLooks(en, slow)
    await waiting.open({ kind: 'history', key: 'k1', cwd: '/work/app' })
    same(waiting)
    await waiting.search('login')
    same(waiting)
    const b = new BothLooks(en, server())
    await b.open({ kind: 'history', key: 'k1', cwd: 'C:\\work\\app' })
    await b.search('login')
    same(b)
    expect(b.looks().react).toContain('<mark>login</mark>')
    await b.search('nothing')
    same(b)
    await b.search('none')
    same(b)
    // A file from the hits, and back to them.
    await b.search('login')
    await b.push(at('/home/me/notes.md'))
    await b.back()
    same(b)
  })
})

describe('around what it shows', () => {
  test('without the board, open and reveal are off; copy is on', async () => {
    const b = new BothLooks(en, server())
    await b.open(at('/data/x.json'))
    b.canEdit = false
    same(b)
    b.canEdit = true
    same(b)
  })

  test('in Russian, and drawn again in another language', async () => {
    const b = new BothLooks(ru, server())
    await b.open(at('C:\\work\\app'))
    same(b)
    b.language(en)
    same(b)
    await b.open({ kind: 'history', key: 'k1', cwd: '/work' })
    b.language(ru)
    same(b)
  })

  test('the icons are the old page’s', () => {
    const old = oldCode('web/files.js', ['svg', 'DOC', 'ICONS'], {}).get('ICONS')
    const icons = typeof old === 'object' && old !== null ? Object.entries(old) : []
    expect(Object.keys(ICON_PATHS)).toEqual(icons.map(([name]) => name))
    for (const [name, markup] of icons)
      if (isIconName(name))
        expect(canonical(reactMarkup(<FileIcon name={name} />))).toBe(canonical(parseHtml(String(markup))))
  })
})

describe('a slow answer', () => {
  test('for a step no longer on show is dropped', async () => {
    const previews: ((value: Preview) => void)[] = []
    const searches: ((value: HistoryReply) => void)[] = []
    const nav = quickLookNav({
      t: () => en,
      preview: () => new Promise(resolve => previews.push(resolve)),
      changes: async () => ({ available: false }),
      history: () => new Promise(resolve => searches.push(resolve)),
      changed() {},
    })
    const top = () => {
      const step = nav.view().top
      return step?.kind === 'history' ? step : null
    }
    nav.open(at('/a.txt'))
    nav.push(at('/b.txt'))
    previews[1]?.({ path: '/b.txt', name: 'b.txt', kind: 'text', text: 'b', lines: 1 })
    await Promise.resolve()
    previews[0]?.({ path: '/a.txt', name: 'a.txt', kind: 'text', text: 'a', lines: 1 })
    await Promise.resolve()
    expect(nav.view().data?.path).toBe('/b.txt')
    // A search wants two characters; one answered after a step away is dropped too.
    nav.open({ kind: 'history', key: 'k', cwd: '/w' })
    nav.search('x')
    expect(top()?.result).toBeUndefined()
    nav.search('xy')
    nav.push(at('/c.txt'))
    searches[0]?.({ results: [] })
    await Promise.resolve()
    expect(nav.back()).toBe(true)
    expect(top()).toMatchObject({ query: 'xy', result: { loading: true } })
  })
})

// ---------------------------------------------------------------- chips

const info = (fields: Partial<PathInfo> & Pick<PathInfo, 'raw'>): PathInfo => ({
  path: `/work/${fields.raw}`,
  name: fields.raw.split('/').pop() ?? '',
  exists: true,
  kind: 'text',
  ...fields,
})

const CANDIDATES: [string, PathInfo][] = [
  ['<code class="fs-cand" data-path="src/app.ts:12">src/app.ts:12</code>', info({ raw: 'src/app.ts:12', line: 12 })],
  [
    '<span class="fs-cand" data-path="C:\\work\\docs">C:\\work\\docs</span>',
    info({ raw: 'C:\\work\\docs', path: 'C:\\work\\docs', name: 'docs', dir: true, kind: 'dir' }),
  ],
  ['<a class="fs" data-path="notes.md">the <strong>notes</strong></a>', info({ raw: 'notes.md', kind: 'markdown' })],
  ['<a class="fs" data-path="gone.md">gone</a>', info({ raw: 'gone.md', path: '', exists: false })],
  ['<code class="fs-cand" data-path="gone.ts">gone.ts</code>', info({ raw: 'gone.ts', exists: false })],
  ['<code class="fs-cand" data-path="a.bin">a.bin</code>', info({ raw: 'a.bin', kind: 'binary' })],
  ['<code class="fs-cand" data-path="pic.png">pic.png</code>', info({ raw: 'pic.png', kind: 'image' })],
  [
    '<a class="fs-inline" data-path="C:\\up\\shot.png" href="/uploads/x/shot.png"><img src="/uploads/x/shot.png" alt=""></a>',
    info({ raw: 'C:\\up\\shot.png', path: 'C:\\up\\shot.png', kind: 'image' }),
  ],
  ['<span class="d fs-inline" data-path="src/app.ts">src/app.ts</span>', info({ raw: 'src/app.ts', line: null })],
]

describe('file chips', () => {
  test('code, text and links become chips with their kind’s icon; thumbnails and tool lines keep their look', () => {
    const old = new OldLook(en, server())
    const react = new NewLook(en, server())
    const world = new FakeWorld({ viewport: { w: 800, h: 600 } })
    for (const [html, path] of CANDIDATES)
      expect(canonical(react.chip(world, html, path))).toBe(canonical(old.chip(html, path)))
  })

  test('the server is asked once per path; what it said holds a while; chips drawn anew are dropped', async () => {
    const world = new FakeWorld({ viewport: { w: 800, h: 600 } })
    world.install()
    try {
      await upgrades(world)
    } finally {
      world.uninstall()
    }
  })
})

async function upgrades(world: FakeWorld) {
  let now = 1000
  const asked: [string, string[]][] = []
  const chips = fileChips({
    t: () => en,
    now: () => now,
    stat: async (cwd, paths) => {
      asked.push([cwd, paths])
      return paths.map(raw => info({ raw, exists: raw !== 'later.md' }))
    },
  })
  const [node] = parseHtml(
    '<div class="md"><code class="fs-cand" data-path="a.ts">a.ts</code> <span class="fs-cand" data-path="a.ts">a.ts</span> <code class="fs-cand" data-path="later.md">later.md</code></div>',
  )
  if (node?.kind !== 'element') throw new Error('no root')
  const root = world.mount(node)
  // The world is installed: its HTMLElement is the fake one.
  if (!(root instanceof HTMLElement)) throw new Error('the world is not installed')
  const asRoot = root
  await chips.upgrade(asRoot, '/work')
  expect(asked).toEqual([['/work', ['a.ts', 'later.md']]])
  expect(chips.list.get().map(c => [c.label, c.kind])).toEqual([
    ['a.ts', 'text'],
    ['a.ts', 'text'],
  ])
  expect(root.querySelector('[data-path="later.md"]')?.dataset.fs).toBe('missing')
  // Drawn anew: from what the server said, without asking; a missing one again after a while.
  root.innerHTML =
    '<code class="fs-cand" data-path="a.ts">a.ts</code><code class="fs-cand" data-path="later.md">x</code>'
  await chips.upgrade(asRoot, '/work')
  expect(asked.length).toBe(1)
  expect(chips.list.get().length).toBe(1)
  root.innerHTML =
    '<code class="fs-cand" data-path="a.ts">a.ts</code><code class="fs-cand" data-path="later.md">x</code>'
  now += 16_000
  await chips.upgrade(asRoot, '/work')
  expect(asked).toEqual([
    ['/work', ['a.ts', 'later.md']],
    ['/work', ['later.md']],
  ])
}
