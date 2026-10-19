// The "new session" form without a page (the pure parts of web/launch.js): what it starts with in
// each context, the workspace it offers, the worktree line, what it lacks, and what it sends.
import {
  baseName,
  checkBranch,
  checkName,
  defaultWorkspace,
  NAME_MAX,
  suggestName,
  worktreePath,
} from '../../../src/core/launch/names.ts'
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import type { DirListing } from './launch.ts'
import type { LaunchDraft } from './launch-drafts.ts'
import type { ProfilePick } from './launch-profile.ts'

/**
 * Where a new session starts: in a lane, by a session (its lane and folder), in a new workspace,
 * in a folder; or a failed launch started again (`retry`).
 */
export interface LaunchContext {
  category?: string
  item?: Item
  newWorkspace?: boolean
  cwd?: string
  retry?: LaunchView
}

/** The form's fields. `workspace`: the id of the one picked, '' for a new one (named `newWorkspace`). */
export interface LaunchFields {
  name: string
  cwd: string
  workspace: string
  newWorkspace: string
  wt: boolean
  branch: string
  message: string
}

/** The workspace the form wants: by id, by label, or a new one by that name. */
export type WorkspaceWant = { id: string } | { label: string } | { create: string }

/** Values the user set: those stop following the folder. */
export interface SetByUser {
  category: boolean
  cwd: boolean
  name: boolean
  branch: boolean
  workspace: boolean
}

/** What the form starts with: the values, which of them count as set, and the workspace it wants. */
export interface FormStart {
  category: string
  cwd: string
  name: string
  message: string
  wt: boolean
  branch: string
  workspace: WorkspaceWant | null
  set: SetByUser
}

/** What a form was started again from: a draft of the same place, or a failed launch. */
type Restored = Partial<LaunchDraft> & { workspaceId?: string | null }

/** The form for `ctx`: a failed launch's or a draft's values first, else the card's, the context's, the lane on show. */
export function formStart(
  ctx: LaunchContext,
  draft: Restored | null,
  board: { items: readonly Item[]; filter: string },
): FormStart {
  const r: Restored | null = ctx.retry ?? draft
  const card = ctx.item
  const picked =
    r?.category ?? card?.category ?? ctx.category ?? (board.filter && board.filter !== 'all' ? board.filter : null)
  const cwd = r?.cwd ?? card?.cwd ?? ctx.cwd ?? ''
  const workspace: WorkspaceWant | null = r
    ? r.workspaceId
      ? { id: r.workspaceId }
      : r.newWorkspace
        ? { create: r.workspace ?? '' }
        : { label: r.workspace ?? '' }
    : ctx.newWorkspace
      ? { create: '' }
      : card?.workspace
        ? { label: card.workspace }
        : null
  return {
    category: picked || 'other',
    cwd,
    name: r?.name ?? (cwd ? suggestName(cwd, [...board.items]) : ''),
    message: r?.message ?? '',
    wt: !!r?.worktree,
    branch: r?.worktree?.branch ?? '',
    workspace,
    set: { category: !!picked, cwd: !!cwd, name: !!r, branch: !!r?.worktree, workspace: !!workspace },
  }
}

/** A workspace of herdr's (its label may be missing). */
export interface WorkspaceOption {
  id: string
  label: string | undefined
}

export interface WorkspaceChoice {
  /** herdr's workspaces, the board's own left out. */
  list: WorkspaceOption[]
  /**
   * The select's value: the id picked, '' for a new one. An id herdr no longer has picks none,
   * and a select shows its first choice then.
   */
  value: string
  /** The field for a new one's name shows (an id was not picked). */
  create: boolean
  /** The name a new one starts with ('' leaves it to the default name). */
  seed: string
}

export interface WorkspaceScene {
  workspaces: WorkspaceOption[]
  /** The board's own workspace, never offered. */
  board: string
  want: WorkspaceWant | null
  /** The user picked (or the context asked for) one: no default replaces it. */
  wanted: boolean
  category: string
  /** The lane's title. */
  title: string
  items: readonly Item[]
  /** The last one used, else the one herdr has the focus in. */
  fallback: string
}

/** The workspaces herdr has, and which one the form picks; the last choice is a new one. */
export function workspaceChoice(s: WorkspaceScene): WorkspaceChoice {
  const list = s.workspaces.filter(w => w.label !== s.board)
  let want = s.want
  if (!s.wanted) {
    const id = defaultWorkspace({
      category: s.category,
      title: s.title,
      items: [...s.items],
      workspaces: list.map(w => ({ id: w.id, label: w.label ?? '' })),
      board: s.board,
      fallback: s.fallback,
    })
    want = id ? { id } : { create: '' }
  }
  const id = want && 'id' in want ? want.id : null
  const label = want && 'label' in want ? want.label : ''
  const selected = id ?? (label ? (list.find(w => w.label === label)?.id ?? null) : null)
  const create = !selected
  const value = !selected ? '' : list.some(w => w.id === selected) ? selected : (list[0]?.id ?? '')
  return { list, value, create, seed: (want && 'create' in want ? want.create : '') || label }
}

/** A new workspace's default name: the lane's title, else the folder's name. */
export const workspaceName = (category: string, title: string, cwd: string, t: Translator): string =>
  category && category !== 'other' ? title : baseName(cwd) || t('launch.workspaceDefault')

/** A folder in a git checkout: its root and the branch it is on. */
export type GitInfo = { root: string; branch: string }

