// The little of a zip the Office workers read themselves (models/zip.ts, #176): how big it is
// unpacked by its central directory, before a library unpacks all of it; a part's first bytes,
// or all of it.
import { describe, expect, test } from 'bun:test'
import { looksLikeZip, storedZip, unpackedSize, zipEntries, zipRead, zipText } from '../../web/src/models/zip.ts'
import { deflatedRun, zip } from './support/zip.ts'

describe('a zip read by its central directory', () => {
  const body = `<worksheet><sheetViews><pane ySplit="1" state="frozen"/></sheetViews><sheetData>${'<row/>'.repeat(50_000)}</sheetData></worksheet>`
  const bytes = zip([
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships/>', stored: true },
    { name: 'xl/worksheets/sheet1.xml', data: body },
  ])

  test('its parts, their sizes unpacked, and a part as text: all of it or its head', async () => {
    const entries = zipEntries(bytes)
    expect(entries?.map(e => [e.name, e.method, e.size])).toEqual([
      ['xl/_rels/workbook.xml.rels', 0, 16],
      ['xl/worksheets/sheet1.xml', 8, body.length],
    ])
    expect(unpackedSize(entries ?? [])).toBe(16 + body.length)
    expect(await zipText(bytes, entries ?? [], 'xl/_rels/workbook.xml.rels')).toBe('<Relationships/>')
    expect(await zipText(bytes, entries ?? [], 'xl/worksheets/sheet1.xml')).toBe(body)
    const head = await zipText(bytes, entries ?? [], 'xl/worksheets/sheet1.xml', 1024)
    expect(head.startsWith('<worksheet><sheetViews><pane ySplit="1"')).toBe(true)
    expect(head.length).toBeLessThan(body.length)
    expect(await zipText(bytes, entries ?? [], 'missing.xml')).toBe('')
  })

  test('a part that claims more than it holds counts at its claim; ZIP64 sizes count as no end', async () => {
    const bomb = zipEntries(zip([{ name: 'xl/worksheets/sheet1.xml', data: 'x', claims: 400 << 20 }]))
    expect(unpackedSize(bomb ?? [])).toBe(400 << 20)
    // 0xFFFFFFFF with no ZIP64 extra field to say otherwise: no end.
    const huge = zipEntries(zip([{ name: 'a', data: 'x', claims: 0xffffffff }]))
    expect(unpackedSize(huge ?? [])).toBe(Number.POSITIVE_INFINITY)
  })

  test('not a zip: none', async () => {
    expect(zipEntries(new TextEncoder().encode('nonsense, really'))).toBeNull()
    expect(zipEntries(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBeNull()
    const entries = zipEntries(bytes) ?? []
    const stored = entries[0]
    if (!stored) throw new Error('no part')
    expect([...(await zipRead(bytes, stored, 4))]).toEqual([...new TextEncoder().encode('<Rel')])
  })
})

// #229's second review: what could slip a zip past the directory's sizes.
describe('a zip that tries to hide its size', () => {
  const bomb = [{ name: 'xl/worksheets/sheet1.xml', data: 'x', claims: 400 << 20 }]

  test('bytes after its end (past a comment’s 64 KB) do not hide the directory', () => {
    const tailed = zip(bomb, { tail: 70 << 10 })
    expect(unpackedSize(zipEntries(tailed) ?? [])).toBe(400 << 20)
    expect(looksLikeZip(tailed)).toBe(true)
  })

  test('the entries are counted by the larger of this disk’s and the total', () => {
    const parts = [
      { name: 'a', data: 'x' },
      { name: 'b', data: 'y', claims: 400 << 20 },
    ]
    expect(zipEntries(zip(parts, { total: 1 }))?.length).toBe(2)
    expect(zipEntries(zip(parts, { onDisk: 1 }))?.length).toBe(2)
  })

  test('a part is never read past what the directory says it holds', async () => {
    const bytes = zip([{ name: 'a', data: 'y'.repeat(100_000), claims: 10 }])
    const [entry] = zipEntries(bytes) ?? []
    if (!entry) throw new Error('no part')
    expect((await zipRead(bytes, entry)).length).toBe(10)
  })

  test('ZIP64 sizes from the extra field: a small part is small, a big one big', () => {
    expect(unpackedSize(zipEntries(zip([{ name: 'a', data: 'xyz', zip64: true }])) ?? [])).toBe(3)
    expect(unpackedSize(zipEntries(zip([{ name: 'a', data: 'x', zip64: true, claims: 5 * 2 ** 32 }])) ?? [])).toBe(
      5 * 2 ** 32,
    )
  })
})

// #229's final review: the directory read as JSZip (mammoth's) reads it.
describe('a zip’s directory as JSZip reads it', () => {
  const heavy = { name: 'word/document.xml', data: 'x', claims: 200 << 20 }

  test('every entry while the signature goes on, whatever the counts say', () => {
    const understated = zip([{ name: 'a', data: 'x' }, heavy], { onDisk: 1, total: 1 })
    expect(zipEntries(understated)?.map(e => e.name)).toEqual(['a', 'word/document.xml'])
    expect(unpackedSize(zipEntries(understated) ?? [])).toBe(1 + (200 << 20))
    // Fewer entries there than the counts say: no directory.
    expect(zipEntries(zip([{ name: 'a', data: 'x' }], { onDisk: 3, total: 3 }))).toBeNull()
  })

  test('the ZIP64 end record by its locator, and through a classic record that points to a decoy', () => {
    const parts = [{ name: 'a', data: 'xyz' }, heavy]
    expect(zipEntries(zip(parts, { zip64End: {} }))?.map(e => [e.name, e.size])).toEqual([
      ['a', 3],
      ['word/document.xml', 200 << 20],
    ])
    // Only the classic directory's size is full, and a decoy directory sits between the real one
    // and the ZIP64 record: the record does not follow its directory, and there is none to read.
    expect(zipEntries(zip(parts, { zip64End: { decoy: ['a'] } }))).toBeNull()
  })

  test('a directory that does not end where its end record starts: none (JSZip would read another)', () => {
    // A harmless directory where the end record says, 16 bytes, then one that claims 160 MB.
    const shifted = zip([{ name: 'a', data: 'x' }], {
      gap: { bytes: 16, second: [{ name: 'a', data: 'x', claims: 160 << 20 }] },
    })
    expect(zipEntries(shifted)).toBeNull()
    expect(zipEntries(zip([{ name: 'a', data: 'x' }]))?.length).toBe(1)
  })
})

// #230: the directory's sizes can lie, and JSZip and SheetJS each read a zip's headers their own
// way: the libraries get the parts as they really unpack, in a stored zip of the worker's making.
describe('the zip the libraries are given', () => {
  const MB = 1 << 20
  const rezip = (bytes: Uint8Array, limit = MB) => storedZip(bytes, zipEntries(bytes) ?? [], limit)

  /** Every header of a zip: what its local headers and directory records say, and its end record's place. */
  function headers(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const end = bytes.length - 22
    const parts = (zipEntries(bytes) ?? []).map(e => ({
      name: e.name,
      method: e.method,
      local: [8, 18, 22, 28].map(
        at =>
          view.getUint16(e.offset + at, true) +
          (at === 18 || at === 22 ? view.getUint16(e.offset + at + 2, true) * 65536 : 0),
      ),
      central: [10, 20, 24, 30, 32].map(at =>
        at === 20 || at === 24 ? view.getUint32(e.record + at, true) : view.getUint16(e.record + at, true),
      ),
    }))
    return { parts, end: view.getUint32(end, true) === 0x06054b50, comment: view.getUint16(end + 20, true) }
  }

  test('a truthful zip: its parts stored as they unpack, the same bytes, nothing in the headers but the sizes', async () => {
    const xml = '<a/>'.repeat(1000)
    const bytes = zip([
      { name: 'a.xml', data: xml },
      { name: 'b.bin', data: 'stored', stored: true },
    ])
    const out = await rezip(bytes)
    if (!out.ok) throw new Error(out.why)
    expect(out.size).toBe(4006)
    const entries = zipEntries(out.bytes) ?? []
    expect(await zipText(out.bytes, entries, 'a.xml')).toBe(xml)
    expect(await zipText(out.bytes, entries, 'b.bin')).toBe('stored')
    expect(headers(out.bytes)).toEqual({
      parts: [
        // method 0; local: method, compressed and unpacked size, no extra field
        { name: 'a.xml', method: 0, local: [0, 4000, 4000, 0], central: [0, 4000, 4000, 0, 0] },
        { name: 'b.bin', method: 0, local: [0, 6, 6, 0], central: [0, 6, 6, 0, 0] },
      ],
      end: true,
      comment: 0,
    })
  })

  test('a part that says 100 bytes and unpacks to 64 MB: too big, the inflating stopped soon past the limit', async () => {
    const bytes = zip([
      { name: 'xl/worksheets/sheet1.xml', data: '', deflated: deflatedRun('<a>', 64, '</a>'), claims: 100 },
    ])
    expect(unpackedSize(zipEntries(bytes) ?? [])).toBe(100)
    const out = await rezip(bytes)
    expect(out).toMatchObject({ ok: false, why: 'big' })
    // one step of 4 KB unpacks to 4.2 MB at most: no more than that is counted past the limit
    expect(out.size).toBeGreaterThan(MB)
    expect(out.size).toBeLessThan(MB + 5 * MB)
  })

  test('a data descriptor (the local sizes 0) that says 100 bytes: counted as it unpacks', async () => {
    const lying = zip([{ name: 'xl/media/a.bin', data: new Uint8Array(2 * MB), claims: 100, descriptor: true }])
    expect(await rezip(lying)).toMatchObject({ ok: false, why: 'big' })
    const truthful = zip([{ name: 'xl/media/a.bin', data: 'abc'.repeat(100), descriptor: true }])
    const out = await rezip(truthful)
    if (!out.ok) throw new Error(out.why)
    expect(await zipText(out.bytes, zipEntries(out.bytes) ?? [], 'xl/media/a.bin')).toBe('abc'.repeat(100))
  })

  test('a deflate stream that does not end at its compressed size, or a part past the file’s end: broken', async () => {
    const runsOn = zip([{ name: 'a.xml', data: new Uint8Array(MB), claimsCompressed: 64 }])
    expect(await rezip(runsOn)).toMatchObject({ ok: false, why: 'broken' })
    const shortStream = zip([
      { name: 'a.xml', data: '<a/>', claimsCompressed: 2000 },
      { name: 'b.bin', data: new Uint8Array(4000), stored: true },
    ])
    expect(await rezip(shortStream)).toMatchObject({ ok: false, why: 'broken' })
    const pastEnd = zip([{ name: 'a.bin', data: 'plain', stored: true, claimsCompressed: 1 << 20 }])
    expect(await rezip(pastEnd)).toMatchObject({ ok: false, why: 'broken' })
  })

  test('the hints a library would size by never reach it: a local size of 4 GB, ZIP64 extras, a comment', async () => {
    // the part's local header says it unpacks to 0xFFFFFFFF (SheetJS allocates that much first),
    // its directory record carries two ZIP64 blocks, and the end record a comment
    const plain = zip([{ name: 'xl/workbook.xml', data: '<workbook/>' }])
    const bytes = new Uint8Array(plain)
    const view = new DataView(bytes.buffer)
    view.setUint32(22, 0xffffffff, true)
    const out = await rezip(withExtraAndComment(bytes))
    if (!out.ok) throw new Error(out.why)
    expect(headers(out.bytes)).toEqual({
      parts: [{ name: 'xl/workbook.xml', method: 0, local: [0, 11, 11, 0], central: [0, 11, 11, 0, 0] }],
      end: true,
      comment: 0,
    })
  })
})

/** The zip with two ZIP64 blocks in its one directory record's extra field and a comment on its end record. */
function withExtraAndComment(bytes: Uint8Array): Uint8Array {
  const entry = (zipEntries(bytes) ?? [])[0]
  if (!entry) throw new Error('no part')
  const nameEnd = entry.record + 46 + new DataView(bytes.buffer).getUint16(entry.record + 28, true)
  const extra = new Uint8Array(24)
  const xv = new DataView(extra.buffer)
  for (const at of [0, 12]) {
    xv.setUint16(at, 1, true)
    xv.setUint16(at + 2, 8, true)
    xv.setUint32(at + 4, 0x7fffffff, true)
  }
  const comment = new TextEncoder().encode('PK\u0006\u0007 not a locator')
  const end = bytes.length - 22
  const out = new Uint8Array([
    ...bytes.subarray(0, nameEnd),
    ...extra,
    ...bytes.subarray(nameEnd, end),
    ...bytes.subarray(end),
    ...comment,
  ])
  const view = new DataView(out.buffer)
  view.setUint16(entry.record + 30, extra.length, true)
  view.setUint32(end + extra.length + 12, view.getUint32(end + extra.length + 12, true) + extra.length, true)
  view.setUint16(end + extra.length + 20, comment.length, true)
  return out
}
