// The launch window's folder field (the old page's launch.js folder picker): a path field with
// completion (folders only; the server lists them and says whether a path exists), suggestions
// from the context, and a column view to browse, Finder style. The browser offers no picker that
// gives an absolute path, so this is ours. What it draws is a FolderView (FolderPicker.tsx).
import { splitPathInput } from '../../../../src/core/launch/names.ts'
import type { Translator } from '../../../../src/core/types.ts'
import type { LaunchApi } from '../../api/launch.ts'
import {
  chainOf,
  completionItems,
  type DirListing,
  type FolderColumn,
  folderColumn,
  type PopItem,
  rootItems,
} from '../../models/launch.ts'
import type { FolderCheck, GitInfo } from '../../models/launch-form.ts'
import { Store } from '../../state/store.ts'

export type FolderState = '' | 'ok' | 'bad' | 'wait'

/** The field as drawn. What is hidden keeps what it showed last, as the old page's elements did. */
export interface FolderView {
  text: string
  /** The mark beside the field; null before any folder was looked at. */
  state: FolderState | null
  /** The list under the field. */
  pop: { hidden: boolean; items: PopItem[]; lit: number }
  /** aria-expanded and aria-activedescendant of the field. */
  expanded: boolean
  activeId: string | null
  /** The columns. */
  browse: { open: boolean; columns: FolderColumn[] }
}

/** What the field needs of the window around it. */
export interface FolderHost {
  t(): Translator
  dirs: LaunchApi['dirs']
  /** The window is open for a context (the old `s`). */
  live(): boolean
  /** The context's suggestions, best first. */
  suggestions(): PopItem[]
  /** The folder changed (typed, picked, browsed to): the form follows it. */
  apply(path: string): void
  /** The server answered about the folder field. */
  checked(r: DirListing | null): void
  /** The note under the field. */
  note(text: string): void
  /** The Start button's state may have changed. */
  sync(): void
  submit(): void
  /** After the next draw (focus and scrolling need the drawn page). */
  later(fn: () => void): void
  /** The field, the columns, a row: in the drawn window. */
  find(selector: string): HTMLElement | null
}

/** A key press as the field reads it. */
export interface FieldKey {
  key: string
  isComposing: boolean
  keyCode: number
  preventDefault(): void
  stopPropagation(): void
}

const VIEW: FolderView = {
  text: '',
  state: null,
  pop: { hidden: true, items: [], lit: -1 },
  expanded: false,
  activeId: null,
  browse: { open: false, columns: [] },
}

/** How long the field waits after typing stops before it asks about the folder. */
export const CHECK_MS = 160
/** A blur closes the list this much later, unless the focus came back. */
export const BLUR_MS = 120

