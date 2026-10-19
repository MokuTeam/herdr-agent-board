// Renaming a session where its name is — on its card or in the sheet's head (the old page's
// rename.js and app.js startRename): a field laid exactly over the name, in its own font, the text
// selected, as Finder does. Enter or a click elsewhere keeps it, Esc puts it back; an empty name
// gives the automatic one back. Under it, for a Claude session, the choice to rename it in Claude
// and herdr too: that types /rename into the session, so it is never done without asking, and
// only while the session is idle. The board keeps the name on the card either way.
//
// components/RenameField.tsx draws the field from `view`; `field` gives it its keys, focus and motion.
import { useState } from 'react'
import type { Item, Translator } from '../../../src/core/types.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { claudeRename, type RenameBox, renameBox, renameChanges } from '../models/rename.ts'
import { reducedMotion, Spring } from '../models/spring.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { Store } from '../state/store.ts'
import { useLatest } from './useLatest.ts'
import { type ActResult, useSessionActions } from './useSessionActions.ts'

/** The field as drawn, measured from the name when it opened. */
export interface RenameView {
  /** A new one for every rename: the field is drawn afresh. */
  id: number
  value: string
  /** What an empty name gives back. */
  auto: string
  /** null: no Claude session; else why it cannot be renamed there now ('' when it can). */
  claude: { why: string } | null
  box: RenameBox
  /** The name's type: the field shows the name in it, so nothing jumps. */
  font: { font: string; letterSpacing: string; color: string }
}

/** The drawn field's parts. */
export interface RenameElements {
  box: HTMLElement
  field: HTMLInputElement
  more: HTMLElement
  check: HTMLInputElement | null
}

export interface RenameCallbacks {
  /** The name as it was: the same again (without Claude) is no rename. */
  value: string
  /** Saves it; `{ ok: false }` keeps the field open to try again. */
  onCommit(name: string, opts: { claude: boolean }): Promise<{ ok?: boolean } | undefined>
  /** Kept, put back or cancelled: the field goes. */
  onClose(): void
}

export interface RenameControls {
  /** Put back without saving (another rename starts). */
  cancel(): void
  /** The field goes from the page: its listeners and motion stop. */
  detach(): void
}

/** The field's behaviour on its drawn parts: focus and selection, keys, leaving it, its options' motion. */
export function renameField(els: RenameElements, { value, onCommit, onClose }: RenameCallbacks): RenameControls {
  const { box, field, more, check } = els
  const s = new Spring({
    value: 0,
    damping: 1,
    response: 0.22,
    precision: 0.003,
    onUpdate: v => {
      more.style.opacity = String(v)
      more.style.transform = reducedMotion.matches ? '' : `translateY(${(1 - v) * -4}px)`
    },
  })
  s.to(1)
  field.focus()
  field.select()

  let done = false
  let held = false // a press on the checkbox's label is under way
  let saving = false // a field that goes disabled loses the focus: that is no second commit
  const finish = () => {
    if (done) return
    done = true
    onClose()
  }
  const commit = async () => {
    if (done || saving) return
    const name = field.value.trim()
    const claudeToo = !!check?.checked
    if (!renameChanges(name, value, claudeToo)) return finish()
    saving = true
    field.disabled = true
    const r = await onCommit(name, { claude: claudeToo })
    saving = false
    if (r?.ok === false) {
      field.disabled = false
      field.focus()
      return
    }
    finish()
  }
  const inBox = (node: unknown): boolean => node instanceof Node && box.contains(node)
  const onFieldKey = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.isComposing || e.keyCode === 229) return // an input method's own Enter and Esc
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish()
    }
  }
  // Leaving the field keeps the name, unless the focus only went to the checkbox under it.
  const onFocusOut = (e: FocusEvent) => {
    if (!inBox(e.relatedTarget)) setTimeout(() => !held && !inBox(document.activeElement) && void commit(), 0)
  }
  const onCheckKey = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') void commit()
    if (e.key === 'Escape') finish()
  }
  const onPointerDown = (e: PointerEvent) => e.stopPropagation()
  // A press on the options must not count as leaving the field. A press on the checkbox's label
  // is let through (preventing it stops the label from ticking the box) and holds the commit
  // until its click has landed; any other press keeps the focus in the field.
  const onMouseDown = (e: MouseEvent) => {
    if (e.target === field) return
    if (!(e.target instanceof Element && e.target.closest('label'))) return e.preventDefault()
    held = true
    addEventListener('pointerup', () => setTimeout(() => (held = false), 0), { once: true })
  }
  const onClick = (e: MouseEvent) => {
    if (e.target instanceof Element && e.target.closest('label')) setTimeout(() => !done && field.focus(), 0)
  }
  field.addEventListener('keydown', onFieldKey)
  box.addEventListener('focusout', onFocusOut)
  check?.addEventListener('keydown', onCheckKey)
  box.addEventListener('pointerdown', onPointerDown)
  box.addEventListener('mousedown', onMouseDown)
  box.addEventListener('click', onClick)
  return {
    cancel: finish,
    detach() {
      s.stop()
      field.removeEventListener('keydown', onFieldKey)
      box.removeEventListener('focusout', onFocusOut)
      check?.removeEventListener('keydown', onCheckKey)
      box.removeEventListener('pointerdown', onPointerDown)
      box.removeEventListener('mousedown', onMouseDown)
      box.removeEventListener('click', onClick)
    },
  }
}

