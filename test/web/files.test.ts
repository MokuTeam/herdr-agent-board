// The pure part of the chat's files (web/src/models/files.ts): icons, kinds by name, the raw-bytes
// URL, paths taken apart and put together with either separator, sizes, the quick look's footer
// and actions, history excerpts, and how long what the server said about a path holds.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  actionsOff,
  bodyClass,
  codeLines,
  crumbs,
  excerptOf,
  FRESH_MS,
  fileName,
  iconName,
  inCheckout,
  inFolder,
  kindOfName,
  lookIcon,
  markParts,
  parentOf,
  previewFoot,
  rawUrl,
  sizeText,
  statBook,
} from '../../web/src/models/files.ts'

const en = translator('en')

describe('icons', () => {
  test('a kind shows its own icon; one without its own shows a file (binary) or a text', () => {
    expect(iconName('image')).toBe('image')
    expect(iconName('binary')).toBe('file')
    expect(iconName('weird')).toBe('text')
    expect(iconName(undefined)).toBe('text')
    expect(iconName('toString')).toBe('text')
  })

  test('the head shows missing, a folder, else the kind', () => {
    expect(lookIcon({ error: 'missing', dir: true, kind: 'dir' })).toBe('missing')
    expect(lookIcon({ dir: true, kind: 'text' })).toBe('dir')
    expect(lookIcon({ kind: 'changes' })).toBe('changes')
    expect(lookIcon({})).toBe('text')
  })

  test('kinds by name for the changed files: the extension, case aside; text for the rest', () => {
    expect(kindOfName('docs/README.MD')).toBe('markdown')
    expect(kindOfName('data.tsv')).toBe('csv')
    expect(kindOfName('logo.svg')).toBe('image')
    expect(kindOfName('src/app.ts')).toBe('text')
    expect(kindOfName('Makefile')).toBe('text')
    expect(kindOfName('a.constructor')).toBe('text')
  })
})

describe('paths, either separator', () => {
  test('the raw bytes of a file go with the run token', () => {
    expect(rawUrl('C:\\a b\\x.png', 'tok&1')).toBe('/api/fs/raw?path=C%3A%5Ca%20b%5Cx.png&t=tok%261')
    expect(rawUrl('/a/x.png', null)).toBe('/api/fs/raw?path=%2Fa%2Fx.png&t=')
  })

  test('a file name', () => {
    expect(fileName('C:\\Users\\me\\notes.md')).toBe('notes.md')
    expect(fileName('/home/me/dir/')).toBe('dir')
    expect(fileName('')).toBe('')
  })

  test('the folders above a file, each a step; changes and history go down to the folder itself', () => {
    expect(crumbs('C:\\Users\\me\\a.txt', 'text')).toEqual([
      { name: 'C:', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'me', path: 'C:\\Users\\me' },
    ])
    expect(crumbs('/home/me/a.txt', 'text')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'me', path: '/home/me' },
    ])
    expect(crumbs('C:/work/app', 'changes')).toEqual([
      { name: 'C:', path: 'C:/' },
      { name: 'work', path: 'C:/work' },
      { name: 'app', path: 'C:/work/app' },
    ])
    expect(crumbs('/work', 'history')).toEqual([
      { name: '/', path: '/' },
      { name: 'work', path: '/work' },
    ])
    expect(crumbs(undefined, 'text')).toEqual([])
  })

  test('the folder a file is in, a name in a folder, a git path in a checkout', () => {
    expect(parentOf('C:\\docs\\a.md')).toBe('C:\\docs')
    expect(parentOf('/docs/a.md')).toBe('/docs')
    expect(inFolder('C:\\docs\\', 'a.md')).toBe('C:\\docs\\a.md')
    expect(inFolder('/docs', 'a.md')).toBe('/docs/a.md')
    expect(inCheckout('C:\\work\\app', 'src/x/y.ts')).toBe('C:\\work\\app\\src\\x\\y.ts')
    expect(inCheckout('/work/app/', 'src/y.ts')).toBe('/work/app/src/y.ts')
  })
})

test('sizes in bytes, KB and MB', () => {
  expect(sizeText(null, en)).toBe('')
  expect(sizeText(undefined, en)).toBe('')
  expect(sizeText(1023, en)).toBe(en('size.b', { n: 1023 }))
  expect(sizeText(1536, en)).toBe(en('size.kb', { n: 2 }))
  expect(sizeText(3 * 1024 * 1024 + 1, en)).toBe(en('size.mb', { n: '3.0' }))
})

