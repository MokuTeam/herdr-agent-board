// A Word document in the quick look (#176): as its worker reads it (viewers/document-worker.ts),
// headings, text, lists, tables with merged cells and web links as HTML, a password, an old
// .doc, a broken file or one too big said so instead; and as the page cleans it before it is
// drawn (viewers/document.ts cleanDocument), on a real DOM (jsdom).
import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import { zipEntries, zipRead } from '../../web/src/models/zip.ts'
import { cleanDocument } from '../../web/src/viewers/document.ts'
import { documentOf, UNPACKED_LIMIT } from '../../web/src/viewers/document-worker.ts'
import { deflatedRun, zip } from './support/zip.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** A raw deflate stream of one stored block: streams of texts of one length are of one length too. */
const storedBlock = (text: string): Buffer => {
  const data = Buffer.from(text)
  const head = Buffer.alloc(5)
  head.writeUInt8(1, 0)
  head.writeUInt16LE(data.length, 1)
  head.writeUInt16LE(~data.length & 0xffff, 3)
  return Buffer.concat([head, data])
}

/** A local header and its data: deflated, its sizes as given. */
function localPart(name: string, data: Buffer, size: number): Buffer {
  const n = Buffer.from(name)
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(20, 4)
  h.writeUInt16LE(8, 8)
  h.writeUInt32LE(data.length, 18)
  h.writeUInt32LE(size, 22)
  h.writeUInt16LE(n.length, 26)
  return Buffer.concat([h, n, data])
}

/** A directory record for a deflated part. */
function record(name: string, compressed: number, size: number, offset: number, extra = Buffer.alloc(0)): Buffer {
  const n = Buffer.from(name)
  const r = Buffer.alloc(46)
  r.writeUInt32LE(0x02014b50, 0)
  r.writeUInt16LE(45, 4)
  r.writeUInt16LE(20, 6)
  r.writeUInt16LE(8, 10)
  r.writeUInt32LE(compressed, 20)
  r.writeUInt32LE(size, 24)
  r.writeUInt16LE(n.length, 28)
  r.writeUInt16LE(extra.length, 30)
  r.writeUInt32LE(offset, 42)
  return Buffer.concat([r, n, extra])
}

/** A .docx of these parts, zipped. */
function docx(body: string, extra: { name: string; data: string; claims?: number }[] = []): ArrayBuffer {
  const parts: Record<string, string> = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/terms" TargetMode="External"/>' +
      '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
    'word/styles.xml': `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`,
    'word/document.xml': `<?xml version="1.0"?><w:document ${W} ${R}><w:body>${body}</w:body></w:document>`,
  }
  const bytes = zip([...Object.entries(parts).map(([name, data]) => ({ name, data })), ...extra])
  return bytes.buffer as ArrayBuffer
}

