// The "new session" window (the old page's launch.js): it grows out of what opened it and, once
// the session is started, folds into the new card in its lane; Esc or Cancel folds it back where
// it came from. The form keeps the values the user set apart from those that follow the folder;
// a closed form stays as a draft of the place it was opened for. What it draws is a
// LaunchWindowView (LaunchDialog.tsx); the folder field is folder-field.ts.
import {
  baseName,
  categoryForDir,
  folderSuggestions,
  slugName,
  suggestName,
} from '../../../../src/core/launch/names.ts'
import type { BoardCategory } from '../../../../src/core/payload.ts'
import type { Item, LaunchView, Translator } from '../../../../src/core/types.ts'
import { type LaunchApi, type LaunchOptions, NO_OPTIONS } from '../../api/launch.ts'
import type { MenuOrigin } from '../../models/board-menus.ts'
import {
  type Box,
  FROM_BELOW,
  type GrowFrom,
  growFrom,
  LAUNCH_MOTION,
  type LauncherInfo,
  suggestionItems,
  windowPaint,
} from '../../models/launch.ts'
import { launchContext, launchDraftBook } from '../../models/launch-drafts.ts'
import {
  draftOf,
  fieldOf,
  formProblems,
  formStart,
  goButton,
  type LaunchContext,
  type LaunchFields,
  type ProblemField,
  type SetByUser,
  startBody,
  startedLaunch,
  type WorkspaceOption,
  type WorkspaceWant,
  workspaceChoice,
  workspaceName,
  worktreeNote,
} from '../../models/launch-form.ts'
import type { FocusScope } from '../../models/modal-focus.ts'
import { reducedMotion, Spring } from '../../models/spring.ts'
import { Store } from '../../state/store.ts'
import { folderField } from './folder-field.ts'

/** A note under a field; hidden ones keep what they said last. */
export interface FieldNote {
  text: string
  error: boolean
  hidden: boolean
}

export type CategoryChip = Pick<BoardCategory, 'id' | 'title' | 'color'> & { pressed: boolean }

/** The window as drawn; the folder field's part is the FolderView. */
export interface LaunchWindowView {
  /** Not hidden: open, or folding away. */
  shown: boolean
  /** A failed launch started again (its title). */
  retry: boolean
  fields: Omit<LaunchFields, 'cwd'>
  workspaces: WorkspaceOption[]
  newWorkspaceHidden: boolean
  cats: CategoryChip[]
  /** The worktree row shows: the folder is in a git checkout. */
  worktree: boolean
  branchHidden: boolean
  notes: Record<ProblemField, FieldNote>
  /** What the server said when a start failed, not about a field. */
  error: { text: string; hidden: boolean }
  /** The Start button; null until it was first looked at. */
  go: { disabled: boolean; title: string } | null
  /** Bumped when work waits for the next draw. */
  seq: number
}

const HIDDEN: FieldNote = { text: '', error: false, hidden: true }

export const CLOSED_VIEW: LaunchWindowView = {
  shown: false,
  retry: false,
  fields: { name: '', workspace: '', newWorkspace: '', wt: false, branch: '', message: '' },
  workspaces: [],
  newWorkspaceHidden: true,
  cats: [],
  worktree: false,
  branchHidden: true,
  notes: { name: HIDDEN, cwd: HIDDEN, workspace: HIDDEN, worktree: HIDDEN },
  error: { text: '', hidden: true },
  go: null,
  seq: 0,
}

/** The board as the window reads it, with the lane on show. */
export interface LaunchBoard {
  categories: BoardCategory[]
  items: Item[]
  filter: string
}

export interface LaunchWindowDeps {
  t(): Translator
  /** New sessions go through herdr: they need fresh data. */
  canMutate(): boolean
  data(): LaunchBoard
  toast(text: string, error?: boolean): void
  api: Pick<LaunchApi, 'options' | 'dirs' | 'start' | 'dismiss'>
  /** The layer (a direct child of <body>) and the window in it, drawn. */
  layer(): HTMLElement | null
  win(): HTMLElement | null
  focus(): FocusScope
  /** localStorage, which may refuse. */
  store: { get(key: string): string | null; set(key: string, value: string): void }
  /** A session is on its way: the page shows its lane and draws its card. */
  onStarted(launch: LaunchView): void
  now(): number
  viewportHeight(): number
}

