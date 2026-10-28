import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  csvSeparator,
  describe,
  kindOf,
  legacyCodePage,
  openCommand,
  parseCsv,
  preview,
  resolvePath,
} from '../../src/adapters/files.ts'

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

// CSV as Excel and other tools export it (#176): `;` where decimals have a comma, Windows-1251 or
// UTF-8 with a BOM, quoted fields with line breaks, many thousand rows.
test('a CSV as Excel saves it: its separator, its code page, its quotes, all its rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-csv-'))
  const write = (name: string, body: string | Uint8Array) => {
    writeFileSync(join(dir, name), body)
    return preview(join(dir, name))
  }
  // Excel with a Russian locale: `;` between fields, commas in the numbers, a BOM.
  const bom = write('ru.csv', '﻿Имя;Сумма;Заметка\nИванов;1 234,50;"две\nстроки"\nПетров;7,5;"с ""кавычками"""\n')
  assert.deepEqual(bom.rows, [
    ['Имя', 'Сумма', 'Заметка'],
    ['Иванов', '1 234,50', 'две\nстроки'],
    ['Петров', '7,5', 'с "кавычками"'],
  ])
  assert.equal(bom.text, undefined) // the rows only: the table is what the quick look shows
  assert.equal(bom.truncated, false)
  // The same saved in Windows-1251: no BOM, and not UTF-8.
  const ansi = write('ansi.csv', windows1251('Город;Население\nМосква;13 000 000\nКазань;1 300 000\n'))
  assert.deepEqual(ansi.rows, [
    ['Город', 'Население'],
    ['Москва', '13 000 000'],
    ['Казань', '1 300 000'],
  ])
  // A Western file in Windows-1252 stays Western.
  const latin = write('fr.csv', Buffer.from('nom,ville\nRen\xe9,Orl\xe9ans\n', 'latin1'))
  assert.deepEqual(latin.rows?.[1], ['René', 'Orléans'])

  // Excel's own line naming the separator; a tab-separated file.
  assert.deepEqual(write('sep.csv', 'sep=|\na|b,c\n1|2,5\n').rows, [
    ['a', 'b,c'],
    ['1', '2,5'],
  ])
  assert.deepEqual(write('t.tsv', 'a;b\tc\n1;2\t3\n').rows, [
    ['a;b', 'c'],
    ['1;2', '3'],
  ])

  // Many thousand rows: all of them, not the first 300.
  const many = write('many.csv', `n;x\n${Array.from({ length: 12_000 }, (_, i) => `${i};${i * 2}`).join('\n')}\n`)
  assert.equal(many.rows?.length, 12_001)
  assert.deepEqual(many.rows?.at(-1), ['11999', '23998'])
  assert.equal(many.truncated, false)
  // More than it shows: the first 20 000, and said so.
  const more = write('more.csv', `n\n${Array.from({ length: 25_000 }, (_, i) => i).join('\n')}\n`)
  assert.equal(more.rows?.length, 20_000)
  assert.equal(more.truncated, true)
  // Cut at its size: the last row, cut in two, is left out.
  const wide = 'x'.repeat(200)
  const cut = write('cut.csv', Array.from({ length: 25_000 }, (_, i) => `${i},${wide}`).join('\n'))
  assert.equal(cut.truncated, true)
  assert.deepEqual(cut.rows?.at(-1), [String((cut.rows?.length ?? 0) - 1), wide])
})

test('the separator and the code page a CSV is in', () => {
  assert.equal(csvSeparator('a,b,c\n1,2,3\n'), ',')
  assert.equal(csvSeparator('a;b;c\n1,5;2,5;3\n4;5,25;6\n'), ';')
  assert.equal(csvSeparator('a\tb\n1\t2\n'), '\t')
  assert.equal(csvSeparator('"x;y",b\n"1;2",3\n'), ',')
  assert.equal(csvSeparator('one column\nonly\n'), ',')
  assert.equal(legacyCodePage(windows1251('Привет, мир')), 'windows-1251')
  assert.equal(legacyCodePage(Buffer.from('caf\xe9 na\xefve', 'latin1')), 'windows-1252')
})

