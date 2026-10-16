// A launch request from the new-session window, checked before anything runs: the name, a folder
// that is there, a lane the board has, a workspace herdr takes, the first message, a branch.
import { resolvePath } from '../../adapters/files.ts'
import { SLOW, statOf } from '../../adapters/folders.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { checkBranch, checkName, NAME_MAX, UNSAFE_CHARS } from '../../core/launch/names.ts'
import type { Vars } from '../../core/types.ts'

const MESSAGE_MAX = 20_000
const WORKSPACE_ID = /^[A-Za-z0-9][\w:-]{0,39}$/
const CATEGORY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** A workspace name herdr takes as a value: no control characters, no leading dash. */
const workspaceName = (s: string, max: number): boolean =>
  !!s && s.length <= max && !UNSAFE_CHARS.test(s) && !s.startsWith('-')

/** What a checked request asks for. `newWorkspace`: make the workspace `workspaceLabel` first. */
export interface LaunchRequest {
  name: string
  label: string
  cwd: string
  category: string
  workspaceId: string
  workspaceLabel: string
  newWorkspace: boolean
  message: string
  worktree: { branch: string } | null
}

export type CheckResult = { ok: true; launch: LaunchRequest } | { ok: false; field: string; error: string }

/** Check a launch request: { ok, launch }, or { ok: false, field, error } for the field at fault. */
export async function checkRequest(
  body: unknown,
  { categories = null }: { categories?: Set<string> | null } = {},
): Promise<CheckResult> {
  const fail = (field: string, key: string, vars?: Vars): CheckResult => ({ ok: false, field, error: t(key, vars) })
  const b = isRecord(body) ? body : {}
  const name = String(b.name ?? '').trim()
  const bad = checkName(name)
  if (bad) return fail('name', bad, { max: NAME_MAX })
  const { path: cwd } = resolvePath(b.cwd)
  if (!cwd) return fail('cwd', 'launch.err.cwdEmpty')
  const st = await statOf(cwd, 3000)
  if (st === SLOW) return fail('cwd', 'launch.err.cwdSlow', { path: cwd })
  if (!st) return fail('cwd', 'launch.err.cwdMissing', { path: cwd })
  if (!st.isDirectory()) return fail('cwd', 'launch.err.cwdFile', { path: cwd })
  // A lane the board has (configured, or one an agent made), or "other" when none was given.
  const category = String(b.category ?? '') || 'other'
  if (!CATEGORY_ID.test(category) || (categories && category !== 'other' && !categories.has(category)))
    return fail('category', 'launch.err.category', { id: category })
  const ws = isRecord(b.workspace) ? b.workspace : {}
  let workspaceId = ''
  let workspaceLabel = ''
  if (ws.id) {
    if (!WORKSPACE_ID.test(String(ws.id))) return fail('workspace', 'launch.err.workspace')
    workspaceId = String(ws.id)
    workspaceLabel = String(ws.label ?? '').trim()
    if (workspaceLabel && !workspaceName(workspaceLabel, 60)) workspaceLabel = ''
  } else {
    workspaceLabel = String(ws.create ?? '').trim()
    if (!workspaceName(workspaceLabel, 40)) return fail('workspace', 'launch.err.workspaceName')
  }
  const message = String(b.message ?? '').trim()
  if (message.length > MESSAGE_MAX) return fail('message', 'launch.err.message', { n: MESSAGE_MAX })
  let worktree: LaunchRequest['worktree'] = null
  if (b.worktree) {
    const branch = String((isRecord(b.worktree) ? b.worktree.branch : undefined) ?? '').trim()
    const why = checkBranch(branch)
    if (why) return fail('worktree', why)
    worktree = { branch }
  }
  return {
    ok: true,
    launch: {
      name,
      label: name,
      cwd,
      category,
      workspaceId,
      workspaceLabel,
      newWorkspace: !workspaceId,
      message,
      worktree,
    },
  }
}
