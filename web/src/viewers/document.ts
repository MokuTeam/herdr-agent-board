// The quick look's Word viewer (#176): a worker reads the .docx into HTML (document-worker.ts),
// and this cleans it before it is drawn: only the tags mammoth writes for text, lists, tables,
// links and pictures; links to the web only, opened by the board in the default browser
// (hooks/useFileLinks.ts); pictures only as data: URLs of the kinds a browser draws; no script,
// style, frame or form, and no attribute but these few (no data-* or aria-*, which the page acts
// on). Each block reads in its own direction. Links inside the document (a footnote) scroll to
// their place. The cleaning runs on the page's thread (DOMPurify needs a document): about a
// second for a document of tens of thousands of paragraphs. Bundled apart from app.js
// (server/viewers.ts), imported when a .docx is opened.
import DOMPurify from 'dompurify'
import type { DocumentReply } from './document-worker.ts'
import { type OfficeOptions, type OfficeViewer, WORKER_TIMEOUT_MS } from './office.ts'

// What mammoth writes: text, structure, links and pictures.
const TAGS =
  'p h1 h2 h3 h4 h5 h6 strong b em i u s sup sub br ul ol li table thead tbody tr th td blockquote pre code a img'

/** Web links and places in the document; pictures as data: URLs (kept only as PICTURE has them). */
const URIS = /^(?:https?:\/\/|#|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i

/** A picture a browser draws, in the document itself: not SVG, EMF, WMF, a page, nor an address. */
const PICTURE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, pre'

/** The document's HTML, cleaned (by `purify`, DOMPurify over a document): only text, structure, web links and pictures. */
export function cleanDocument(html: string, purify: typeof DOMPurify = DOMPurify): DocumentFragment {
  const fragment = purify.sanitize(html, {
    ALLOWED_TAGS: TAGS.split(' '),
    ALLOWED_ATTR: ['href', 'src', 'alt', 'colspan', 'rowspan', 'id'],
    ALLOWED_URI_REGEXP: URIS,
    // A table's spans are numbers, not addresses: without this, the address rule takes them out.
    ADD_URI_SAFE_ATTR: ['colspan', 'rowspan'],
    // The page acts on data-* (a file chip is [data-fs]) and reads aria-*: none from a document.
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // Ids as user-content-…: none can stand for one of the page's own.
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  })
  for (const a of fragment.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    // The board opens a web link in the default browser (a.ext, hooks/useFileLinks.ts).
    if (/^https?:/i.test(a.getAttribute('href') ?? '')) a.className = 'ext'
  }
  // DOMPurify lets any data: URL through on a picture, and web addresses as links may be: a
  // picture that is not one of the document's own, of a kind a browser draws, goes (not a broken frame).
  for (const img of fragment.querySelectorAll('img')) if (!PICTURE.test(img.getAttribute('src') ?? '')) img.remove()
  // A paragraph in Arabic or Hebrew reads right to left, one in English beside it left to right.
  for (const block of fragment.querySelectorAll(BLOCKS)) block.setAttribute('dir', 'auto')
  return fragment
}

/** The id a link to a place in the document goes to ('' for an address that does not decode). */
function placeOf(href: string): string {
  try {
    return `user-content-${decodeURIComponent(href.slice(1))}`
  } catch {
    return ''
  }
}

export function mount(host: HTMLElement, opts: OfficeOptions): OfficeViewer {
  const worker = new Worker(opts.worker, { type: 'module' })
  let done = false
  const finish = () => {
    done = true
    clearTimeout(slow)
    worker.terminate()
  }
  // A worker that takes this long is on a document too big to show here.
  const slow = setTimeout(() => {
    if (done) return
    finish()
    opts.onFail('big', 'no answer in time')
  }, WORKER_TIMEOUT_MS)
  worker.onmessage = (e: MessageEvent<DocumentReply>) => {
    finish()
    const reply = e.data
    if (!reply.ok) return opts.onFail(reply.why, reply.message)
    const article = document.createElement('article')
    article.className = 'md ql-md ql-doc'
    article.append(cleanDocument(reply.html))
    host.replaceChildren(article)
    opts.onReady()
  }
  worker.onerror = e => {
    if (done) return
    finish()
    opts.onFail('other', e.message)
  }
  worker.postMessage({ url: opts.url })
  // A link to a place in the document scrolls there; the page's own address (its #) stays.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="#"]')
    if (!a || !host.contains(a)) return
    e.preventDefault()
    const id = placeOf(a.getAttribute('href') ?? '')
    if (id) host.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })
  }
  host.addEventListener('click', onClick)
  return {
    destroy() {
      finish()
      host.removeEventListener('click', onClick)
      host.replaceChildren()
    },
  }
}