/** What was asked of one opening of the window (the old page's `s`). */
interface Opening {
  ctx: LaunchContext
  draftKey: string
  set: SetByUser
  retry: LaunchView | null
  category: string
  workspace: WorkspaceWant | null
  sending: boolean
}

/** The key the last workspace started in is kept under. */
export const LAST_WORKSPACE = 'board.launch.workspace'
/** The first field takes the focus this long after the window opens. */
export const FIRST_FOCUS_MS = 30

/** A key press as the window reads it (before the page's own). */
export interface WindowKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
  keyCode: number
  target: EventTarget | null
  preventDefault(): void
  stopImmediatePropagation(): void
}

const isBox = (o: unknown): o is Box =>
  typeof o === 'object' && o !== null && 'width' in o && 'left' in o && 'top' in o && 'bottom' in o

export function launchWindow(deps: LaunchWindowDeps) {
  const view = new Store<LaunchWindowView>(CLOSED_VIEW)
  /** Open and not folding away: the Back button and the page's keys ask. */
  const openNow = new Store(false)
  const launcher = new Store<LauncherInfo>(NO_OPTIONS.launcher)
  const patch = (next: Partial<LaunchWindowView>) => view.set({ ...view.get(), ...next })
  const setFields = (next: Partial<LaunchWindowView['fields']>) => patch({ fields: { ...view.get().fields, ...next } })
  const t = () => deps.t()
  const d = () => deps.data()
  const $ = (selector: string) => deps.layer()?.querySelector<HTMLElement>(selector) ?? null

  let s: Opening | null = null
  let options: LaunchOptions = NO_OPTIONS
  const drafts = launchDraftBook()
  const waiting: (() => void)[] = []
  const later = (fn: () => void) => {
    waiting.push(fn)
    patch({ seq: view.get().seq + 1 })
  }

  const folder = folderField({
    t,
    dirs: (path, git) => deps.api.dirs(path, git),
    live: () => !!s,
    suggestions: () => suggestionItems(suggestions(), t()),
    apply: path => applyFolder(path),
    checked: r => {
      renderWorktree()
      // The folder decides the category until the user picks one.
      if (!s || !r?.exists || !r.dir || s.set.category) return
      const cat = categoryForDir(d().categories, r.path)
      if (cat && cat !== s.category) {
        s.category = cat
        renderCats()
        renderWorkspaces()
      }
    },
    note: text => noteFor('cwd', text),
    sync: () => syncGo(),
    submit: () => void submit(),
    later,
    find: $,
  })
  const cwd = () => folder.view.get().text
  const fields = (): LaunchFields => ({ ...view.get().fields, cwd: cwd() })

  // ---------------------------------------------------------------- motion: out of the origin and back
  let from: GrowFrom = { ...FROM_BELOW }
  let origin: MenuOrigin | null = null
  // Drawn first, then it grows (afterDraw): the focus it takes, and what it grows from.
  let growing: { focus: unknown } | null = null

  function paint(p: number): void {
    const win = deps.win()
    const scrim = $('.launch-scrim')
    const look = windowPaint(p, from, reducedMotion.matches)
    if (win) {
      win.style.transform = look.transform
      win.style.opacity = look.opacity
    }
    if (scrim) scrim.style.opacity = look.scrim
  }
  const motion: Spring = new Spring({
    value: 0,
    damping: LAUNCH_MOTION.open.damping,
    response: LAUNCH_MOTION.open.response,
    precision: LAUNCH_MOTION.precision,
    onUpdate: v => paint(v),
    onRest: v => v === 0 && finishClose(),
  })

  function measure(rect: Box | null): GrowFrom {
    const win = deps.win()
    if (!win) return { ...FROM_BELOW }
    const saved = win.style.transform
    win.style.transform = 'none'
    const w = win.getBoundingClientRect()
    win.style.transform = saved
    return growFrom(rect, w, deps.viewportHeight())
  }
  const rectOf = (o: MenuOrigin | null): Box | null =>
    o instanceof Element ? (o.isConnected ? o.getBoundingClientRect() : null) : isBox(o) ? o : null

  /**
   * Opens the window for `ctx`, grown out of `fromEl` (an element, or a point's box). The
   * workspaces and recent folders come from the server; the window is usable before they do.
   */
  async function open(ctx: LaunchContext = {}, fromEl: MenuOrigin | null = null): Promise<void> {
    if (!deps.canMutate()) return deps.toast(t()('mobile.readOnly'), true)
    origin = fromEl
    const data = d()
    s = {
      ctx,
      draftKey: launchContext(ctx, data.filter),
      set: { category: false, cwd: false, name: false, branch: false, workspace: false },
      retry: ctx.retry ?? null,
      category: 'other',
      workspace: null,
      sending: false,
    }
    folder.reset()
    growing = { focus: fromEl instanceof Element ? fromEl : document.activeElement }
    patch({ shown: true, retry: !!s.retry })
    fill(ctx)
    motion.to(1, LAUNCH_MOTION.open)
    openNow.set(isOpen())
    setTimeout(() => {
      const first = $(ctx.newWorkspace ? 'input[name="newWorkspace"]' : 'input[name="name"]')
      first?.focus({ preventScroll: true })
      selectText(first)
    }, FIRST_FOCUS_MS)
    const opts = await deps.api.options()
    if (!opts || !s || s.ctx !== ctx) return
    options = opts
    launcher.set(opts.launcher)
    renderWorkspaces()
    if (!s.set.cwd && !cwd()) applyFolder(suggestions()[0]?.path ?? '', false)
  }

  /** Keeps the whole form for this opening context, never just a prompt for another project. */
  function close(to: MenuOrigin | null = null, started = false): void {
    if (!view.get().shown || motion.target === 0 || !s) return
    if (!started) drafts.write(s.draftKey, draftForm())
    folder.closePop()
    if (!growing) from = measure(rectOf(to) ?? rectOf(origin))
    growing = null
    motion.to(0, LAUNCH_MOTION.close)
    if (reducedMotion.matches) motion.set(0)
    openNow.set(isOpen())
  }

  function finishClose(): void {
    patch({ shown: false })
    s = null
    deps.focus().close()
    origin = null
    openNow.set(isOpen())
  }

  const isOpen = () => view.get().shown && motion.target === 1

  // ---------------------------------------------------------------- values
  const catTitle = (id: string) => d().categories.find(c => c.id === id)?.title ?? id
  const labelOf = (id: string) => view.get().workspaces.find(w => w.id === id)?.label ?? ''
  const draftForm = () => draftOf(fields(), s?.category ?? 'other', labelOf(view.get().fields.workspace))

  function fill(ctx: LaunchContext): void {
    if (!s) return
    const start = formStart(ctx, ctx.retry ? null : drafts.read(s.draftKey), { items: d().items, filter: d().filter })
    s.category = start.category
    s.set = start.set
    s.workspace = start.workspace
    folder.setText(start.cwd)
    setFields({ name: start.name, message: start.message, wt: start.wt, branch: start.branch })
    const notes = view.get().notes
    patch({
      notes: {
        name: { ...notes.name, hidden: true },
        cwd: { ...notes.cwd, hidden: true },
        workspace: { ...notes.workspace, hidden: true },
        worktree: { ...notes.worktree, hidden: true },
      },
      error: { ...view.get().error, hidden: true },
    })
    renderCats()
    renderWorkspaces()
    renderWorktree()
    if (start.cwd) folder.checkFolder()
    else folder.clearState()
  }

  function renderCats(): void {
    const category = s?.category
    patch({ cats: d().categories.map(c => ({ id: c.id, title: c.title, color: c.color, pressed: c.id === category })) })
  }

  /** Workspaces herdr has, the board's own left out; the last choice is a new one. */
  function renderWorkspaces(): void {
    if (!s) return
    const choice = workspaceChoice({
      workspaces: options.workspaces,
      board: options.board,
      want: s.workspace,
      wanted: s.set.workspace,
      category: s.category,
      title: catTitle(s.category),
      items: d().items,
      fallback: deps.store.get(LAST_WORKSPACE) ?? options.focused,
    })
    patch({ workspaces: choice.list, newWorkspaceHidden: !choice.create })
    setFields({ workspace: choice.value })
    if (choice.create && !view.get().fields.newWorkspace)
      setFields({ newWorkspace: choice.seed || defaultWorkspaceName() })
  }
  const defaultWorkspaceName = () => workspaceName(s?.category ?? '', catTitle(s?.category ?? ''), cwd(), t())

  function noteFor(field: string, text: string, error = true): void {
    if (field !== 'name' && field !== 'cwd' && field !== 'workspace' && field !== 'worktree') return
    patch({ notes: { ...view.get().notes, [field]: { text, hidden: !text, error: !!text && error } } })
  }

  function applyFolder(path: string, byUser = true): void {
    if (!s) return
    folder.setText(path)
    if (byUser) s.set.cwd = true
    if (!s.set.name) setFields({ name: path ? suggestName(path, d().items) : '' })
    if (!s.set.branch) setFields({ branch: '' })
    folder.checkFolder()
    syncGo()
  }

  function suggestions() {
    const here = s?.ctx.item?.cwd ?? s?.ctx.cwd
    return folderSuggestions({
      context: { ...(here !== undefined && { cwd: here }), category: s?.category ?? 'other' },
      categories: d().categories,
      items: d().items,
      recent: options.recent,
    })
  }

  /** The worktree choice shows for folders in a git checkout: a new branch in a sibling folder. */
  function renderWorktree(): void {
    if (!s) return
    const git = folder.git()
    patch({ worktree: !!git })
    if (!git) {
      noteFor('worktree', '')
      syncGo()
      return
    }
    const f = view.get().fields
    patch({ branchHidden: !f.wt })
    if (!s.set.branch) setFields({ branch: slugName(f.name || baseName(cwd())) })
    const note = worktreeNote(git, f.wt, view.get().fields.branch, t())
    noteFor('worktree', note.text, note.error)
    syncGo()
  }

  const problems = () => formProblems(fields(), folder.check(), folder.git(), t())

  function syncGo(): void {
    if (!s) return
    patch({
      go: goButton(
        {
          canMutate: deps.canMutate(),
          problems: problems(),
          checking: folder.view.get().state === 'wait',
          sending: s.sending,
        },
        t(),
      ),
    })
  }

  async function submit(): Promise<void> {
    if (!s || s.sending) return
    // Enter can come before the folder was checked: check it now, then go on with that answer.
    const typed = cwd().trim()
    if (typed && folder.check()?.input !== typed) {
      await folder.runCheck(typed)
      if (!s || cwd().trim() !== typed) return
    }
    const bad = problems()
    const first = Object.keys(bad)[0]
    if (first) {
      for (const [k, v] of Object.entries(bad)) noteFor(k, v)
      $(`[name="${fieldOf(first)}"]`)?.focus()
      return
    }
    if (!deps.canMutate()) return deps.toast(t()('mobile.readOnly'), true)
    const st = s
    const body = startBody(fields(), {
      check: folder.check(),
      git: folder.git(),
      category: st.category,
      label: labelOf(view.get().fields.workspace),
    })
    const draftVersion = drafts.write(st.draftKey, draftForm())
    st.sending = true
    syncGo()
    const r = await deps.api.start(body, t())
    st.sending = false
    // Closed (or opened anew) while the request was out: the start still counts, the old form does not.
    const here = s === st
    if (!r.ok) {
      if (!here) return deps.toast(r.error, true)
      syncGo()
      if (r.field) {
        noteFor(r.field, r.error)
        $(`[name="${fieldOf(r.field)}"]`)?.focus()
      } else patch({ error: { text: r.error, hidden: false } })
      return
    }
    if ('id' in body.workspace) deps.store.set(LAST_WORKSPACE, body.workspace.id)
    if (st.retry) void deps.api.dismiss(st.retry.id, t())
    drafts.clear(st.draftKey, draftVersion)
    deps.onStarted(startedLaunch(r.id, body, deps.now()))
    // The window folds into the new card, where the session will be.
    if (here)
      requestAnimationFrame(() => close(document.querySelector(`.card[data-key="launch:${CSS.escape(r.id)}"]`), true))
  }

  return {
    view,
    openNow,
    launcher,
    folder,
    open,
    close: () => close(),
    isOpen,
    /** A failed launch started again, grown out of `el`. */
    retry: (l: LaunchView, el: MenuOrigin | null) => open({ retry: l }, el),
    /** Fresh data came or went: the Start button. */
    sync: () => syncGo(),
    /** After every draw: an opening grows now, and work that waited for the draw is done. */
    afterDraw(): void {
      if (growing && view.get().shown) {
        const focus = growing.focus
        growing = null
        deps.focus().open(focus)
        from = measure(rectOf(origin))
        if (motion.value <= 0.001) paint(0)
      }
      for (const fn of waiting.splice(0)) fn()
    },
    /** The spring stops (the page goes). */
    stop: () => void motion.stop(),

    // The form's own events.
    pickCategory(id: string): void {
      if (!s) return
      s.category = id
      s.set.category = true
      renderCats()
      if (!s.set.workspace) renderWorkspaces()
    },
    name(value: string): void {
      if (!s) return
      setFields({ name: value })
      s.set.name = true
      noteFor('name', '')
      if (!s.set.branch) renderWorktree()
      syncGo()
    },
    workspace(value: string): void {
      if (!s) return
      s.set.workspace = true
      setFields({ workspace: value })
      const create = !value
      s.workspace = create ? { create: view.get().fields.newWorkspace } : { id: value }
      patch({ newWorkspaceHidden: !create })
      if (create) {
        if (!view.get().fields.newWorkspace) setFields({ newWorkspace: defaultWorkspaceName() })
        later(() => {
          const field = $('input[name="newWorkspace"]')
          field?.focus()
          selectText(field)
        })
      }
      noteFor('workspace', '')
    },
    newWorkspace(value: string): void {
      if (!s) return
      setFields({ newWorkspace: value })
      s.set.workspace = true
      s.workspace = { create: value }
    },
    worktree(on: boolean): void {
      setFields({ wt: on })
      renderWorktree()
      if (on) later(() => $('input[name="branch"]')?.focus())
    },
    branch(value: string): void {
      if (!s) return
      setFields({ branch: value })
      s.set.branch = true
      renderWorktree()
    },
    message: (value: string) => setFields({ message: value }),
    submit: () => void submit(),
    /** A click beside the window closes it only while nothing was written in it yet. */
    scrim(): void {
      if (view.get().fields.message.trim()) deps.win()?.focus({ preventScroll: true })
      else close()
    },

    /** Keys before the page's own: Esc closes the innermost thing first, Ctrl+Enter starts. */
    keydown(e: WindowKey): void {
      if (!view.get().shown || motion.target === 0 || !deps.focus().isTop()) return
      // Enter and Esc while an input method composes belong to it (they pick or drop a word).
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!folder.escape()) close()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        void submit()
      } else if (e.key === 'Enter' && submitsOnEnter(e.target)) {
        e.preventDefault()
        void submit()
      }
    },
  }
}

export type LaunchWindow = ReturnType<typeof launchWindow>

/** Enter in these fields starts (in the folder field it does too, unless a suggestion is lit). */
const submitsOnEnter = (target: EventTarget | null): boolean =>
  target instanceof Element && target.matches('input[name="name"], input[name="newWorkspace"], input[name="branch"]')

/** Selects a field's text (a field the window put the focus in). */
function selectText(el: HTMLElement | null): void {
  if (el && 'select' in el && typeof el.select === 'function') el.select()
}
