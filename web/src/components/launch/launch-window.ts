// The "new session" window (the old page's launch.js): it grows out of what opened it and, once
// the session is started, folds into the new card in its lane; Esc or Cancel folds it back where
// it came from. The form keeps the values the user set apart from those that follow the folder;
// a closed form stays as a draft of the place it was opened for. What it draws is a
// LaunchWindowView (LaunchDialog.tsx); the folder field is folder-field.ts, the Claude profile it
// starts in models/launch-profile.ts, the agent it starts as (Claude Code or pi) models/launch-agent.ts.
import {
  baseName,
  categoryForDir,
  folderSuggestions,
  slugName,
  suggestName,
} from '../../../../src/core/launch/names.ts'
import type { BoardCategory, BoardProfile } from '../../../../src/core/payload.ts'
import type { Item, LaunchView, Translator } from '../../../../src/core/types.ts'
import { type LaunchApi, type LaunchOptions, NO_OPTIONS } from '../../api/launch.ts'
import type { MenuOrigin } from '../../models/board-menus.ts'
import { FROM_BELOW, type GrowFrom, paintWindow } from '../../models/grow.ts'
import type { LanePicks } from '../../models/lane-picks.ts'
import { type Box, growFrom, LAUNCH_MOTION, type LauncherInfo, suggestionItems } from '../../models/launch.ts'
import {
  type AgentRow,
  agentBody,
  agentRow,
  agentStart,
  launcherFor,
  NO_AGENT_ROW,
  offersAgents,
} from '../../models/launch-agent.ts'
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
import {
  LAUNCH_PROFILES,
  type ProfilePick,
  type ProfileRow,
  profileBody,
  profileRow,
  profileStart,
  rememberedProfiles,
  rememberProfile,
} from '../../models/launch-profile.ts'
import type { FocusScope } from '../../models/modal-focus.ts'
import { reducedMotion, Spring } from '../../models/spring.ts'
import { Store } from '../../state/store.ts'
import { type FieldNote, folderField, NO_NOTE } from './folder-field.ts'

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
  /** The profile choice (only when offered) and the profile beside Start. */
  profile: ProfileRow
  /** The agent choice, only when the board offers more than one. */
  agent: AgentRow
  /** The worktree row shows: the folder is in a git checkout. */
  worktree: boolean
  branchHidden: boolean
  notes: Record<ProblemField, FieldNote>
  /** Under Category: several lanes on show, and the form starts in the first picked ('' for none). */
  lanesNote: string
  /** What the server said when a start failed, not about a field. */
  error: { text: string; hidden: boolean }
  /** The Start button; null until it was first looked at. */
  go: { disabled: boolean; title: string } | null
  /** Bumped when work waits for the next draw. */
  seq: number
}

export const CLOSED_VIEW: LaunchWindowView = {
  shown: false,
  retry: false,
  fields: { name: '', workspace: '', newWorkspace: '', wt: false, branch: '', message: '' },
  workspaces: [],
  newWorkspaceHidden: true,
  cats: [],
  profile: { offered: false, options: [], chosen: null },
  agent: NO_AGENT_ROW,
  worktree: false,
  branchHidden: true,
  notes: { name: NO_NOTE, cwd: NO_NOTE, profile: NO_NOTE, workspace: NO_NOTE, worktree: NO_NOTE },
  lanesNote: '',
  error: { text: '', hidden: true },
  go: null,
  seq: 0,
}

