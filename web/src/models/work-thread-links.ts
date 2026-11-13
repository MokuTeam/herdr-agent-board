// Thread keys in drawn text as links (#392, docs/design/threads 8): the text nodes of an element
// (a bubble's Markdown) get each known key wrapped in a link to #thread=<key>, which the page opens
// in the threads panel (hooks/useThreadLinks.ts). Text in links, code and buttons is left alone.
import { keyParts } from './work-threads.ts'

const SKIP = 'a, code, pre, button, textarea, input, [data-fs]'

/** Wraps every known key in `root`'s text in a link; how many it wrapped. */
export function linkKeys(root: Element, known: ReadonlySet<string>): number {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement
    if (parent && !parent.closest(SKIP) && /\d/.test(n.nodeValue ?? '')) texts.push(n as Text)
  }
  let wrapped = 0
  for (const node of texts) {
    const parts = keyParts(node.nodeValue ?? '', known)
    if (parts.length === 1 && typeof parts[0] === 'string') continue
    const frag = doc.createDocumentFragment()
    for (const p of parts) {
      if (typeof p === 'string') frag.append(p)
      else {
        const a = doc.createElement('a')
        a.className = 'wt-keylink'
        a.href = `#thread=${encodeURIComponent(p.key)}`
        a.textContent = p.key
        frag.append(a)
        wrapped++
      }
    }
    node.replaceWith(frag)
  }
  return wrapped
}