const run = (text: string, props = '') =>
  `<w:r>${props && `<w:rPr>${props}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`
const cell = (text: string, props = '') => `<w:tc>${props && `<w:tcPr>${props}</w:tcPr>`}<w:p>${run(text)}</w:p></w:tc>`

describe('a Word document as the worker reads it', () => {
  test('the title and headings, text, bold, a table and a web link come through as HTML', async () => {
    const reply = await documentOf(
      docx(
        `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run('Поставка')}</w:p>` +
          `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Договор № 17')}</w:p>` +
          `<w:p>${run('Поставщик обязуется ')}${run('передать', '<w:b/>')}${run(' товар.')}</w:p>` +
          `<w:tbl><w:tr>${cell('№')}${cell('Сумма')}</w:tr></w:tbl>` +
          `<w:p><w:hyperlink r:id="rId9">${run('условия &lt;script&gt;')}</w:hyperlink></w:p>`,
      ),
    )
    if (!reply.ok) throw new Error(reply.message)
    expect(reply.html).toContain('<h1>Поставка</h1><h1>Договор № 17</h1>')
    expect(reply.html).toContain('<p>Поставщик обязуется <strong>передать</strong> товар.</p>')
    expect(reply.html).toContain('<table><tr><td><p>№</p></td><td><p>Сумма</p></td></tr></table>')
    // Text stays text: the angle brackets come escaped.
    expect(reply.html).toContain('<a href="https://example.com/terms">условия &lt;script&gt;</a>')
  })

  test('merged cells keep their spans through the cleaning: "c" stays in the second column', async () => {
    const reply = await documentOf(
      docx(
        '<w:tbl>' +
          `<w:tr>${cell('a', '<w:gridSpan w:val="2"/>')}${cell('b', '<w:vMerge w:val="restart"/>')}</w:tr>` +
          `<w:tr>${cell('x')}${cell('c')}${cell('', '<w:vMerge/>')}</w:tr>` +
          '</w:tbl>',
      ),
    )
    if (!reply.ok) throw new Error(reply.message)
    expect(reply.html).toContain('<td colspan="2"><p>a</p></td><td rowspan="2"><p>b</p></td>')
    const table = clean(reply.html).querySelector('table')
    const [first, second] = [...(table?.querySelectorAll('tr') ?? [])]
    expect(
      [...(first?.children ?? [])].map(td => [td.textContent, td.getAttribute('colspan'), td.getAttribute('rowspan')]),
    ).toEqual([
      ['a', '2', null],
      ['b', null, '2'],
    ])
    expect([...(second?.children ?? [])].map(td => td.textContent)).toEqual(['x', 'c'])
  })

  test('a password, an old .doc, a broken file and one too big unpacked: said so, not drawn', async () => {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    const utf16 = (s: string) => [...s].flatMap(c => [c.charCodeAt(0), 0])
    const locked = new Uint8Array([...ole, ...new Array(500).fill(0), ...utf16('EncryptedPackage'), 0, 0])
    expect(await documentOf(locked.buffer)).toMatchObject({ ok: false, why: 'password' })
    const oldDoc = new Uint8Array([...ole, ...new Array(500).fill(0), ...utf16('WordDocument')])
    expect(await documentOf(oldDoc.buffer)).toMatchObject({ ok: false, why: 'broken' })
    const broken = new TextEncoder().encode('PK\u0003\u0004 not really a zip')
    expect(await documentOf(broken.buffer as ArrayBuffer)).toMatchObject({ ok: false, why: 'broken' })
    // A small zip whose picture unpacks to more than the limit (a zip bomb): not read.
    const bomb = docx(`<w:p>${run('x')}</w:p>`, [{ name: 'word/media/a.png', data: 'x', claims: UNPACKED_LIMIT }])
    expect(await documentOf(bomb)).toMatchObject({ ok: false, why: 'big' })
    // The same with 70 KB put after its end: the directory is found all the same.
    const tailed = new Uint8Array([...new Uint8Array(bomb), ...new Uint8Array(70 << 10)])
    expect(await documentOf(tailed.buffer)).toMatchObject({ ok: false, why: 'big' })
    // A second entry the counts leave out, and bytes before the archive: big, and broken.
    const understated = zip(
      [
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: 'x', claims: UNPACKED_LIMIT },
      ],
      { onDisk: 1, total: 1 },
    )
    expect(await documentOf(understated.buffer as ArrayBuffer)).toMatchObject({ ok: false, why: 'big' })
    const shifted = zip([{ name: 'word/document.xml', data: 'x', claims: UNPACKED_LIMIT }], { head: 16 })
    expect(await documentOf(shifted.buffer as ArrayBuffer)).toMatchObject({ ok: false, why: 'broken' })
    // Bytes between the directory and its end record, then a directory with the bomb: broken.
    const gapped = zip([{ name: 'word/document.xml', data: 'x' }], {
      gap: { bytes: 16, second: [{ name: 'word/document.xml', data: 'x', claims: UNPACKED_LIMIT }] },
    })
    expect(await documentOf(gapped.buffer as ArrayBuffer)).toMatchObject({ ok: false, why: 'broken' })
  })

  test('JSZip reads the part the worker counted, not the one its own reading of ZIP64 finds (#230)', async () => {
    // The document's record gives its offset in ZIP64 blocks, twice: the worker reads the first
    // (the document that says "ours"), JSZip on its own the last (one that says "theirs").
    const xml = (word: string) =>
      `<?xml version="1.0"?><w:document ${W}><w:body><w:p>${run(word)}</w:p></w:body></w:document>`
    const plain = new Uint8Array(docx(''))
    const kept = (zipEntries(plain) ?? []).filter(e => e.name === '[Content_Types].xml' || e.name === '_rels/.rels')
    const locals: Buffer[] = []
    const records: Buffer[] = []
    let at = 0
    const add = (name: string, data: Buffer, size: number) => {
      const offset = at
      locals.push(localPart(name, data, size))
      at += locals.at(-1)?.length ?? 0
      return offset
    }
    for (const e of kept) {
      const text = Buffer.from(await zipRead(plain, e))
      const data = deflateRawSync(text)
      records.push(record(e.name, data.length, text.length, add(e.name, data, text.length)))
    }
    const ours = storedBlock(xml('ours__'))
    const oursAt = add('word/document.xml', ours, xml('ours__').length)
    const theirsAt = add('word/document.xml', storedBlock(xml('theirs')), xml('theirs').length)
    const extra = Buffer.alloc(24)
    for (const [i, offset] of [oursAt, theirsAt].entries()) {
      extra.writeUInt16LE(1, i * 12)
      extra.writeUInt16LE(8, i * 12 + 2)
      extra.writeBigUInt64LE(BigInt(offset), i * 12 + 4)
    }
    records.push(record('word/document.xml', ours.length, xml('ours__').length, 0xffffffff, extra))
    const directory = Buffer.concat(records)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(records.length, 8)
    end.writeUInt16LE(records.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(at, 16)
    const bytes = new Uint8Array(Buffer.concat([...locals, directory, end]))
    const reply = await documentOf(bytes.buffer as ArrayBuffer)
    if (!reply.ok) throw new Error(reply.message)
    expect(reply.html).toContain('ours__')
    expect(reply.html).not.toContain('theirs')
  })

  test('a document.xml whose directory says 100 bytes but which unpacks past the limit: too big, before JSZip unpacks it (#230)', async () => {
    const plain = new Uint8Array(docx(`<w:p>${run('x')}</w:p>`))
    const kept = (zipEntries(plain) ?? []).filter(e => e.name !== 'word/document.xml')
    const parts = await Promise.all(kept.map(async e => ({ name: e.name, data: await zipRead(plain, e) })))
    const mb = (UNPACKED_LIMIT >> 20) + 1
    const document = deflatedRun(
      `<?xml version="1.0"?><w:document ${W} ${R}><w:body><w:p>`,
      mb,
      '</w:p></w:body></w:document>',
    )
    const lying = zip([...parts, { name: 'word/document.xml', data: '', deflated: document, claims: 100 }])
    const reply = await documentOf(lying.buffer as ArrayBuffer)
    expect(reply).toMatchObject({ ok: false, why: 'big' })
  })
})