test('code lines: a final line break ends the last line', () => {
  expect(codeLines('a\nb\n')).toEqual(['a', 'b'])
  expect(codeLines('\n')).toEqual([''])
  expect(codeLines('')).toEqual([''])
})

describe('the quick look', () => {
  test('its body class goes by what it shows', () => {
    expect(bodyClass({ dir: true, kind: 'dir' })).toBe('ql-body k-dir')
    expect(bodyClass({ kind: 'markdown' })).toBe('ql-body k-markdown')
    expect(bodyClass({})).toBe('ql-body k-undefined')
  })

  test('open and reveal need the board; copy only a path that is there (or denied)', () => {
    expect(actionsOff({ path: '/a' }, true)).toEqual({ open: false, reveal: false, copy: false })
    expect(actionsOff({ path: '/a' }, false)).toEqual({ open: true, reveal: true, copy: false })
    expect(actionsOff({ path: '/a', error: 'denied' }, true)).toEqual({ open: false, reveal: false, copy: false })
    expect(actionsOff({ path: '/a', error: 'missing' }, true)).toEqual({ open: true, reveal: true, copy: true })
    expect(actionsOff({ path: '' }, true)).toEqual({ open: true, reveal: true, copy: true })
    expect(actionsOff(null, true)).toEqual({ open: true, reveal: true, copy: true })
  })

  test('the footer: what it is, how big, how far it reads, when it changed', () => {
    const at = Date.UTC(2026, 9, 17, 9, 30)
    const modified = en('ql.modified', {
      date: new Date(at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }),
    })
    const text = { kind: 'text', path: '/a', size: 2048, text: 'x', lines: 3, truncated: true, mtime: at }
    expect(previewFoot(text, en)).toEqual([
      en('size.kb', { n: 2 }),
      en('ql.lines', { n: 3 }),
      en('ql.truncated'),
      modified,
    ])
    const csv = { kind: 'csv', path: '/a', size: 10, text: 'a,b', rows: [['a'], ['b'], ['c']], lines: 3 }
    expect(previewFoot(csv, en)).toEqual([en('size.b', { n: 10 }), en('ql.rows', { n: 2 })])
    const dir = { dir: true, kind: 'dir', path: '/d', total: 3, entries: [{ name: 'a', dir: false }], mtime: at }
    expect(previewFoot(dir, en)).toEqual([en('ql.items', { n: 3 }), en('ql.firstItems', { n: 1 }), modified])
    const denied = { dir: true, kind: 'dir', path: '/d', error: 'denied', mtime: at }
    expect(previewFoot(denied, en)).toEqual([modified])
    expect(previewFoot({ kind: 'image', path: '/i.png', size: 5 }, en)).toEqual([en('size.b', { n: 5 })])
    expect(previewFoot({ error: 'missing', path: '/gone' }, en)).toEqual([])
  })

  test('a history hit: its excerpt without markup, marked where the query matches', () => {
    expect(markParts('Fix the Login, log in', 'log')).toEqual([
      { text: 'Fix the ', hit: false },
      { text: 'Log', hit: true },
      { text: 'in, ', hit: false },
      { text: 'log', hit: true },
      { text: ' in', hit: false },
    ])
    expect(markParts('abc', '')).toEqual([{ text: 'abc', hit: false }])
    expect(excerptOf({ text: 'before **the** match', excerpt: '**the** match' })).toEqual({
      cut: true,
      text: 'the match',
    })
    expect(excerptOf({ text: '`a` b', excerpt: '`a` b' })).toEqual({ cut: false, text: 'a b' })
  })
})

describe('what the server said about a path', () => {
  test('holds five minutes when it was there, fifteen seconds when not (it may come)', () => {
    const book = statBook()
    book.put('/w', { raw: 'a.md', path: '/w/a.md', name: 'a.md', exists: true }, 1000)
    book.put('/w', { raw: 'b.md', path: '', name: 'b.md', exists: false }, 1000)
    expect(book.get('/w', 'a.md', 1000 + FRESH_MS.found)?.path).toBe('/w/a.md')
    expect(book.get('/w', 'a.md', 1001 + FRESH_MS.found)).toBeNull()
    expect(book.get('/w', 'b.md', 1000 + FRESH_MS.missing)?.exists).toBe(false)
    expect(book.get('/w', 'b.md', 1001 + FRESH_MS.missing)).toBeNull()
    expect(book.get('/other', 'a.md', 1000)).toBeNull()
  })
})
