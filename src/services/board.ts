// The board's data: every agent pane in herdr plus the sessions herdr-wake put to sleep, each
// merged with its card and with what Claude recorded about it, and sorted into a column.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { allCards, writeCard } from '../adapters/cards.ts'
import { helpersOf } from '../adapters/helpers.ts'
import { snapshot } from '../adapters/herdr.ts'
import { isRecord } from '../adapters/json-store.ts'
import type { LinksIndex } from '../adapters/links.ts'
import { contextDir } from '../adapters/paths.ts'
import { attentionOf, busy, columnOf, isAgentStatus, PINS } from '../core/board.ts'
import { categoryFor } from '../core/categories.ts'
import { type HelperSummary, summarize } from '../core/helpers.ts'
import { t } from '../core/lang.ts'
import { relate } from '../core/links.ts'
import type { AgentStatus, Attention, Card, Item, Pin, ToolCall, TranscriptInfo } from '../core/types.ts'
import type { Deps } from './deps.ts'

const numberOf = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/**
 * The column the user dragged the card to, or ''. It holds until the session works again (the
 * user or another session wrote to it); a card dragged during a turn (card.pinBusy) lands there
 * once that turn is over. Spent pins are taken off the card file here; a write that fails (its
 * card is locked) is tried again on the next refresh instead of failing this one.
 */
function pinOf(key: string, status: AgentStatus, card: Card): Pin | '' {
  const pin = card.pin
  if (!pin || !PINS.has(pin)) return ''
  const save = (patch: Partial<Card>): void => {
    try {
      writeCard(key, patch)
    } catch {}
  }
  if (card.pinBusy) {
    if (!busy(status)) save({ pinBusy: '' })
  } else if (busy(status)) {
    save({ pin: '', pinAt: '', pinBusy: '' })
    return ''
  }
  return pin
}

/** What the user is asked, for the card. */
function askedText(attention: Attention, card: Card, info: TranscriptInfo, tool: ToolCall | null): string {
  if (attention === 'ask') return card.ask ?? ''
  if (attention === 'question') return info.question ?? ''
  if (attention !== 'decision' || !tool?.pending) return ''
  return tool.name === 'AskUserQuestion'
    ? (tool.detail ?? '')
    : t('note.permission', { what: `${tool.label}${tool.detail ? ` · ${tool.detail}` : ''}` })
}

interface ContextFile {
  at: number | undefined
  tokens: number | undefined
  usedPercentage: number | undefined
  size: number | undefined
}

const contextCache = new Map<string, { mtimeMs: number; data: ContextFile }>() // session -> file

function asContextFile(value: unknown): ContextFile {
  const d = isRecord(value) ? value : {}
  return {
    at: numberOf(d.at),
    tokens: numberOf(d.tokens),
    usedPercentage: numberOf(d.usedPercentage),
    size: numberOf(d.size),
  }
}

/**
 * How full a session's context is. The status line (entrypoints/statusline.ts) says it best, percentage and
 * window size included; without it, the tokens of the last request from the transcript.
 */
interface ContextFill {
  context: number | null
  contextPct: number | null
  contextSize: number | null
}

