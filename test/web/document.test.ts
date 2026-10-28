// A Word document as the quick look's worker reads it (viewers/document-worker.ts, #176): its
// headings, text, lists, tables and web links as HTML; a password, an old .doc or a broken file
// said so instead. (Its cleaning runs in the page, on a real DOM: the live check covers it.)
import { describe, expect, test } from 'bun:test'
import { CFB } from 'xlsx'
import { documentOf } from '../../web/src/viewers/document-worker.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** A .docx of these parts, zipped. */
function docx(body: string): ArrayBuffer {
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
  const zip = CFB.utils.cfb_new()
  for (const [name, text] of Object.entries(parts)) CFB.utils.cfb_add(zip, name, new TextEncoder().encode(text))
  const bytes = CFB.write(zip, { fileType: 'zip', type: 'array' }) as Uint8Array | number[]
  return new Uint8Array(bytes).buffer
}

const run = (text: string, props = '') =>
  `<w:r>${props && `<w:rPr>${props}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`

describe('a Word document as the worker reads it', () => {
  test('the title and headings, text, bold, a table and a web link come through as HTML', async () => {
    const reply = await documentOf(
      docx(
        `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${run('Поставка')}</w:p>` +
          `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Договор № 17')}</w:p>` +
          `<w:p>${run('Поставщик обязуется ')}${run('передать', '<w:b/>')}${run(' товар.')}</w:p>` +
          `<w:tbl><w:tr><w:tc><w:p>${run('№')}</w:p></w:tc><w:tc><w:p>${run('Сумма')}</w:p></w:tc></w:tr></w:tbl>` +
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

  test('a password, an old .doc and a broken file: said so, not drawn', async () => {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
    const utf16 = (s: string) => [...s].flatMap(c => [c.charCodeAt(0), 0])
    const locked = new Uint8Array([...ole, ...new Array(500).fill(0), ...utf16('EncryptedPackage'), 0, 0])
    expect(await documentOf(locked.buffer)).toMatchObject({ ok: false, why: 'password' })
    const oldDoc = new Uint8Array([...ole, ...new Array(500).fill(0), ...utf16('WordDocument')])
    expect(await documentOf(oldDoc.buffer)).toMatchObject({ ok: false, why: 'broken' })
    const broken = new TextEncoder().encode('PK\u0003\u0004 not really a zip')
    expect(await documentOf(broken.buffer as ArrayBuffer)).toMatchObject({ ok: false, why: 'broken' })
  })
})