export function folderField(host: FolderHost) {
  const view = new Store<FolderView>(VIEW)
  const patch = (next: Partial<FolderView>) => view.set({ ...view.get(), ...next })
  const text = () => view.get().text

  // Asked again only within an opening; what was checked before is about another folder now.
  let cache = new Map<string, DirListing | null>()
  let check: FolderCheck | null = null
  let git: GitInfo | null = null
  let checkTimer: ReturnType<typeof setTimeout> | undefined

  async function dirs(path: string, withGit = false): Promise<DirListing | null> {
    const key = `${path}\n${withGit}`
    const known = cache.get(key)
    if (known) return known
    const res = await host.dirs(path, withGit)
    // Into the cache of the opening on now, as before (an answer to the last one included).
    if (res && host.live()) cache.set(key, res)
    return res
  }

  function setState(kind: FolderState, note = ''): void {
    patch({ state: kind })
    host.note(note)
    host.sync()
  }

  /** What the server says about the folder field, a moment after the typing stops. */
  function checkFolder(): void {
    clearTimeout(checkTimer)
    check = null
    git = null
    const path = text().trim()
    if (!path) {
      setState('')
      return
    }
    setState('wait')
    checkTimer = setTimeout(() => void runCheck(path), CHECK_MS)
  }

  async function runCheck(path: string): Promise<void> {
    clearTimeout(checkTimer)
    const r = await dirs(path, true)
    if (!host.live() || text().trim() !== path) return
    const t = host.t()
    check = { ...r, input: path }
    if (r?.slow) setState('bad', t('launch.err.cwdSlow', { path }))
    else if (!r?.exists) setState('bad', t('launch.err.cwdMissing', { path }))
    else if (!r.dir) setState('bad', t('launch.err.cwdFile', { path }))
    else setState('ok')
    git = r?.git ?? null
    host.checked(r)
  }

  // A long path shows its end, where the folder's own name is, unless it is being edited.
  function showEnd(): void {
    requestAnimationFrame(() => {
      const field = host.find('input[name="cwd"]')
      if (field && document.activeElement !== field) field.scrollLeft = field.scrollWidth
    })
  }

  // ---------------------------------------------------------------- the list under the field
  // Suggestions while it is untouched, folders that match once typing.
  let pop: { items: PopItem[]; active: number; open: boolean } = { items: [], active: -1, open: false }
  let popSeq = 0

  async function showPop(typed: boolean): Promise<void> {
    const seq = ++popSeq
    let items: PopItem[]
    if (!typed) items = host.suggestions()
    else {
      const { dir, prefix } = splitPathInput(text())
      const r = await dirs(dir)
      if (seq !== popSeq || !host.live()) return
      items = dir ? completionItems(r, dir, prefix) : rootItems(r, prefix, host.t())
    }
    if (seq !== popSeq || !host.live()) return
    pop = { items, active: -1, open: items.length > 0 }
    patch({ pop: { hidden: !pop.open, items, lit: -1 }, expanded: pop.open })
  }

  function closePop(): void {
    pop = { items: [], active: -1, open: false }
    patch({ pop: { ...view.get().pop, hidden: true }, expanded: false, activeId: null })
  }

  function lightPop(i: number): void {
    pop.active = i
    const id = `launch-opt-${i}`
    const shown = view.get().pop
    const el = i >= 0 && i < shown.items.length ? id : null
    patch({ pop: { ...shown, lit: i }, ...(el && { activeId: el }) })
    if (el) host.find(`#${el}`)?.scrollIntoView({ block: 'nearest' })
  }

  function takePop(i: number): void {
    const x = pop.items[i]
    if (!x) return
    if (x.complete) {
      // A completed folder name goes on with its separator, so its own folders come next.
      const sep = splitPathInput(text()).sep
      host.apply(x.path + sep)
      void showPop(true)
    } else {
      host.apply(x.path)
      closePop()
    }
    host.find('input[name="cwd"]')?.focus()
  }

  // ---------------------------------------------------------------- the columns
  // The drives (and home), then each folder down to the chosen one, then its subfolders. A
  // click picks a folder and opens it in the next column; arrows walk.
  let chain: string[] = []

  async function openBrowse(): Promise<void> {
    patch({ browse: { ...view.get().browse, open: true } })
    closePop()
    const typed = text().trim()
    const r = typed ? await dirs(typed) : null
    const at = r?.exists && r.dir ? r.path : ''
    await showChain(at ? ['', ...chainOf(at, r?.sep ?? '\\')] : [''])
  }

  function closeBrowse(): void {
    patch({ browse: { ...view.get().browse, open: false } })
  }

  async function showChain(next: string[]): Promise<void> {
    chain = next
    const lists = await Promise.all(next.map(p => dirs(p)))
    if (!host.live() || chain !== next) return
    const t = host.t()
    patch({ browse: { ...view.get().browse, columns: lists.map((r, i) => folderColumn(r, next[i + 1], t)) } })
    host.later(() => {
      const cols = host.find('.folder-cols')
      if (cols) cols.scrollLeft = cols.scrollWidth
    })
  }

  function pickRow(col: number, path: string): void {
    host.apply(path)
    void showChain([...chain.slice(0, col + 1), path]).then(() =>
      host.later(() => {
        for (const row of host.find('.folder-cols')?.querySelectorAll<HTMLElement>('.col-row') ?? [])
          if (row.dataset.path === path) return row.focus({ preventScroll: true })
      }),
    )
  }

  return {
    view,
    /** What the server said about the folder as typed, and its checkout. */
    check: () => check,
    git: () => git,
    /** A new opening: nothing asked or known yet. */
    reset(): void {
      cache = new Map()
      check = null
      git = null
    },
    setText(path: string): void {
      patch({ text: path })
      showEnd()
    },
    checkFolder,
    runCheck,
    clearState: () => setState(''),
    closePop,
    /** Esc: the list first, then the columns; false when neither was open. */
    escape(): boolean {
      if (pop.open) closePop()
      else if (view.get().browse.open) {
        closeBrowse()
        host.find('input[name="cwd"]')?.focus()
      } else return false
      return true
    },

    // The field's own events.
    input(value: string): void {
      patch({ text: value })
      host.apply(value)
      void showPop(true)
    },
    focus: () => void showPop(false),
    blur(): void {
      showEnd()
      setTimeout(() => {
        if (document.activeElement !== host.find('input[name="cwd"]')) closePop()
      }, BLUR_MS)
    },
    key(e: FieldKey): void {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter' && !(pop.open && pop.active >= 0)) {
        e.preventDefault()
        closePop()
        host.submit()
        return
      }
      if (!pop.open) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          void showPop(false)
        }
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = pop.items.length
        const step = e.key === 'ArrowDown' ? 1 : -1
        lightPop(pop.active < 0 ? (step > 0 ? 0 : n - 1) : (pop.active + step + n) % n)
      } else if ((e.key === 'Enter' || e.key === 'Tab') && pop.active >= 0) {
        e.preventDefault()
        e.stopPropagation()
        takePop(pop.active)
      } else if (e.key === 'Tab' && pop.items.length === 1) {
        e.preventDefault()
        takePop(0)
      }
    },
    takePop,
    /** The Browse button. */
    toggleBrowse: () => (view.get().browse.open ? closeBrowse() : void openBrowse()),

    // The columns' events.
    pickRow,
    closeBrowse,
    /** A key on row `row` of column `col`. */
    rowKey(e: Pick<FieldKey, 'key' | 'preventDefault'>, col: number, row: number): void {
      const columns = view.get().browse.columns
      const rows = columns[col]?.rows ?? []
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const to = rows[Math.max(0, Math.min(rows.length - 1, row + (e.key === 'ArrowDown' ? 1 : -1)))]
        if (to) pickRow(col, to.path)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const to = columns[col + 1]?.rows[0]
        if (to) pickRow(col + 1, to.path)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const to = columns[col - 1]?.rows.find(x => x.on)
        if (to) pickRow(col - 1, to.path)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        closeBrowse()
        host.find('input[name="cwd"]')?.focus()
      }
    },
  }
}

export type FolderField = ReturnType<typeof folderField>