test('a CSV stays UTF-8 when it is: no BOM, a character cut at the size limit, a broken byte here and there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-csv-utf8-'))
  const write = (name: string, body: string | Uint8Array) => {
    writeFileSync(join(dir, name), body)
    return preview(join(dir, name))
  }
  assert.deepEqual(write('plain.csv', 'Имя;Город\nИван;Москва\n').rows, [
    ['Имя', 'Город'],
    ['Иван', 'Москва'],
  ])
  // Cut at 4 MB inside a two-byte "Ж": the rest is still UTF-8, the half-read row left out.
  const head = Buffer.from('Имя;Город\n')
  const filler = Buffer.alloc((4 << 20) - 1 - head.length, 'x')
  const cut = write('cut.csv', Buffer.concat([head, filler, Buffer.from('Ж;Жук\nЯ;Як\n')]))
  assert.equal(cut.truncated, true)
  assert.deepEqual(cut.rows?.[0], ['Имя', 'Город'])
  // The half-read character is not taken for a broken byte: nothing anywhere stands in for one.
  assert.equal(JSON.stringify(cut.rows).includes('�'), false)
  // One broken byte among a hundred letters above ASCII: UTF-8, the byte shown as it is.
  const broken = write(
    'broken.csv',
    Buffer.concat([Buffer.from(`Имя;Город\n${'Иван;Москва\n'.repeat(10)}`), Buffer.from([0xff]), Buffer.from('\n')]),
  )
  assert.deepEqual(broken.rows?.[1], ['Иван', 'Москва'])
})

test('a CSV’s separator on a tie, and Cyrillic in short words', () => {
  // No header, decimal commas: the semicolons split it.
  assert.equal(csvSeparator('Иван;Москва;1,5\n'), ';')
  assert.equal(csvSeparator('Иван;1,5\nПётр;2,25\n'), ';')
  // Commas between words are separators still.
  assert.equal(csvSeparator('a,b;c\n'), ',')
  assert.equal(legacyCodePage(windows1251('да;на')), 'windows-1251')
  assert.equal(legacyCodePage(windows1251('Алёна')), 'windows-1251')
  assert.equal(legacyCodePage(Buffer.from('Gr\xf6\xdfe;Stra\xdfe', 'latin1')), 'windows-1252')
  // A short Western file in Windows-1252 reads as such.
  const dir = mkdtempSync(join(tmpdir(), 'board-csv-latin-'))
  writeFileSync(join(dir, 'names.csv'), Buffer.from('Caf\xe9;Zo\xeb\nNa\xefve;\xc9mile\n', 'latin1'))
  assert.deepEqual(preview(join(dir, 'names.csv')).rows, [
    ['Café', 'Zoë'],
    ['Naïve', 'Émile'],
  ])
})

/** Russian text in Windows-1251: А to я are 0xC0 to 0xFF, Ё and ё 0xA8 and 0xB8. */
function windows1251(text: string): Uint8Array {
  return Uint8Array.from([...text], c => {
    const code = c.codePointAt(0) ?? 0
    if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0
    if (c === 'Ё') return 0xa8
    if (c === 'ё') return 0xb8
    return code
  })
}

// A Word document and a spreadsheet are the quick look's viewers' to read (#176): what they are
// by name, and a preview of what is known of them, without their bytes as text.
test('a Word document and a spreadsheet: their kind, and no text in their preview', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-office-'))
  assert.equal(kindOf('C:\\docs\\Договор.DOCX'), 'document')
  for (const name of ['a.xlsx', 'a.xlsm', 'a.xls', 'b.ods']) assert.equal(kindOf(name), 'spreadsheet')
  assert.equal(kindOf('old.doc'), 'file')
  for (const name of ['report.docx', 'sales.xlsx']) {
    writeFileSync(join(dir, name), Buffer.from('PK\u0003\u0004 zipped bytes \u0000\u0001'))
    const look = preview(join(dir, name))
    assert.equal(look.kind, name.endsWith('docx') ? 'document' : 'spreadsheet')
    assert.equal(look.text, undefined)
    assert.equal(look.error, undefined)
  }
})