/** What renaming needs of the page. */
export interface RenameDeps {
  item(key: string): Item | undefined
  canEdit(): boolean
  canMutate(): boolean
  t(): Translator
  toast(text: string, error?: boolean): void
  act(key: string, action: string, body: Record<string, unknown>): Promise<ActResult>
  /** The window's width without its scrollbar. */
  viewportWidth?: () => number
}

export interface Renamer {
  /** The field now; null when none is open. */
  view: Store<RenameView | null>
  /** Rename `key` where its name is: `el`, the card's name or the sheet's head. */
  start(key: string, el: Element | null): void
  /** The drawn field takes its behaviour (RenameField's layout effect). */
  attach(els: RenameElements): () => void
}

/** Renaming for the page: one field at a time. */
export function renamer(deps: RenameDeps): Renamer {
  const view = new Store<RenameView | null>(null)
  let seq = 0
  /** The open field: the name it is over, what it renames, its controls once drawn. */
  let current: { target: Element; key: string; item: Item; controls: RenameControls | null } | null = null

  function close(): void {
    const open = current
    current = null
    open?.target.classList.remove('renaming')
    view.set(null)
  }

  async function save(key: string, it: Item, name: string, claude: boolean): Promise<ActResult> {
    const r = await deps.act(key, 'rename', { name, claude })
    const t = deps.t()
    if (!r.ok) deps.toast(r.error, true)
    // Claude says "Session renamed" when it took the name; without that, the toast says so.
    else
      deps.toast(
        name
          ? t(claude ? (r.confirmed ? 'rename.doneClaude' : 'rename.unconfirmed') : 'rename.done', { name })
          : t('rename.cleared', { name: it.autoName || it.name }),
      )
    return r
  }

  return {
    view,
    start(key, el) {
      const it = deps.item(key)
      if (!it || !el) return
      const t = deps.t()
      if (!deps.canEdit()) return deps.toast(t('live.off'), true)
      current?.controls?.cancel()
      if (current) close()
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      view.set({
        id: ++seq,
        value: it.name,
        auto: it.autoName || it.name,
        claude: claudeRename(it, deps.canMutate(), t),
        box: renameBox(r, deps.viewportWidth?.() ?? innerWidth),
        font: { font: cs.font, letterSpacing: cs.letterSpacing, color: cs.color },
      })
      el.classList.add('renaming')
      current = { target: el, key, item: it, controls: null }
    },
    attach(els) {
      const open = current
      const shown = view.get()
      if (!open || !shown) return () => {}
      const controls = renameField(els, {
        value: shown.value,
        onCommit: (name, { claude }) => save(open.key, open.item, name, claude),
        onClose: () => {
          if (current === open) close()
        },
      })
      open.controls = controls
      return () => {
        controls.detach()
        if (open.controls === controls) open.controls = null
      }
    },
  }
}

/** The page's renaming: start it from a card's name, the sheet's head, F2 or a menu. */
export function useRenameInPlace(): Renamer {
  const t = useT()
  const board = useBoardContext()
  const actions = useSessionActions()
  const latest = useLatest({ t, board, actions })
  const [rename] = useState(() =>
    renamer({
      item: key => latest.current.board.data?.items.find(i => i.key === key),
      canEdit: () => latest.current.board.canEdit,
      canMutate: () => latest.current.board.canMutate,
      t: () => latest.current.t,
      toast: (text, error) => latest.current.board.toast(text, error),
      act: (key, action, body) => latest.current.actions.act(key, action, body),
    }),
  )
  return rename
}
