// The Word viewer's worker (#176): reads a .docx with mammoth off the page's thread and answers
// its HTML, which viewers/document.ts cleans and draws. Headings, paragraphs, lists, tables,
// bold and italic, links, footnotes and pictures (as data: URLs) come through; what has no HTML
// counterpart (fonts, colors, page layout) is dropped, not imitated. Bundled apart from app.js
// (server/viewers.ts); it reads the file through the board's file route, with its token.
import mammoth from 'mammoth'
import { unpackedSize, zipEntries } from '../models/zip.ts'

export type DocumentReply =
  | { ok: true; html: string }
  | { ok: false; why: 'password' | 'broken' | 'big' | 'other'; message: string }

/** A document unpacked to more than this is not read (a zip of 400 KB can hold 400 MB): too big to show here. */
export const UNPACKED_LIMIT = 150 << 20

const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/** The name of the stream an encrypted Office file keeps its package in, as UTF-16 (MS-OFFCRYPTO). */
const ENCRYPTED = new Uint8Array([...'EncryptedPackage'].flatMap(c => [c.charCodeAt(0), 0]))

function contains(bytes: Uint8Array, part: Uint8Array): boolean {
  outer: for (let i = 0; i <= bytes.length - part.length; i++) {
    for (let j = 0; j < part.length; j++) if (bytes[i + j] !== part[j]) continue outer
    return true
  }
  return false
}

// A document's title and subtitle as headings too; Word's own headings mammoth knows already.
const STYLES = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"]

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * A .docx's HTML. A password makes it an OLE file holding an encrypted package, not a zip; any
 * other OLE file (an old .doc renamed) is not one mammoth reads.
 */
export async function documentOf(buffer: ArrayBuffer): Promise<DocumentReply> {
  const bytes = new Uint8Array(buffer)
  if (OLE.every((b, i) => bytes[i] === b)) {
    const locked = contains(bytes, ENCRYPTED)
    return { ok: false, why: locked ? 'password' : 'broken', message: locked ? 'encrypted' : 'not a .docx' }
  }
  const entries = zipEntries(bytes)
  // A .docx that is not an OLE file is a zip, and one whose directory cannot be read is not handed
  // on: its size unread is not known (JSZip also reads a zip after bytes put before it).
  if (!entries) return { ok: false, why: 'broken', message: 'no central directory' }
  if (entries && unpackedSize(entries) > UNPACKED_LIMIT)
    return { ok: false, why: 'big', message: `${unpackedSize(entries)} bytes unpacked` }
  try {
    // The browser build (bundled for the page) takes the ArrayBuffer; the Node build (Bun, in the
    // tests) the same bytes as a Buffer.
    const input = typeof Buffer === 'undefined' ? { arrayBuffer: buffer } : { buffer: Buffer.from(buffer) }
    const { value } = await mammoth.convertToHtml(input, { styleMap: STYLES })
    return { ok: true, html: value }
  } catch (err) {
    return { ok: false, why: 'broken', message: messageOf(err) }
  }
}

async function answer(url: string): Promise<DocumentReply> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { ok: false, why: 'other', message: `${res.status} ${res.statusText}` }
    return await documentOf(await res.arrayBuffer())
  } catch (err) {
    return { ok: false, why: 'other', message: messageOf(err) }
  }
}

// In a worker only: the tests import this module for what it reads, not to answer.
if ('WorkerGlobalScope' in globalThis)
  self.onmessage = async (e: MessageEvent<{ url: string }>) => postMessage(await answer(e.data.url))
