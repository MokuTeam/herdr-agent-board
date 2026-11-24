// `board spend [--day <d>] [--lane <id>] [--json]` (#636): token spend per session and per lane,
// by local day, read directly from Claude, Codex, and pi transcripts on demand.
import { nodeConfig } from '../core/nodes.ts'
import {
  addDays,
  dateIn,
  formatTokens,
  isDate,
  MAX_SPEND_DAYS,
  type SpendCounts,
  type SpendReport,
  spanLength,
} from '../core/spend.ts'
import type { Config, Item } from '../core/types.ts'
import type { Deps } from '../services/deps.ts'
import { collectSpend, spendZone } from '../services/spend.ts'
import { forwardNodeCall, type NodeCall, type NodeCallAnswer } from './node-call.ts'

export const SPEND_USAGE =
  'usage: board spend [--day <YYYY-MM-DD|today|yesterday> | --from <YYYY-MM-DD> [--to <YYYY-MM-DD>]] [--lane <id>] [--json]'

export interface SpendCmdContext {
  cfg: Config
  deps: Pick<Deps, 'profiles' | 'homes' | 'codex'>
  actor?: { key: string; name?: string } | 'user'
  call?: (body: NodeCall) => Promise<NodeCallAnswer>
  items?: readonly Item[]
  out?: (line: string) => void
  err?: (line: string) => void
  now?: number
  zone?: string
  codexRoots?: readonly string[]
  piRoots?: readonly string[]
}

const VALUE_FLAGS = new Set(['--day', '--from', '--to', '--lane'])

interface ParsedSpendArgs {
  day?: string
  from?: string
  to?: string
  lane?: string
  json: boolean
  help: boolean
}

function parseSpendArgs(rest: readonly string[]): ParsedSpendArgs {
  const out: ParsedSpendArgs = { json: false, help: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string
    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }
    if (a === '--json') {
      out.json = true
      continue
    }
    if (VALUE_FLAGS.has(a)) {
      const v = rest[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      if (a === '--day') out.day = v
      else if (a === '--from') out.from = v
      else if (a === '--to') out.to = v
      else if (a === '--lane') out.lane = v
      i++
      continue
    }
    throw new Error(`unknown option "${a}"`)
  }
  return out
}

function resolveDayToken(raw: string, today: string): string {
  if (raw === 'today') return today
  if (raw === 'yesterday') return addDays(today, -1)
  return raw
}

function countsText(c: SpendCounts): string {
  const cache = c.cacheRead + c.cacheWrite
  return `in ${formatTokens(c.input)} · out ${formatTokens(c.output)} · cache ${formatTokens(cache)}`
}

function formatReport(r: SpendReport): string[] {
  const range = r.from === r.to ? r.from : `${r.from}..${r.to}`
  const laneSuffix = r.lane ? ` · lane ${r.lane}` : ''
  if (r.total.total === 0) return [`no token spend for ${range}${laneSuffix}`]

  const lines: string[] = [
    `spend · ${range}${laneSuffix} · total ${formatTokens(r.total.total)} (${countsText(r.total)} · ${r.total.responses} ${r.total.responses === 1 ? 'response' : 'responses'})`,
  ]
  for (const l of r.lanes) {
    const sWord = l.sessions === 1 ? 'session' : 'sessions'
    lines.push(`  ${l.lane} · ${formatTokens(l.counts.total)} (${countsText(l.counts)} · ${l.sessions} ${sWord})`)
  }
  if (r.days.length > 1) {
    for (const d of r.days) {
      const parts = Object.entries(d.byLane)
        .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
        .map(([lane, c]) => `${lane} ${formatTokens(c.total)}`)
      lines.push(`  ${d.day} · ${formatTokens(d.counts.total)} (${parts.join(', ')})`)
    }
  }
  const shownSessions = r.lane ? r.sessions : r.sessions.slice(0, 10)
  for (const s of shownSessions) {
    lines.push(`  ${s.lane} · ${s.name} · ${formatTokens(s.counts.total)} (${countsText(s.counts)})`)
  }
  return lines
}

export async function spendCmd(rest: readonly string[], ctx: SpendCmdContext): Promise<number> {
  const out = ctx.out ?? ((line: string) => console.log(line))
  const err = ctx.err ?? ((line: string) => console.error(line))
  const jsonFlag = rest.includes('--json')

  const fail = (code: string, message: string): number => {
    if (jsonFlag) out(JSON.stringify({ ok: false, error: code, message }))
    else err(message)
    return 1
  }

  let parsed: ParsedSpendArgs
  try {
    parsed = parseSpendArgs(rest)
  } catch (e) {
    return fail('usage', `${e instanceof Error ? e.message : String(e)}\n${SPEND_USAGE}`)
  }

  if (parsed.help) {
    if (parsed.json) out(JSON.stringify({ usage: SPEND_USAGE }, null, 2))
    else out(SPEND_USAGE)
    return 0
  }

  if (nodeConfig(ctx.cfg.node)) {
    const session = ctx.actor && typeof ctx.actor !== 'string' ? ctx.actor.key : null
    return await forwardNodeCall({
      cmd: 'spend',
      argv: [...rest],
      session,
      port: ctx.cfg.port,
      json: jsonFlag,
      call: ctx.call,
      out,
      err,
    })
  }

  if (parsed.day !== undefined && (parsed.from !== undefined || parsed.to !== undefined)) {
    return fail('usage', `cannot combine --day with --from or --to\n${SPEND_USAGE}`)
  }

  const now = ctx.now ?? Date.now()
  const zone = ctx.zone ?? spendZone(ctx.cfg)
  const today = dateIn(now, zone)

  let from: string
  let to: string
  if (parsed.day !== undefined) {
    const resolved = resolveDayToken(parsed.day, today)
    if (!isDate(resolved)) return fail('usage', `invalid date "${parsed.day}"\n${SPEND_USAGE}`)
    from = resolved
    to = resolved
  } else if (parsed.from !== undefined || parsed.to !== undefined) {
    from = parsed.from ?? ''
    to = parsed.to ?? today
    const len = isDate(from) && isDate(to) ? spanLength(from, to) : 0
    if (len < 1 || len > MAX_SPEND_DAYS) {
      return fail('usage', `invalid date range (${MAX_SPEND_DAYS} days max)\n${SPEND_USAGE}`)
    }
  } else {
    from = today
    to = today
  }

  const lane = parsed.lane?.trim() || null
  const report = await collectSpend({
    cfg: ctx.cfg,
    deps: ctx.deps,
    ...(ctx.items && { items: ctx.items }),
    from,
    to,
    lane,
    zone,
    ...(ctx.codexRoots && { codexRoots: ctx.codexRoots }),
    ...(ctx.piRoots && { piRoots: ctx.piRoots }),
  })

  if (parsed.json) {
    out(JSON.stringify(report, null, 2))
  } else {
    for (const line of formatReport(report)) out(line)
  }
  return 0
}
