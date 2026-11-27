import type { ReactNode } from 'react'
import { safeLink } from '../models/web-link.ts'

// Match a URL at a word boundary in prose. Quotes and markup delimiters end the URL.
const WEB_URL = /(?:^|[\s([{<«“‘"'`])(https?:\/\/[^\s<>"'`«»“”‘’]+)/gi
const TRAILING_PUNCTUATION = /[.,;:!?…]+$/

function trimUrl(token: string): string {
  let url = token.replace(TRAILING_PUNCTUATION, '')
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    let balance = url.split(open).length - url.split(close).length
    while (balance < 0 && url.endsWith(close)) {
      url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, '')
      balance++
    }
  }
  return url
}

/** Render a question as text and native links without interpreting Markdown or HTML. */
export function plainWebLinks(text: string): ReactNode[] | null {
  const parts: ReactNode[] = []
  let end = 0
  for (const match of text.matchAll(WEB_URL)) {
    const token = match[1]
    if (!token) continue
    const url = trimUrl(token)
    const href = safeLink(url)
    if (!href) continue
    const start = match.index + match[0].length - token.length
    parts.push(
      text.slice(end, start),
      <a key={start} className="ask-link" href={href} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    )
    end = start + url.length
  }
  return end ? [...parts, text.slice(end)] : null
}
