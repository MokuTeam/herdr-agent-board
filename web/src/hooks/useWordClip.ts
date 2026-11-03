// A card line cut at the end of a word (#321). A line clamp's ellipsis can fall inside a word; this
// finds how many words fit in the element's lines (its -webkit-line-clamp, as the stylesheet sets
// it for the look and the card text setting) on a hidden copy of it, and again whenever its size
// changes. Until it has measured (and where nothing can be measured) the text stays whole and the
// element's own clamp holds it.
import { type RefObject, useLayoutEffect, useState } from 'react'
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
      const lines = Number.parseInt(getComputedStyle(el).webkitLineClamp, 10)
      if (!width || !(lines > 0) || seen === `${width} ${lines}`) return
      seen = `${width} ${lines}`
      setFit({ text, words: wordsThatFit(el, text, lines, width) })
    }
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [ref, text])
  return fit.text === text && fit.words != null ? clipWords(text, fit.words) : text
}

/** How many words of `text` fit in `lines` lines of `el` at `width`; null when all of it does. */
function wordsThatFit(el: HTMLElement, text: string, lines: number, width: number): number | null {
  const copy = el.cloneNode(true)
  const parent = el.parentElement
  if (!(copy instanceof HTMLElement) || !parent) return null
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
    const line = Number.parseFloat(getComputedStyle(copy).lineHeight)
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
