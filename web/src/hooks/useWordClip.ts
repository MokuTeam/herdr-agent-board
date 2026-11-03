// A card line cut at the end of a word (#321). A line clamp's ellipsis can fall inside a word; this
// finds how many words fit in the element's lines (its -webkit-line-clamp, as the stylesheet sets
// it for the look and the card text setting) on a hidden copy of it, and again whenever its size
// changes. Until it has measured (and where nothing can be measured) the text stays whole and the
// element's own clamp holds it.
import { type RefObject, useLayoutEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { clipWords } from '../models/card.ts'

/**
 * `text`, or as many of its words as fit in the lines of `ref`'s element, with "…". The text goes
 * into the element's child marked `data-clip`; whatever else the element holds (a label before it)
 * is measured with it.
 */
export function useWordClip(ref: RefObject<HTMLElement | null>, text: string): string {
  const [fit, setFit] = useState<{ text: string; words: number | null }>({ text, words: null })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let seen = ''
    const measure = () => {
      const width = el.getBoundingClientRect().width
      const style = getComputedStyle(el)
      const lines = Number.parseInt(style.webkitLineClamp, 10)
      // The type too: another look can change it at the same width and clamp.
      const key = [width, lines, style.fontSize, style.lineHeight, style.fontFamily].join(' ')
      if (!width || !(lines > 0) || seen === key) return
      seen = key
      setFit({ text, words: wordsThatFit(el, text, lines, width) })
    }
    measure()
    // Before the frame is painted, so a resize never shows the old cut at the new width.
    const watch = new ResizeObserver(() => flushSync(measure))
    watch.observe(el)
    return () => watch.disconnect()
  }, [ref, text])
  return fit.text === text && fit.words != null ? clipWords(text, fit.words) : text
}

/**
 * How many words of `text` fit in `lines` lines of `el` at `width`; null when all of it does.
 * `styleOf`: the page's getComputedStyle (a test's stand-in).
 */
export function wordsThatFit(
  el: HTMLElement,
  text: string,
  lines: number,
  width: number,
  styleOf: (el: Element) => { lineHeight: string } = getComputedStyle,
): number | null {
  const copy = el.cloneNode(true) as HTMLElement
  const parent = el.parentElement
  if (!parent) return null
  const slot = copy.querySelector('[data-clip]')
  if (!slot) return null
  copy.removeAttribute('id')
  copy.setAttribute('aria-hidden', 'true')
  Object.assign(copy.style, {
    position: 'absolute',
    insetInlineStart: '0',
    top: '0',
    width: `${width}px`,
    boxSizing: 'border-box',
    visibility: 'hidden',
    pointerEvents: 'none',
    display: 'block',
    maxHeight: 'none',
    webkitLineClamp: 'none',
  })
  parent.appendChild(copy)
  try {
    const line = Number.parseFloat(styleOf(copy).lineHeight)
    if (!line) return null
    const room = line * lines + 1
    const fits = (s: string) => {
      slot.textContent = s
      return copy.scrollHeight <= room
    }
    if (fits(text)) return null
    // The most words that fit, "…" included: none at worst.
    let lo = 0
    let hi = text.trim().split(/\s+/).length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (fits(clipWords(text, mid))) lo = mid
      else hi = mid - 1
    }
    return lo
  } finally {
    copy.remove()
  }
}
