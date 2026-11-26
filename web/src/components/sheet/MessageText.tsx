// A message's text in its bubble (Thread.tsx, and ThreadLinks.tsx PeerBubble): Markdown, whole.
// One taller than two screens (models/thread.ts folds) folds there, with "Show all" under it that
// turns into "Show less" once open. What is folded away is drawn all the same, for a selection to
// copy and for its file chips, but out of the Tab order: the keyboard reaches "Show all" first. A
// message the thread's budget cut says so under it (core/transcript.ts fitThread). `plain` keeps
// the text as it came, for an answer to a question form (#187).
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useThreadsContext } from '../../hooks/useThreads.tsx'
import { useT } from '../../i18n/I18nProvider.tsx'
import { markdown } from '../../models/markdown.ts'
import { FOLD_SCREENS, folds } from '../../models/thread.ts'
import { linkKeys } from '../../models/work-thread-links.ts'

export interface MessageTextProps {
  text: string
  /** The thread's budget cut it. */
  cut?: boolean | undefined
  /** It opened or folded again: the thread changed height where the reader is. */
  onResize?: (() => void) | undefined
  /** The text as it came, not Markdown, in a span (an answer's own element, a flex item there). */
  plain?: boolean | undefined
  /** The text's own class; Markdown's `md` by default. */
  className?: string | undefined
  /** Marks up the Markdown's HTML once more (a Team message's leading mention, #875); it adds tags, never text. */
  decorate?: ((html: string) => string) | undefined
}

export function MessageText({
  text,
  cut = false,
  onResize,
  plain = false,
  className = 'md',
  decorate,
}: MessageTextProps) {
  const t = useT()
  const id = useId()
  const body = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const screen = useScreenHeight()
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  // Threads (#392): the known keys in the text become links to them; off, the text is left alone.
  const known = useThreadsContext()?.known
  // biome-ignore lint/correctness/useExhaustiveDependencies: new text is drawn afresh and linked again
  useLayoutEffect(() => {
    if (known?.size && body.current) linkKeys(body.current, known)
  }, [text, known])
  // Measured when drawn, when its text or the window's height changes, and when its box does (a
  // narrower panel).
  // biome-ignore lint/correctness/useExhaustiveDependencies: new text is when to measure, not what it reads
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const measure = () => setLong(folds(el.scrollHeight, screen))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [text, screen])
  const folded = long && !open
  useLayoutEffect(() => {
    const el = body.current
    if (el && folded) return outOfTabOrder(el)
  }, [folded])
  // Opened, or folded again (then "Show less" comes back into view where it went up to).
  const before = useRef(open)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a toggle is when to say so; onResize is new every draw
  useLayoutEffect(() => {
    if (before.current === open) return
    before.current = open
    if (!open) toggle.current?.scrollIntoView?.({ block: 'nearest' })
    onResize?.()
  }, [open])
  const box = {
    ref: body,
    id: long ? id : undefined,
    className: folded ? `${className} folded` : className,
    style: folded ? { maxHeight: FOLD_SCREENS * screen } : undefined,
  }
  return (
    <>
      {plain ? (
        <span {...box}>{text}</span>
      ) : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags
        <div {...box} dangerouslySetInnerHTML={{ __html: decorate ? decorate(markdown(text)) : markdown(text) }} />
      )}
      {cut && <p className="msg-cut">{t('thread.cut')}</p>}
      {long && (
        <button
          ref={toggle}
          type="button"
          className="unfold"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {t(open ? 'thread.less' : 'thread.whole')}
        </button>
      )}
    </>
  )
}

/** The window's height, kept as it changes: what "a screen" is for the fold. */
function useScreenHeight(): number {
  const [height, setHeight] = useState(() => (typeof window === 'undefined' ? 0 : window.innerHeight))
  useEffect(() => {
    const resized = () => setHeight(window.innerHeight)
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [])
  return height
}

/**
 * Takes what can take focus under `root` out of the Tab order until the returned undo puts it
 * back; what becomes focusable meanwhile too (a file chip, once the server knows its path).
 */
function outOfTabOrder(root: HTMLElement): () => void {
  const was = new Map<Element, string | null>()
  const skip = () => {
    for (const el of root.querySelectorAll('a[href], button, [tabindex]')) {
      const tab = el.getAttribute('tabindex')
      if (tab === '-1') continue
      was.set(el, tab)
      el.setAttribute('tabindex', '-1')
    }
  }
  skip()
  const watch = typeof MutationObserver === 'undefined' ? null : new MutationObserver(skip)
  watch?.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['tabindex'] })
  return () => {
    watch?.disconnect()
    for (const [el, tab] of was)
      if (tab === null) el.removeAttribute('tabindex')
      else el.setAttribute('tabindex', tab)
  }
}
