// A Word document in the quick look (#176): as its worker reads it (viewers/document-worker.ts),
// headings, text, lists, tables with merged cells and web links as HTML, a password, an old
// .doc, a broken file or one too big said so instead; and as the page cleans it before it is
// drawn (viewers/document.ts cleanDocument), on a real DOM (jsdom).
import { describe, expect, test } from 'bun:test'
import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import { cleanDocument } from '../../web/src/viewers/document.ts'
import { documentOf, UNPACKED_LIMIT } from '../../web/src/viewers/document-worker.ts'
import { zip } from './support/zip.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

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
