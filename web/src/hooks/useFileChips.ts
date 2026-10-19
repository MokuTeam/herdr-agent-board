// Paths the agents mention become chips once the server finds them on disk (the old page's
// files.js upgrade and apply): after a draw, the path candidates (data-path) are looked up — what
// the server said holds a while (models/files.ts statBook) — and marked with what they are; a chip
// gets its icon and name drawn into it (components/files/FileChip.tsx). Thumbnails and tool lines
// keep their look.
import { useState } from 'react'
import type { Translator } from '../../../src/core/types.ts'
import { filesApi } from '../api/files.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { type PathInfo, statBook } from '../models/files.ts'
import { Store } from '../state/store.ts'
import { useLatest } from './useLatest.ts'

/** What marking reads and writes of a candidate (an HTMLElement). */
export interface ChipElement {
  readonly dataset: DOMStringMap
  title: string
  tabIndex: number
  readonly innerHTML: string
  readonly isConnected: boolean
  matches(selector: string): boolean
  setAttribute(name: string, value: string): void
  readonly classList: { add(name: string): void; contains(name: string): boolean }
  replaceChildren(): void
}

/** A chip to draw: its element, the icon's kind and its label (a link's own markup when `html`). */
export interface ChipEntry {
  id: number
  el: HTMLElement
  kind: string | undefined
  label: string
  html: boolean
}

export type ChipContent = Omit<ChipEntry, 'id' | 'el'>

/**
 * Marks a candidate with what the server said: missing, or a file or folder with its full path,
 * kind and line, focusable as a button. Returns what to draw into it when it becomes a chip.
 */
export function markChip(el: ChipElement, info: PathInfo, t: Translator): ChipContent | null {
  if (!info.exists) {
    el.dataset.fs = 'missing'
    if (el.matches('a.fs')) el.title = t('ql.missing', { path: info.path || el.dataset.path || '' })
    return null
  }
  el.dataset.fs = info.dir ? 'dir' : 'file'
  el.dataset.abs = info.path
  el.dataset.kind = String(info.kind)
  if (info.line) el.dataset.line = String(info.line)
  el.title = info.line ? `${info.path}:${info.line}` : info.path
  el.tabIndex = 0
  el.setAttribute('role', 'button')
  // Thumbnails and tool lines keep their look; everything else becomes a chip.
  if (el.classList.contains('fs-inline')) return null
  const link = el.matches('a')
  const label = link ? el.innerHTML : info.name + (info.line ? `:${info.line}` : '')
  el.classList.add('fs-chip')
  return { kind: info.kind, label, html: link }
}

export interface ChipsDeps {
  stat(cwd: string, paths: string[]): Promise<PathInfo[]>
  t(): Translator
  now(): number
}

export interface FileChipsApi {
  /** Turn the path candidates under `root` into chips; `cwd` resolves relative ones. */
  upgrade(root: ParentNode, cwd?: string): Promise<void>
  /** The chips on the page. */
  readonly list: Store<readonly ChipEntry[]>
}

export function fileChips(deps: ChipsDeps): FileChipsApi {
  const known = statBook()
  const list = new Store<readonly ChipEntry[]>([])
  const chips = new Map<HTMLElement, ChipEntry>()
  let ids = 0

  let changed = false

  function apply(el: HTMLElement, info: PathInfo): void {
    const was = chips.get(el)
    // A chip already drawn keeps its label: its words are its own content now.
    const content = markChip(el, info, deps.t())
    if (!content) return
    if (!was) el.replaceChildren()
    chips.set(el, { id: was?.id ?? ++ids, el, ...content, label: was?.label ?? content.label })
    changed = true
  }

  const publish = () => {
    // Chips whose part of the page was drawn anew are gone with it.
    for (const el of chips.keys())
      if (!el.isConnected) {
        chips.delete(el)
        changed = true
      }
    if (changed) list.set([...chips.values()])
    changed = false
  }

  return {
    list,
    async upgrade(root, cwd = '') {
      const ask: HTMLElement[] = []
      for (const el of root.querySelectorAll<HTMLElement>('[data-path]:not([data-fs])')) {
        const info = known.get(cwd, el.dataset.path ?? '', deps.now())
        if (info) apply(el, info)
        else ask.push(el)
      }
      publish()
      const paths = [...new Set(ask.map(el => el.dataset.path ?? ''))]
      if (!paths.length) return
      for (const info of await deps.stat(cwd, paths)) known.put(cwd, info, deps.now())
      for (const el of ask) {
        const info = el.isConnected && known.get(cwd, el.dataset.path ?? '', deps.now())
        if (info) apply(el, info)
      }
      publish()
    },
  }
}

/** The page's chips, asked of the server in the page's language. */
export function useFileChips(): FileChipsApi {
  const t = useT()
  const latest = useLatest(t)
  const [chips] = useState(() => {
    const api = filesApi(() => latest.current)
    return fileChips({ stat: (cwd, paths) => api.stat(cwd, paths), t: () => latest.current, now: Date.now })
  })
  return chips
}
