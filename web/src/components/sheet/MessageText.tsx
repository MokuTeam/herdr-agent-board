// A message's text in its bubble (Thread.tsx, and ThreadLinks.tsx PeerBubble): Markdown, whole.
// One taller than two screens (models/thread.ts folds) folds there, with "Show all" under it that
// turns into "Show less" once open. What is folded away is drawn all the same, for a selection to
// copy and for its file chips, but out of the Tab order: the keyboard reaches "Show all" first. A
// message the thread's budget cut says so under it (core/transcript.ts fitThread).
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import { markdown } from '../../models/markdown.ts'
import { FOLD_SCREENS, folds } from '../../models/thread.ts'

export interface MessageTextProps {
  text: string
  /** The thread's budget cut it. */
  cut?: boolean | undefined
  /** It opened or folded again: the thread changed height where the reader is. */
  onResize?: (() => void) | undefined
}

export function MessageText({ text, cut = false, onResize }: MessageTextProps) {
  const t = useT()
  const id = useId()
  const body = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const screen = useScreenHeight()
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
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
  return (
    <>
      <div
        ref={body}
        id={long ? id : undefined}
        className={folded ? 'md folded' : 'md'}
        style={folded ? { maxHeight: FOLD_SCREENS * screen } : undefined}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown() escapes every piece of text itself and makes only known tags
        dangerouslySetInnerHTML={{ __html: markdown(text) }}
      />
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