/** The board as the window reads it, with the lanes on show. */
export interface LaunchBoard {
  categories: BoardCategory[]
  items: Item[]
  /** The lanes picked (models/lane-picks.ts). */
  filter: LanePicks
  /** The Claude profiles (none from a board before them). */
  profiles: BoardProfile[]
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
  /** The profile it starts in; `profileSet`: the user picked one, or the server asked for one. */
  profile: ProfilePick
  profileSet: boolean
  /** The agent it starts as (null: no choice offered); `agentAgain`: a failed launch's or a draft's; `agentSet`: the user picked one. */
  agent: string | null
  agentAgain: string | null
  agentSet: boolean
  /** The error under the form is the server's refusal of the agent. */
  agentRefused: boolean
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
    id: 'launch',
    t,
    dirs: (path, git) => deps.api.dirs(path, git),
    live: () => !!s,
    suggestions: () => suggestionItems(suggestions(), t()),
    apply: path => applyFolder(path),
    checked: r => {
      renderWorktree()
      // The folder decides the category until the user picks one.
      if (s && r?.exists && r.dir && !s.set.category) {
        const cat = categoryForDir(d().categories, r.path)
        if (cat && cat !== s.category) {
          s.category = cat
          renderCats()
          renderWorkspaces()
        }
      }
      followProfile()
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

  const paint = (p: number) => paintWindow(deps.win(), $('.launch-scrim'), p, from)
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
      set: { category: false, cwd: false, name: false, branch: false, workspace: false, newWorkspace: false },
      retry: ctx.retry ?? null,
      category: 'other',
      workspace: null,
      sending: false,
      profile: { picked: null, locked: false, offered: false },
      profileSet: false,
      agent: null,
      agentAgain: null,
      agentSet: false,
      agentRefused: false,
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
    followAgent()
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
  const draftForm = () =>
    draftOf(
      fields(),
      s?.category ?? 'other',
      labelOf(view.get().fields.workspace),
      s?.agentSet && s.agent !== null ? s.agent : undefined,
    )

  function fill(ctx: LaunchContext): void {
    if (!s) return
    const draft = ctx.retry ? null : drafts.read(s.draftKey)
    const start = formStart(ctx, draft, { items: d().items, filter: d().filter })
    s.category = start.category
    s.set = start.set
    const lanes = start.lanes.map(catTitle).join(', ')
    patch({ lanesNote: lanes ? t()('launch.lanesNote', { lanes, lane: catTitle(start.category) }) : '' })
    s.workspace = start.workspace
    folder.setText(start.cwd)
    setFields({ name: start.name, message: start.message, wt: start.wt, branch: start.branch })
    s.profile = startingProfile(s)
    patch({ profile: profileRow(s.profile, d().profiles) })
    // A failed launch's agent, or one picked in the draft, counts as picked; the rest follows the board's default.
    s.agentAgain = ctx.retry?.agent ?? draft?.agent ?? null
    s.agentSet = !!draft?.agent
    followAgent()
    const notes = view.get().notes
    patch({
      notes: {
        name: { ...notes.name, hidden: true },
        cwd: { ...notes.cwd, hidden: true },
        profile: { ...notes.profile, hidden: true },
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
    followWorkspaceName()
  }
  const defaultWorkspaceName = () =>
    workspaceName(view.get().fields.name, s?.category ?? '', catTitle(s?.category ?? ''), cwd(), t())

  /** A new workspace's name, while its field shows, follows the session's name until one is typed there. */
  function followWorkspaceName(): void {
    if (s && !s.set.newWorkspace && !view.get().newWorkspaceHidden) setFields({ newWorkspace: defaultWorkspaceName() })
  }

  // ---------------------------------------------------------------- the profile
  /** The folder a profile is remembered for: as the server resolved it once checked, else as typed. */
  function profileCwd(): string {
    const c = folder.check()
    return c?.exists && c.dir && c.path && c.input === cwd().trim() ? c.path : cwd()
  }

  const startingProfile = (o: Opening): ProfilePick =>
    profileStart(o.ctx, {
      profiles: d().profiles,
      categories: d().categories,
      category: o.category,
      cwd: profileCwd(),
      remembered: rememberedProfiles(deps.store.get(LAUNCH_PROFILES)),
    })

  function renderProfile(): void {
    if (!s) return
    patch({ profile: profileRow(s.profile, d().profiles) })
    syncGo()
  }

  /** Until the user picks one (or the server asks for one), the profile follows the lane and the folder. */
  function followProfile(): void {
    if (!s || s.profileSet) return
    const next = startingProfile(s)
    const now = s.profile
    if (next.picked === now.picked && next.locked === now.locked && next.offered === now.offered) return
    s.profile = next
    renderProfile()
  }

  /** The server would not start it in the profile sent, or without one: the user picks, from nothing. */
  function askProfile(): void {
    if (!s) return
    s.profile = { picked: null, locked: false, offered: true }
    s.profileSet = true
    renderProfile()
  }

  // ---------------------------------------------------------------- the agent
  /** Until the user picks one, the agent is the one asked for again, else the board's default. */
  function followAgent(): void {
    if (!s) return
    if (!s.agentSet || s.agent === null || !options.agents.some(a => a.id === s?.agent))
      s.agent = agentStart(s.agentAgain, options.agents, options.agent)
    renderAgent()
  }

  function renderAgent(): void {
    if (!s) return
    patch({ agent: agentRow(s.agent, options.agents) })
    launcher.set(launcherFor(options.launcher, s.agent))
  }

  /** The card a start comes from, whose profile the server holds it to. */
  const parentOf = (ctx: LaunchContext): string | null => ctx.item?.key ?? ctx.retry?.parent ?? null

  function noteFor(field: string, text: string, error = true): void {
    if (field !== 'name' && field !== 'cwd' && field !== 'profile' && field !== 'workspace' && field !== 'worktree')
      return
    patch({ notes: { ...view.get().notes, [field]: { text, hidden: !text, error: !!text && error } } })
  }

  function applyFolder(path: string, byUser = true): void {
    if (!s) return
    folder.setText(path)
    if (byUser) s.set.cwd = true
    if (!s.set.name) setFields({ name: path ? suggestName(path, d().items) : '' })
    followWorkspaceName()
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

  const problems = () => formProblems(fields(), folder.check(), folder.git(), t(), s?.profile)

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
    // The profile drawn as the user pressed Start: the only one a start may send.
    const seen = s.profile
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
    // The check brought the folder's or the lane's profile while the choice is offered: nothing
    // goes in a profile the user did not see; it is drawn, and Start is pressed again.
    if (s.profile !== seen && (seen.offered || s.profile.offered)) return renderProfile()
    if (!deps.canMutate()) return deps.toast(t()('mobile.readOnly'), true)
    const st = s
    const body = startBody(fields(), {
      check: folder.check(),
      git: folder.git(),
      category: st.category,
      label: labelOf(view.get().fields.workspace),
      ...profileBody(st.profile, d().profiles, parentOf(st.ctx)),
      ...agentBody(st.agent, options.agents),
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
      const field = r.field
      if (field === 'profile') {
        // Asked for a profile: the choice shows (with one shown too), then takes the focus.
        askProfile()
        noteFor(field, r.error)
        later(() => $('[name="profile"]')?.focus())
      } else if (field === 'agent') {
        // Not an agent the board starts (any more), or pi's command is wrong: said under the form,
        // the agent picked takes the focus, and another pick clears it.
        st.agentRefused = true
        patch({ error: { text: r.error, hidden: false } })
        $('[name="agent"][aria-pressed="true"]')?.focus()
      } else if (field) {
        noteFor(field, r.error)
        $(`[name="${fieldOf(field)}"]`)?.focus()
      } else patch({ error: { text: r.error, hidden: false } })
      return
    }
    if ('id' in body.workspace) deps.store.set(LAST_WORKSPACE, body.workspace.id)
    if (body.profile) {
      const book = rememberProfile(rememberedProfiles(deps.store.get(LAUNCH_PROFILES)), body.cwd, body.profile)
      deps.store.set(LAUNCH_PROFILES, JSON.stringify(book))
    }
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
      if (view.get().lanesNote) patch({ lanesNote: '' })
      renderCats()
      if (!s.set.workspace) renderWorkspaces()
      else followWorkspaceName()
      followProfile()
    },
    /** An agent picked (the choice is offered): it stops following the board's default. */
    pickAgent(id: string): void {
      if (!s || !offersAgents(options.agents) || !options.agents.some(a => a.id === id)) return
      s.agent = id
      s.agentSet = true
      if (s.agentRefused) patch({ error: { ...view.get().error, hidden: true } })
      s.agentRefused = false
      renderAgent()
    },
    /** A profile picked (the choice is offered): it stops following the lane and the folder. */
    pickProfile(id: string): void {
      if (!s || s.profile.locked) return
      s.profile = { picked: id, locked: false, offered: true }
      s.profileSet = true
      noteFor('profile', '')
      renderProfile()
    },
    name(value: string): void {
      if (!s) return
      setFields({ name: value })
      s.set.name = true
      followWorkspaceName()
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
        followWorkspaceName()
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
      s.set.newWorkspace = true
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