const window = new JSDOM('').window
const purify = createDOMPurify(window as never)

/** The HTML cleaned as the page cleans it, in a container to read it from. */
function clean(html: string): Element {
  const box = window.document.createElement('div')
  box.append(cleanDocument(html, purify) as never)
  return box as unknown as Element
}

describe('a Word document cleaned before it is drawn', () => {
  test('pictures only as data: URLs of the kinds a browser draws', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const box = clean(
      [png, 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/x-emf;base64,AAAA', 'data:image/x-wmf;base64,AAAA']
        .concat(['data:text/html;base64,PGI+', 'https://evil.example/p.png', 'javascript:alert(1)'])
        .map(src => `<p><img src="${src}" alt="a"></p>`)
        .join(''),
    )
    expect([...box.querySelectorAll('img')].map(img => img.getAttribute('src'))).toEqual([png])
  })

  test('no script, no handler, no data-* or aria-*; web links for the board to open, places kept, others dropped', () => {
    const box = clean(
      '<p onclick="x()" data-fs="file" data-abs="C:\\x" aria-label="y" style="color:red" class="z">t<script>alert(1)</script></p>' +
        '<p><a href="https://example.com/a">web</a> <a href="#footnote-1" id="footnote-ref-1">1</a> <a href="javascript:alert(1)">js</a> <a href="file:///C:/x">file</a></p>' +
        // DOMPurify checks these with their control characters taken out but keeps them as they are.
        '<p><a href="ht\ntps://evil.example/x">split</a> <a href="\u0001https://evil.example/x">control</a> <a href="data:text/html,<b>x</b>">data</a></p>' +
        '<iframe src="https://example.com"></iframe><form><input></form><style>p{}</style>',
    )
    expect(box.querySelector('script, iframe, form, input, style')).toBeNull()
    const p = box.querySelector('p')
    expect(p?.getAttributeNames().sort()).toEqual(['dir'])
    const links = [...box.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href'), a.className, a.id])
    expect(links).toEqual([
      ['web', 'https://example.com/a', 'ext', ''],
      ['1', '#footnote-1', '', 'user-content-footnote-ref-1'],
      ['js', null, '', ''],
      ['file', null, '', ''],
      ['split', null, '', ''],
      ['control', null, '', ''],
      ['data', null, '', ''],
    ])
  })

  test('each block reads in its own direction', () => {
    const box = clean('<h1>Заголовок</h1><p>שלום</p><ul><li>a</li></ul><table><tr><td>b</td></tr></table>')
    expect([...box.querySelectorAll('h1, p, li, td')].map(el => el.getAttribute('dir'))).toEqual([
      'auto',
      'auto',
      'auto',
      'auto',
    ])
  })
})
