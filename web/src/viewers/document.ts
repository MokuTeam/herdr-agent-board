// The quick look's Word viewer (#176): a worker reads the .docx into HTML (document-worker.ts),
// and this cleans it before it is drawn: only the tags mammoth writes for text, lists, tables,
// links and pictures; links to the web only, opened by the board in the default browser
// (hooks/useFileLinks.ts); pictures only as data: URLs; no script, style, frame or form, and no
// attribute but these few. Links inside the document (a footnote) scroll to their place. Bundled
// apart from app.js (server/viewers.ts), imported when a .docx is opened.
import DOMPurify from 'dompurify'
import type { DocumentReply } from './document-worker.ts'
import type { OfficeOptions, OfficeViewer } from './office.ts'

// What mammoth writes: text, structure, links and pictures.
const TAGS =
  'p h1 h2 h3 h4 h5 h6 strong b em i u s sup sub br ul ol li table thead tbody tr th td blockquote pre code a img'

/** Web links, places in the document, and pictures as data: URLs of the kinds a browser draws. */
const URIS = /^(?:https?:\/\/|#|data:image\/(?:png|jpe?g|gif|webp|bmp);base64,)/i

/** The document's HTML, cleaned: what is left is only text, structure, web links and pictures. */
export function cleanDocument(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: TAGS.split(' '),
    ALLOWED_ATTR: ['href', 'src', 'alt', 'colspan', 'rowspan', 'id'],
    ALLOWED_URI_REGEXP: URIS,
    // Ids as user-content-…: none can stand for one of the page's own.
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  })
  for (const a of fragment.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    // The board opens a web link in the default browser (a.ext, hooks/useFileLinks.ts).
    if (/^https?:/i.test(a.getAttribute('href') ?? '')) a.className = 'ext'
  }
  // A picture of a kind no browser draws (EMF, WMF) has no source left: it goes, not a broken frame.
  for (const img of fragment.querySelectorAll('img:not([src])')) img.remove()
  return fragment
}

export function mount(host: HTMLElement, opts: OfficeOptions): OfficeViewer {
  const worker = new Worker(opts.worker, { type: 'module' })
  let done = false
  worker.onmessage = (e: MessageEvent<DocumentReply>) => {
    done = true
    worker.terminate()
    const reply = e.data
    if (!reply.ok) return opts.onFail(reply.why, reply.message)
    const article = document.createElement('article')
    article.className = 'md ql-md ql-doc'
    article.append(cleanDocument(reply.html))
    host.replaceChildren(article)
    opts.onReady()
  }
  worker.onerror = e => {
    if (!done) opts.onFail('other', e.message)
    done = true
  }
  worker.postMessage({ url: opts.url })
  // A link to a place in the document scrolls there; the page's own address (its #) stays.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="#"]')
    if (!a || !host.contains(a)) return
    e.preventDefault()
    const id = `user-content-${decodeURIComponent((a.getAttribute('href') ?? '').slice(1))}`
    host.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })
  }
  host.addEventListener('click', onClick)
  return {
    destroy() {
      done = true
      worker.terminate()
      host.removeEventListener('click', onClick)
      host.replaceChildren()
    },
  }
}