function contextOf(session: string | null, info: TranscriptInfo): ContextFill {
  const own: ContextFill = { context: info.context ?? null, contextPct: null, contextSize: null }
  if (!session) return own
  const file = join(contextDir(), `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  const st = statSync(file, { throwIfNoEntry: false })
  if (!st) return own
  let hit = contextCache.get(session)
  if (!hit || hit.mtimeMs !== st.mtimeMs) {
    try {
      hit = { mtimeMs: st.mtimeMs, data: asContextFile(JSON.parse(readFileSync(file, 'utf8'))) }
      contextCache.set(session, hit)
    } catch {
      return own
    }
  }
  const d = hit.data
  // The transcript can be newer (a reply the status line has not run for yet): its tokens win then.
  const fresh = !info.activity || (d.at !== undefined && d.at >= info.activity - 5000)
  return {
    context: (fresh && d.tokens) || own.context,
    contextPct: fresh ? (d.usedPercentage ?? null) : null,
    contextSize: d.size ?? null,
  }
}

/** What a pane or a sleeper tells before the card and the transcript are merged in. */
type Base = Pick<
  Item,
  | 'key'
  | 'session'
  | 'pane'
  | 'workspace'
  | 'agent'
  | 'name'
  | 'cwd'
  | 'status'
  | 'sleeping'
  | 'focused'
  | 'activity'
  | 'alive'
  | 'since'
  | 'pipe'
>

export interface CollectOptions {
  /** Each session's helpers (adapters/helpers.ts), for the web board. */
  helpers?: boolean
  /** How sessions work with each other: a links index (adapters/links.ts), for the web board. */
  links?: LinksIndex | null
}

/**
 * All board items, newest activity first. The web board also asks for each session's helpers
 * (`helpers`: adapters/helpers.ts) and how sessions work with each other (`links`: an index).
 */
export async function collect(deps: Deps, { helpers = false, links = null }: CollectOptions = {}): Promise<Item[]> {
  const { cfg, claude } = deps
  const [snap, asleep] = await Promise.all([snapshot(), deps.wake.sleepers()])
  const live = claude.liveSessions()
  const cards = allCards()
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const items: Item[] = []
  const seen = new Set<string>()

  const add = (base: Base): void => {
    const saved = cards.get(base.key) ?? {}
    const pin = pinOf(base.key, base.status, saved)
    const card: Card = { ...saved, pin }
    const path = base.session ? claude.transcriptPath(base.session, base.cwd) : null
    const info = claude.transcriptInfo(path) ?? {}
    const guess = categoryFor(cfg, base.cwd)
    const tool = info.tool ?? null
    const attention = attentionOf(base.status, card, info)
    let own: HelperSummary | null = null
    if (helpers && path) {
      try {
        own = summarize(helpersOf(path, { alive: !!base.alive, since: base.since ?? null }))
      } catch {} // helpers that cannot be read leave the session's card as it was
    }
    items.push({
      ...base,
      // A name given on the board beats the one herdr and Claude know it by; autoName is theirs.
      name: card.name || base.name,
      autoName: base.name,
      category: card.category || guess || 'other',
      categorySet: !!card.category,
      doing: card.doing ?? '',
      wait: card.wait ?? '',
      waitSince: card.waitSince ?? null,
      result: card.result ?? '',
      title: info.title ?? '',
      prompt: info.prompt ?? '',
      lastText: info.lastText ?? '',
      ...contextOf(base.session, info), // context: tokens of its last request; contextPct, contextSize when the status line said
      tool,
      attention,
      question: askedText(attention, card, info, tool),
      askSince: attention === 'ask' ? (card.askSince ?? null) : null,
      activity: info.activity ?? base.activity ?? 0,
      column: columnOf(base.status, card, info),
      pin, // the column the user dragged it to, or ''
      auto: columnOf(base.status, { ...card, pin: '' }, info), // where it would be without the pin
      helpers: own, // its subagents, forks, workflow agents and teammates in short, or null
      transcript: path,
    })
  }

  for (const p of snap.panes) {
    if (!p.agent) continue
    const session = p.agent_session?.value ?? null
    const key = session ?? `pane-${p.pane_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const reg = session ? live.get(session) : null
    add({
      key,
      session,
      pane: p.pane_id,
      workspace: labels.get(p.workspace_id ?? '') ?? '',
      agent: p.agent,
      name: reg?.name || p.terminal_title_stripped || p.label || p.pane_id,
      cwd: p.cwd ?? reg?.cwd ?? '',
      status: isAgentStatus(p.agent_status) ? p.agent_status : 'unknown',
      sleeping: false,
      focused: p.pane_id === snap.focused_pane_id,
      activity: numberOf(reg?.statusUpdatedAt) ?? 0,
      // Its Claude process: whether it runs, since when, and the pipe other sessions write to.
      alive: !!reg,
      since: numberOf(reg?.startedAt) ?? null,
      pipe: typeof reg?.messagingSocketPath === 'string' ? reg.messagingSocketPath : '',
    })
  }

  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  for (const s of asleep) {
    if (!s.session || seen.has(s.session)) continue
    seen.add(s.session)
    add({
      key: s.session,
      session: s.session,
      pane: s.pane ?? null,
      workspace: s.workspace ?? '',
      agent: 'claude',
      name: s.name || s.session.slice(0, 8),
      cwd: panes.get(s.pane ?? '')?.cwd ?? '',
      status: 'sleeping',
      sleeping: true,
      focused: false,
      activity: Date.parse(s.slept_at ?? '') || 0,
    })
  }

  items.sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0))
  if (links) {
    links.update(items.map(i => i.transcript))
    const rel = relate(items, it => links.events(it.transcript))
    for (const it of items) {
      const l = rel.get(it.key)
      it.links = l && (l.from || l.started.length || l.talks.length) ? l : null
    }
  }
  return items
}