/** The line under the worktree choice: where the new branch goes, or why the branch name will not do. */
export function worktreeNote(
  git: GitInfo,
  wt: boolean,
  branch: string,
  t: Translator,
): { text: string; error: boolean } {
  if (!wt) return { text: '', error: false }
  const why = checkBranch(branch)
  return {
    text: why ? t(why) : t('launch.worktreeAt', { path: worktreePath(git.root, branch.trim()), branch: git.branch }),
    error: !!why,
  }
}

/** The server's answer about the folder field, with what was typed when it was asked. */
export type FolderCheck = DirListing & { input: string }

export type ProblemField = 'name' | 'cwd' | 'profile' | 'workspace' | 'worktree'
export type Problems = Partial<Record<ProblemField, string>>

/**
 * What keeps the form from starting, field by field (in the form's order); `profile`: the
 * window's profile (models/launch-profile.ts), which lacks one while it offers the choice and
 * none is picked.
 */
export function formProblems(
  f: LaunchFields,
  check: FolderCheck | null,
  git: GitInfo | null,
  t: Translator,
  profile?: ProfilePick,
): Problems {
  const out: Problems = {}
  const bad = checkName(f.name)
  if (bad) out.name = t(bad, { max: NAME_MAX })
  if (!f.cwd.trim()) out.cwd = t('launch.err.cwdEmpty')
  else if (check && (!check.exists || !check.dir) && check.path)
    out.cwd = t(check.slow ? 'launch.err.cwdSlow' : check.exists ? 'launch.err.cwdFile' : 'launch.err.cwdMissing', {
      path: check.path,
    })
  if (profile?.offered && !profile.picked) out.profile = t('launch.err.profileChoose')
  if (!f.workspace && !f.newWorkspace.trim()) out.workspace = t('launch.err.workspaceName')
  const branch = git && f.wt ? checkBranch(f.branch) : ''
  if (branch) out.worktree = t(branch)
  return out
}

/**
 * The Start button: off without fresh data, with a problem (a profile to choose among them), while
 * the folder is checked or the form is on its way.
 */
export function goButton(
  s: { canMutate: boolean; problems: Problems; checking: boolean; sending: boolean },
  t: Translator,
): { disabled: boolean; title: string } {
  return {
    disabled: !s.canMutate || Object.keys(s.problems).length > 0 || s.checking || s.sending,
    title: !s.canMutate ? t('mobile.readOnly') : (Object.values(s.problems)[0] ?? ''),
  }
}

/** The field a problem is about, to put the focus in. */
export const fieldOf = (problem: string): string => (problem === 'worktree' ? 'branch' : problem)

/** The whole form as a draft: the workspace by its label (`label`, the picked one's), or a new one's name. */
export const draftOf = (f: LaunchFields, category: string, label: string): LaunchDraft => ({
  name: f.name,
  cwd: f.cwd,
  category,
  message: f.message,
  workspace: f.workspace ? label : f.newWorkspace,
  newWorkspace: !f.workspace,
  worktree: f.wt ? { branch: f.branch } : null,
})

/** The workspace a start goes to: the picked one (by id, with its label), or a new one. */
export type StartWorkspace = { id: string; label: string } | { create: string }

/**
 * POST /api/launch's body. `profile`: the Claude profile it starts in, `parent`: the key of the
 * card it was started from, whose profile the server holds it to (models/launch-profile.ts
 * profileBody says when they go).
 */
export interface StartBody {
  name: string
  cwd: string
  category: string
  workspace: StartWorkspace
  message: string
  worktree?: { branch: string }
  profile?: string
  parent?: string
}

/**
 * What a start sends: the folder as the server resolved it when that answer is about what is
 * typed now; a worktree only for a folder in a checkout; the profile and the card it came from
 * when given.
 */
export function startBody(
  f: LaunchFields,
  s: {
    check: FolderCheck | null
    git: GitInfo | null
    category: string
    label: string
    profile?: string
    parent?: string
  },
): StartBody {
  const cwd = f.cwd.trim()
  const workspace: StartWorkspace = f.workspace
    ? { id: f.workspace, label: s.label }
    : { create: f.newWorkspace.trim() }
  return {
    name: f.name.trim(),
    cwd: (s.check?.exists && s.check.input === cwd && s.check.path) || cwd,
    category: s.category,
    workspace,
    message: f.message.trim(),
    ...(s.git && f.wt ? { worktree: { branch: f.branch.trim() } } : {}),
    ...(s.profile === undefined ? {} : { profile: s.profile }),
    ...(s.parent === undefined ? {} : { parent: s.parent }),
  }
}

/** The page's own card for a start, until the server's board has the launch. */
export function startedLaunch(id: string, body: StartBody, now: number): LaunchView {
  const ws = body.workspace
  return {
    id,
    name: body.name,
    cwd: body.cwd,
    category: body.category,
    workspace: 'id' in ws ? ws.label : ws.create,
    workspaceId: null,
    newWorkspace: !('id' in ws),
    message: body.message,
    worktree: body.worktree ?? null,
    state: 'starting',
    step: 'prepare',
    error: '',
    kind: '',
    startedAt: now,
    doneAt: null,
    pane: null,
    key: null,
    ...(body.profile === undefined ? {} : { profile: body.profile }),
    ...(body.parent === undefined ? {} : { parent: body.parent }),
  }
}
