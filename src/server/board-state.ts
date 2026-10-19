// The board as the web page sees it: the latest items, whether they are fresh, and the payload
// GET /api/board answers with and the event stream pushes.
import { statSync } from 'node:fs'
import { readUsageFile } from '../adapters/claude-home.ts'
import { FILE_TOKEN } from '../adapters/files.ts'
import { notify } from '../adapters/herdr.ts'
import { hooksInstalled } from '../adapters/hook-settings.ts'
import { createLinks } from '../adapters/links.ts'
import { ROOT, usageFileFor } from '../adapters/paths.ts'
import { forgetProfilePanes } from '../adapters/profile-panes.ts'
import { listEntries, readLog } from '../adapters/schedule-store.ts'
import { COLUMNS } from '../core/board.ts'
import { categoryInfo, colorHex, laneRank, PALETTE } from '../core/categories.ts'
import { LANGUAGES } from '../core/i18n/translator.ts'
import { lang, t } from '../core/lang.ts'
import { claudeProgram, commandText } from '../core/launch/spawn-args.ts'
import type { Limits } from '../core/limits.ts'
import type { BoardLimits, BoardPayload, BoardProfile } from '../core/payload.ts'
import { DEFAULT_PROFILE, type Profile, profileLabel } from '../core/profiles.ts'
import { boardFiles, type SetupSummary } from '../core/setup.ts'
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

// The files of this copy of the board: a profile's settings.json has its hooks when they run these.
const FILES = boardFiles(ROOT)

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * A profile's Claude usage windows (claude-home.ts): from the board's own status line when Claude
 * Code runs it in the profile's sessions (usageFileFor), else from the profile's usagebar cache,
 * else null. Windows past their reset are left out: Claude starts them over. No age in it, so data
 * that does not change does not make the board go out again.
 */
function profileLimits(deps: Deps, profile: Profile): BoardLimits | null {
  const sources: [BoardLimits['source'], Limits][] = [
    ['statusline', readUsageFile(usageFileFor(profile.id)).limits],
    ['usagebar', deps.homes.forDir(profile.dir).localUsage().limits],
  ]
  for (const [source, l] of sources) {
    const windows = l.available ? (l.windows ?? []).filter(w => !w.expired) : []
    if (windows.length)
      return { source, observedAt: l.observedAt, stale: Date.now() - (l.observedAt ?? 0) > 30 * 60_000, windows }
  }
  return null
}

/** Every profile, shown and hidden, as the page shows it: `items` are the sessions on the board. */
function boardProfiles(deps: Deps, items: readonly Item[]): BoardProfile[] {
  const set = deps.profiles()
  return set.list.map(p => ({
    id: p.id,
    title: p.title,
    color: colorHex(p.color),
    colorName: p.color,
    dir: p.dir,
    hidden: p.hidden,
    inherited: p.id === set.inherited?.id,
    exists: isFolder(p.dir),
    // A hidden profile's settings.json is not read: Install leaves it alone.
    hooks: p.hidden ? null : hooksInstalled(p.dir, FILES),
    sessions: items.filter(i => i.profile === p.id).length,
    limits: profileLimits(deps, p),
    command: commandText(p.command),
  }))
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
          // The lane's usual profile, when the config gives it one.
          ...(typeof c.profile === 'string' && c.profile !== '' ? { profile: c.profile } : {}),
        }
      })
    // What the page has no use for stays here: file paths (the Claude folder included), the Claude
    // process and its pipe.
    const list = items.map(({ transcript, claudeRoot, alive, since, pipe, ...rest }) => launches.decorate(rest))
    // The schedule without the scheduler's bookkeeping; the log is what was sent or missed lately.
    const schedules = listEntries().map(({ claim, tried, waited, ...entry }) => entry)
    // The usage the pill shows: the board's own profile's (the default one's when its env points to
    // none), as before profiles.
    const profiles = boardProfiles(deps, items)
    const own = profiles.find(p => p.inherited) ?? profiles.find(p => p.id === DEFAULT_PROFILE)
    return {
      version: version(),
      lang: lang(),
      language: cfg.language ?? 'auto',
      languages: LANGUAGES,
      fsToken: FILE_TOKEN,
      stale,
      limits: own?.limits ?? null,
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
      profiles,
      // What a profile without a start command types: the Profiles panel's placeholder.
      claudeProgram: claudeProgram(cfg.launch?.claude, cfg.launch?.args),
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

  // A session whose hooks report another profile than its start asked for gets a herdr notification,
  // once in this process; its card's red tag stays. A notification that fails is logged.
  const warned = new Set<string>()
  async function warnWrongProfiles(): Promise<void> {
    const wrong = items.filter(i => i.profileWanted && !warned.has(i.key))
    if (!wrong.length) return
    try {
      const set = deps.profiles()
      await Promise.all(
        wrong.map(async item => {
          warned.add(item.key)
          const want = item.profileWanted ?? ''
          const vars = {
            name: item.name,
            want: set.list.find(p => p.id === want)?.title || want,
            got: profileLabel(item, set),
          }
          try {
            await notify(t('profile.wrongTitle', vars), t('profile.wrongBody', vars))
          } catch (err) {
            log(`wrong profile notification: ${err instanceof Error ? err.message : String(err)}`)
          }
        }),
      )
    } catch (err) {
      log(`wrong profile notification: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  let refreshing = false
  let again = false
  async function refresh(): Promise<void> {
    if (refreshing) {
      again = true
      return
    }
    refreshing = true
    try {
      // The panes the board opened in a profile that herdr no longer has, or gave to another
      // terminal, are forgotten; one opened while herdr was being asked is not in its answer yet.
      const asked = Date.now()
      const seen = (panes: ReadonlyMap<string, string | null>): void => {
        try {
          forgetProfilePanes(panes, asked)
        } catch (err) {
          log(`profile panes: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      items = await collect(deps, { helpers: true, links, seen })
      launches.observe(items)
      stale = false
      lastSuccessfulRefreshAt = Date.now()
      publish()
      await warnWrongProfiles()
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
