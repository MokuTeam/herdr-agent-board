// The board as the web page sees it: the latest items, whether they are fresh, and the payload
// GET /api/board answers with and the event stream pushes.
import { readUsageCache } from '../adapters/claude-home.ts'
import { FILE_TOKEN } from '../adapters/files.ts'
import { createLinks } from '../adapters/links.ts'
import { stateDir } from '../adapters/paths.ts'
import { listEntries, readLog } from '../adapters/schedule-store.ts'
import { COLUMNS } from '../core/board.ts'
import { categoryInfo, colorHex, laneRank, PALETTE } from '../core/categories.ts'
import { LANGUAGES } from '../core/i18n/translator.ts'
import { lang } from '../core/lang.ts'
import type { BoardLimits, BoardPayload } from '../core/payload.ts'
import type { SetupSummary } from '../core/setup.ts'
import type { Item } from '../core/types.ts'
import { collect } from '../services/board.ts'
import type { Deps } from '../services/deps.ts'
import type { Launches } from '../services/launch/launches.ts'
import { type Terminals, terminalOn } from '../services/terminals.ts'

export interface BoardState {
  /** The latest payload, as JSON text. */
  payload(): string
  items(): Item[]
  find(key: string): Item | undefined
  /** True when the data is too old for actions that go through herdr. */
  stale(): boolean
  /** Builds the payload again and pushes it to live clients when the board changed. */
  publish(): void
  /** Collects the board from herdr and the files; a call during one runs once more after it. */
  refresh(): Promise<void>
}

interface Options {
  deps: Deps
  launches: Launches
  /** The terminal's shells (services/terminals.ts): the sessions the board opened one for. */
  terminals?: Pick<Terminals, 'keys' | 'stopAll'>
  /** The page's version (web-bundle.ts): open pages reload when it changes. */
  version: () => string
  /** Pushes a payload to the live clients. */
  push: (payload: string) => void
  /** The setup check's summary (services/setup-check.ts). */
  setup?: () => SetupSummary | null
  /** Whether MokuPilot is here for calls with a fork of a session (services/mokupilot.ts). */
  mokupilot?: () => boolean
}

// The colors the category editor offers (aliases left out).
const SWATCHES = Object.entries(PALETTE)
  .filter(([name]) => !['magenta', 'white'].includes(name))
  .map(([name, hex]) => ({ name, hex }))

/**
 * Claude's usage windows (claude-home.ts): from the board's own status line when Claude Code runs it,
 * else from the usagebar cache, else null. Windows past their reset are left out: Claude starts
 * them over. No age in it, so data that does not change does not make the board go out again.
 */
function claudeLimits(deps: Deps): BoardLimits | null {
  const sources = [
    ['statusline', readUsageCache(stateDir()).limits],
    ['usagebar', deps.claude.localUsage().limits],
  ] as const
  for (const [source, l] of sources) {
    const windows = l.available ? (l.windows ?? []).filter(w => !w.expired) : []
    if (windows.length)
      return { source, observedAt: l.observedAt, stale: Date.now() - (l.observedAt ?? 0) > 30 * 60_000, windows }
  }
  return null
}

export function createBoardState({ deps, launches, terminals, version, push, setup, mokupilot }: Options): BoardState {
  const { cfg, log } = deps
  let items: Item[] = []
  let stale = true
  let lastSuccessfulRefreshAt: number | null = null
  let payload = ''

  /** The board as clients see it, without the time of the last successful refresh. */
  function board(): Omit<BoardPayload, 'lastSuccessfulRefreshAt'> {
    const ids = [...new Set([...cfg.categories.map(c => c.id), ...items.map(i => i.category)])]
    const categories = ids
      .sort((a, b) => laneRank(cfg, a) - laneRank(cfg, b) || a.localeCompare(b))
      .map(id => {
        const c = categoryInfo(cfg, id)
        const configured = cfg.categories.some(x => x.id === id)
        return {
          id,
          title: c.title,
          color: colorHex(c.color),
          colorName: c.color,
          paths: c.paths ?? [],
          configured,
          fallback: id === 'other',
        }
      })
    // What the page has no use for stays here: file paths (the Claude folder included), the Claude
    // process and its pipe.
    const list = items.map(({ transcript, claudeRoot, alive, since, pipe, ...rest }) => launches.decorate(rest))
    // The schedule without the scheduler's bookkeeping; the log is what was sent or missed lately.
    const schedules = listEntries().map(({ claim, tried, waited, ...entry }) => entry)
    return {
      version: version(),
      lang: lang(),
      language: cfg.language ?? 'auto',
      languages: LANGUAGES,
      fsToken: FILE_TOKEN,
      stale,
      limits: claudeLimits(deps),
      items: list,
      launches: launches.list(),
      categories,
      swatches: SWATCHES,
      columns: COLUMNS.map(({ id, title }) => ({ id, title })),
      schedules,
      scheduleLog: readLog(20),
      // terminal: whether the board offers one (config `terminal`); shells: sessions it opened one for.
      terminal: terminalOn(cfg),
      shells: terminalOn(cfg) ? (terminals?.keys() ?? []) : [],
      // mokupilot: whether a session's sheet offers a MokuPilot call with a fork of it.
      mokupilot: mokupilot?.() ?? false,
      setup: setup?.() ?? null,
    }
  }

  // GET always answers with the latest payload. Live clients get it again only when the board
  // changed (stale included): a refresh time that moves every few seconds alone is no news.
  let sent = ''
  function publish(): void {
    // Turned off in config.json: no pane stays on show.
    if (!terminalOn(cfg)) terminals?.stopAll()
    const next = board()
    const key = JSON.stringify(next)
    payload = JSON.stringify({ ...next, lastSuccessfulRefreshAt })
    if (key === sent) return
    sent = key
    push(payload)
  }

  // Who started whom and who wrote to whom, read from the transcripts in the background
  // (adapters/links.ts); a read that found something new refreshes the board.
  const links = createLinks({ onChange: () => void refresh() })

  let refreshing = false
  let again = false
  async function refresh(): Promise<void> {
    if (refreshing) {
      again = true
      return
    }
    refreshing = true
    try {
      items = await collect(deps, { helpers: true, links })
      launches.observe(items)
      stale = false
      lastSuccessfulRefreshAt = Date.now()
      publish()
    } catch (err) {
      stale = true
      publish()
      log(`refresh: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      refreshing = false
    }
    if (again) {
      again = false
      void refresh()
    }
  }

  return {
    payload: () => payload,
    items: () => items,
    find: key => items.find(i => i.key === key),
    stale: () =>
      stale ||
      !lastSuccessfulRefreshAt ||
      Date.now() - lastSuccessfulRefreshAt > Math.max(10000, (cfg.refreshSec ?? 2) * 3000),
    publish,
    refresh,
  }
}
