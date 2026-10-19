import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, kindOf, openCommand, parseCsv, preview, resolvePath } from '../../src/adapters/files.ts'

test('a path as written: prefixes, escapes, lines, home and the session folder', () => {
  // Drive letters are absolute only on Windows; elsewhere the same checks run on POSIX paths.
  const win = process.platform === 'win32'
  const root = win ? 'C:/Work' : '/work'
  assert.deepEqual(resolvePath(`herdr-reveal:${root}/My%20Notes/a.md`), {
    path: resolve(`${root}/My Notes/a.md`),
    line: null,
  })
  assert.deepEqual(resolvePath(`file://${win ? '/' : ''}${root}/y.txt`), { path: resolve(`${root}/y.txt`), line: null })
  assert.deepEqual(resolvePath('src/app.js:42:7', `${root}/proj`), {
    path: resolve(`${root}/proj`, 'src/app.js'),
    line: 42,
  })
  assert.deepEqual(resolvePath(`${root}/y.ts:10`), { path: resolve(`${root}/y.ts`), line: 10 })
  if (win) assert.equal(resolvePath('C:\\').path, resolve('C:\\')) // a bare drive is not a line number
  assert.equal(resolvePath('~/notes.md').path, resolve(homedir(), 'notes.md'))
  assert.equal(resolvePath('relative.txt').path, '') // no session folder to resolve against
  assert.equal(kindOf('a/b/Dockerfile'), 'text')
  assert.equal(kindOf('x.PNG'), 'image')
  assert.equal(kindOf('x.bin'), 'file')
  // Either separator, drive letters and POSIX roots: only the extension counts.
  assert.equal(kindOf('C:\\work\\x.PNG'), 'image')
  assert.equal(kindOf('/work/x.png'), 'image')
})

test('previews: folders first, text cut to size, JSON pretty, CSV rows, binary and missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-files-'))
  mkdirSync(join(dir, 'zeta'))
  writeFileSync(join(dir, 'a.md'), '# Title\n\nText')
  writeFileSync(join(dir, 'data.json'), '{"a":1,"b":[1,2]}')
  writeFileSync(join(dir, 't.csv'), 'name,note\n"Smith, J","said ""hi""\nthen left"\nB,2\n')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  writeFileSync(join(dir, 'long.log'), Array.from({ length: 6000 }, (_, i) => `line ${i + 1}`).join('\n'))
  writeFileSync(join(dir, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('привет', 'utf16le')]))

  const folder = preview(dir)
  assert.equal(folder.dir, true)
  assert.equal(folder.entries?.[0]?.name, 'zeta')
  assert.equal(folder.entries?.[0]?.dir, true)
  assert.deepEqual(
    folder.entries?.slice(1).map(e => e.name),
    ['a.md', 'blob.bin', 'data.json', 'long.log', 't.csv', 'utf16.txt'],
  )
  assert.equal(folder.total, 7)

  assert.equal(preview(join(dir, 'a.md')).kind, 'markdown')
  assert.equal(preview(join(dir, 'data.json')).text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
  assert.deepEqual(preview(join(dir, 't.csv')).rows, [
    ['name', 'note'],
    ['Smith, J', 'said "hi"\nthen left'],
    ['B', '2'],
  ])
  assert.equal(preview(join(dir, 'blob.bin')).kind, 'file')
  assert.equal(preview(join(dir, 'blob.bin')).text, undefined)
  const long = preview(join(dir, 'long.log'))
  assert.equal(long.truncated, true)
  assert.equal(long.lines, 5000)
  assert.equal(preview(join(dir, 'utf16.txt')).text, 'привет')
  assert.equal(preview(join(dir, 'nope.txt')).error, 'missing')
  assert.equal(describe(join(dir, 'zeta')).kind, 'dir')
  assert.deepEqual(parseCsv('a\tb\n1\t2', '\t'), [
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('opening with the system: the right command on each platform, no shell in between', () => {
  assert.deepEqual(openCommand('C:\\a b\\x.pdf', 'open', 'win32'), ['explorer.exe', ['C:\\a b\\x.pdf']])
  assert.deepEqual(openCommand('C:\\a b\\x.pdf', 'reveal', 'win32'), ['explorer.exe', ['/select,C:\\a b\\x.pdf']])
  assert.deepEqual(openCommand('/u/x.pdf', 'reveal', 'darwin'), ['open', ['-R', '/u/x.pdf']])
  assert.deepEqual(openCommand('https://x.dev', 'open', 'darwin'), ['open', ['https://x.dev']])
  assert.deepEqual(openCommand('/u/a/x.pdf', 'reveal', 'linux'), ['xdg-open', ['/u/a']])
})
