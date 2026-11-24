// Claude Code's session-local TodoWrite checklist, read from the transcript (#637).
// Distinct from core/todos.ts (pinned tasks across sessions, #202).

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed'

export interface ChecklistItem {
  content: string
  status: ChecklistStatus
  activeForm?: string
}

export interface Checklist {
  done: number
  total: number
  current: string
  items: ChecklistItem[]
  at?: number
}

export const MAX_CHECKLIST_ITEMS = 50
export const MAX_CHECKLIST_TEXT = 200

const VALID_STATUS = new Set<ChecklistStatus>(['pending', 'in_progress', 'completed'])

function singleLine(raw: unknown, max = MAX_CHECKLIST_TEXT): string {
  if (typeof raw !== 'string') return ''
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function asItem(raw: unknown): ChecklistItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const content = singleLine(r.content)
  if (!content) return null
  if (typeof r.status !== 'string' || !VALID_STATUS.has(r.status as ChecklistStatus)) return null
  const activeForm = singleLine(r.activeForm)
  return {
    content,
    status: r.status as ChecklistStatus,
    ...(activeForm && { activeForm }),
  }
}

/**
 * Parse a TodoWrite tool input (`{ todos: [...] }`).
 * - `{ found: false }`: not a TodoWrite checklist payload (keep scanning older lines).
 * - `{ found: true }` without `checklist`: empty or all items completed (settle and hide).
 * - `{ found: true, checklist }`: active checklist with remaining work.
 */
export function parseChecklist(input: unknown, at?: number): { found: boolean; checklist?: Checklist } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { found: false }
  const rawTodos = (input as Record<string, unknown>).todos
  if (!Array.isArray(rawTodos)) return { found: false }

  const items: ChecklistItem[] = []
  for (const raw of rawTodos) {
    if (items.length >= MAX_CHECKLIST_ITEMS) break
    const item = asItem(raw)
    if (item) items.push(item)
  }

  const total = items.length
  if (total === 0) return { found: true }

  let done = 0
  let active: ChecklistItem | undefined
  let nextPending: ChecklistItem | undefined
  for (const item of items) {
    if (item.status === 'completed') done++
    else if (item.status === 'in_progress' && !active) active = item
    else if (item.status === 'pending' && !nextPending) nextPending = item
  }

  if (done === total) return { found: true }

  const current = active ? (active.activeForm ?? active.content) : nextPending ? nextPending.content : ''
  return {
    found: true,
    checklist: {
      done,
      total,
      current,
      items,
      ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { at } : {}),
    },
  }
}

/** Whether a checklist has items left to finish. */
export const checklistActive = (c: Checklist | null | undefined): c is Checklist =>
  !!c && c.total > 0 && c.done < c.total && c.items.length > 0
