// The board as the web page sees it: the latest items, whether they are fresh, and the payload
// GET /api/board answers with and the event stream pushes.
import { existsSync, statSync } from 'node:fs'
import { localAgyLimits } from '../adapters/agy-limits.ts'
import { readArchiveLog } from '../adapters/archive-store.ts'
import { readUsageFile } from '../adapters/claude-home.ts'
import { createEdgeLog, type EdgeLog } from '../adapters/edge-log.ts'
import { FILE_TOKEN } from '../adapters/files.ts'
import { notify } from '../adapters/herdr.ts'
import { createLinks } from '../adapters/links.ts'
import { usageFileFor } from '../adapters/paths.ts'
import { forgetProfilePanes } from '../adapters/profile-panes.ts'
import { listEntries, listWatches, readLog, watchesDir } from '../adapters/schedule-store.ts'
import { type BoardAgyLimits, pickAgyLimits } from '../core/agy-limits.ts'
import { COLUMNS } from '../core/board.ts'
import { besideParents } from '../core/call-agent.ts'
import { categoryInfo, colorHex, laneRank, PALETTE } from '../core/categories.ts'
import { compactDefaultText } from '../core/compact.ts'
import type { DecisionsPayload } from '../core/decisions.ts'
import { foldModeOf } from '../core/fold-mode.ts'
import { LANGUAGES } from '../core/i18n/translator.ts'
import { lang, t } from '../core/lang.ts'
import { claudeProgram, commandText } from '../core/launch/spawn-args.ts'
import type { Limits } from '../core/limits.ts'
import { familyTitle } from '../core/model-check.ts'
import { LOCAL, parseNodeKey } from '../core/nodes.ts'
import type {
  BackupPayload,
  BoardLimits,
  BoardPayload,
  BoardProfile,
  CalendarPayload,
  JournalPayload,
  ThreadsPayload,
  TimePayload,
} from '../core/payload.ts'
import type { PresenceView } from '../core/presence.ts'
import { DEFAULT_PROFILE, type Profile, profileLabel } from '../core/profiles.ts'
import type { RemoteView } from '../core/remote.ts'
import type { ScheduleEntry } from '../core/schedule-rules.ts'
import type { SetupSummary } from '../core/setup.ts'
import { todosConfig } from '../core/todos.ts'
import type { Item } from '../core/types.ts'
import type { WakeView } from '../core/wake/view.ts'
import { watchesConfig } from '../core/watches.ts'
import type { WorkdeskPayload } from '../core/workdesk.ts'
import type { DialogStatus } from '../core/workdesk-dialog.ts'
import type { BoardObservation } from '../core/workdesk-topology.ts'
import { collect } from '../services/board.ts'
import type { Deps } from '../services/deps.ts'
import { canFork } from '../services/launch/fork.ts'
import type { Launches } from '../services/launch/launches.ts'
import type { NodeAggregate } from '../services/nodes/aggregate.ts'
import { hooksInPlace } from '../services/profiles.ts'
import { type Terminals, terminalOn } from '../services/terminals.ts'

export interface BoardState {
  /** The latest payload, as JSON text. */
  payload(): string
  items(): Item[]
  observation(): BoardObservation | null
  find(key: string): Item | undefined
  /**
   * find(), and for a key with another device's prefix (core/nodes.ts nodeKey) that device's item
   * (#500): for what reaches a node through its link, never through this computer's herdr.
   */
  findAny(key: string): Item | undefined
  /** True when the data is too old for actions that go through herdr. */
  stale(): boolean
  /** Builds the payload again and pushes it to live clients when the board changed. */
  publish(): void
  /** Collects the board from herdr and the files; a call during one runs once more after it. */
  refresh(): Promise<void>
  /** The edge log's lines after number `since` (adapters/edge-log.ts). */
  edges: EdgeLog['read']
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
  /** Sleep and wake's state line at once (services/wake/control.ts current); null: none in the payload. */
  wake?: () => WakeView | null
  /** Whether MokuPilot is here for calls with a fork of a session (services/mokupilot.ts). */
  mokupilot?: () => boolean
  /** The remote mode as the page shows it; null while it is off (server/remote.ts). */
  remote?: () => RemoteView | null
  /** Whether the board can ask a session a side question (services/aside.ts: /btw in its pane). */
  aside?: () => boolean
  /** The Remote access view's revision (app.ts counts its changes). */
  accessRev?: () => number
  /** The peer network's revision (services/team-hub.ts); null while `team` is not on. */
  teamRev?: () => number | null
  /** The team's unread messages (services/team-notify.ts, #355); null while `team` is not on. */
  teamUnread?: () => number | null
  /** What the owner's phone asked and waits for the passkey on this computer (#377); null while none. */
  teamWaiting?: () => number | null
  /** The Omarchy theme's stamp (adapters/omarchy.ts), on a computer with Omarchy only. */
  omarchy?: () => string | null
  /** The user's presence (services/presence.ts); null while it is not on. */
  presence?: () => PresenceView | null
  /** The backup's line (#233); null while there is no database and no target. */
  backup?: () => BackupPayload | null
  /** Time tracking's line (#233); null while it is off. */
  time?: () => TimePayload | null
  /** The calendar's line (#328); null while it is off. */
  calendar?: () => CalendarPayload | null
  /** Threads' line (#379); null while they are off. */
  threads?: () => ThreadsPayload | null
  /** Decisions' queue (#487) from the board's items; null while they are off. */
  decisions?: (items: readonly Item[]) => DecisionsPayload | null
  workdesk?: () => WorkdeskPayload | null
  workdeskDialog?: () => DialogStatus | null
  observeSessions?: NonNullable<Parameters<typeof collect>[1]>['observed']
  /** The away journal (#489, services/journal.ts): fed each refresh's items; its part of the payload, null while off. */
  journal?: { observe(items: readonly Item[]): void; view(): JournalPayload | null }
  observeFailure?: () => void
  /**
   * The master's devices (#500, services/nodes/aggregate.ts): their items, launches and schedule
   * entries go into the payload beside this computer's, with the devices' row. null while `nodes`
   * is off: the payload is what it was without them. items(), find() and observation() never see them.
   */
  nodes?: () => Pick<NodeAggregate, 'part' | 'find'> | null
  /** Local Antigravity (Gemini) usage reading (#647), injectable for tests; defaults to localAgyLimits(cfg.launch). */
  agyLimits?: () => BoardAgyLimits | null | undefined
}

// The colors the category editor offers (aliases left out).
const SWATCHES = Object.entries(PALETTE)
  .filter(([name]) => !['magenta', 'white'].includes(name))
  .map(([name, hex]) => ({ name, hex }))

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
    hooks: p.hidden ? null : hooksInPlace(p.dir),
    sessions: items.filter(i => i.profile === p.id).length,
    limits: profileLimits(deps, p),
    command: commandText(p.command),
  }))
}

function wakeOf(wake: Options['wake']): { wake?: WakeView } {
  const view = wake?.() ?? null
  return view ? { wake: view } : {}
}

function omarchyOf(omarchy: Options['omarchy']): { omarchy?: string } {
  const stamp = omarchy?.() ?? null
  return stamp ? { omarchy: stamp } : {}
}

function presenceOf(presence: Options['presence']): { presence?: PresenceView } {
  const view = presence?.() ?? null
  return view ? { presence: view } : {}
}

function teamRevOf(teamRev: Options['teamRev']): { teamRev?: number } {
  const rev = teamRev?.() ?? null
  return rev !== null ? { teamRev: rev } : {}
}

function teamUnreadOf(teamUnread: Options['teamUnread']): { teamUnread?: number } {
  const n = teamUnread?.() ?? null
  return n !== null ? { teamUnread: n } : {}
}

function teamWaitingOf(teamWaiting: Options['teamWaiting']): { teamWaiting?: number } {
  const n = teamWaiting?.() ?? null
  return n !== null ? { teamWaiting: n } : {}
}

function timeOf(time: Options['time']): { time?: TimePayload } {
  const line = time?.() ?? null
  return line ? { time: line } : {}
}

function calendarOf(calendar: Options['calendar']): { calendar?: CalendarPayload } {
  const line = calendar?.() ?? null
  return line ? { calendar: line } : {}
}

function decisionsOf(decisions: Options['decisions'], items: readonly Item[]): { decisions?: DecisionsPayload } {
  const line = decisions?.(items) ?? null
  return line ? { decisions: line } : {}
}

function threadsOf(threads: Options['threads']): { threads?: ThreadsPayload } {
  const line = threads?.() ?? null
  return line ? { threads: line } : {}
}

function journalOf(journal: Options['journal']): { journal?: JournalPayload } {
  const view = journal?.view() ?? null
  return view ? { journal: view } : {}
}

function backupOf(backup: Options['backup']): { backup?: BackupPayload } {
  const line = backup?.() ?? null
  return line ? { backup: line } : {}
}

function remoteOf(remote: Options['remote']): { remote?: RemoteView } {
  const view = remote?.() ?? null
  return view ? { remote: view } : {}
}

export function createBoardState({
  deps,
  launches,
  terminals,
  version,
  push,
  setup,
  wake,
  mokupilot,
  remote,
  aside,
  accessRev,
  teamRev,
  teamUnread,
  teamWaiting,
  omarchy,
  presence,
  backup,
  time,
  calendar,
  threads,
  decisions,
  workdesk,
  workdeskDialog,
  observeSessions,
  observeFailure,
  nodes,
  journal,
  agyLimits: readAgyLimits,
}: Options): BoardState {
  const { cfg, log } = deps
  let items: Item[] = []
  let stale = true
  let lastSuccessfulRefreshAt: number | null = null
  let payload = ''
  // Watches turned off (#596) with watches still set: the page shows them as not checked. Null until
  // the first payload with watches off looks for the folder once, so a board that never had watches
  // (no folder) reads nothing on its refreshes.
  let offWatches: boolean | null = null

  /** The watches for the payload: all of them while on; while off, the ones left, marked `off`. */
  function watchesFor(): ScheduleEntry[] {
    if (watchesConfig(cfg.watches)) {
      offWatches = true
      return listWatches().map(({ claim, ...watch }) => watch)
    }
    if (offWatches === null) offWatches = existsSync(watchesDir())
    if (!offWatches) return []
    return listWatches().map(({ claim, ...watch }) => ({ ...watch, off: true as const }))
  }

  /** The board as clients see it, without the time of the last successful refresh. */
  function board(): Omit<BoardPayload, 'lastSuccessfulRefreshAt'> {
    // Other devices' cards (#500), only while this board is a master: a lane of theirs this board
    // does not have shows as any lane a session made up does.
    const others = nodes?.()?.part() ?? null
    const shown = others ? [...items, ...others.items] : items
    const ids = [...new Set([...cfg.categories.map(c => c.id), ...shown.map(i => i.category)])]
    const workdeskLine = workdesk?.()
    const dialogLine = workdeskDialog?.()
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
    // Tasks (#202) only while config.json turns them on: off, the page sees none.
    const todos = todosConfig(cfg.todos)
    const list = items.map(({ transcript, claudeRoot, alive, since, pipe, apiError, todos: own, ...rest }) =>
      launches.decorate(todos && own ? { ...rest, todos: own } : rest),
    )
    // Another device's cards carry their tasks only while this board's config turns them on, as its own.
    const theirs = others?.items.map(({ todos: own, ...rest }) => (todos && own ? { ...rest, todos: own } : rest))
    // A call agent started for a node's session (#618) has call.parent naming that node card: inherit
    // its parent's lane/workspace/title when unset and sit right beside the parent card.
    const combined = (() => {
      if (!theirs) return list
      const remoteByKey = new Map(theirs.map(i => [i.key, i]))
      let hasNodeCallParent = false
      const adjusted = list.map(it => {
        const parentKey = it.call?.parent
        const parent = parentKey ? remoteByKey.get(parentKey) : undefined
        if (!parent) return it
        hasNodeCallParent = true
        return {
          ...it,
          name: it.name === t('call.alone') ? t('call.of', { name: parent.name }) : it.name,
          category: !it.categorySet ? parent.category : it.category,
          workspace: it.workspace || parent.workspace,
        }
      })
      const merged = [...adjusted, ...theirs]
      return hasNodeCallParent ? besideParents(merged) : merged
    })()
    // The schedule without the scheduler's bookkeeping; the log is what was sent or missed lately.
    const schedules = listEntries().map(({ claim, tried, waited, ...entry }) => entry)
    // Watches (#486): while config.json turns them on; off, the ones still set, marked as not checked (#596).
    schedules.push(...watchesFor())
    // The usage the pill shows: the board's own profile's (the default one's when its env points to
    // none), as before profiles.
    const profiles = boardProfiles(deps, items)
    const own = profiles.find(p => p.inherited) ?? profiles.find(p => p.id === DEFAULT_PROFILE)
    // Antigravity (Gemini) usage (#647): omitted when agy is not installed locally or on any active remote node.
    const localAgy = readAgyLimits ? readAgyLimits() : localAgyLimits(cfg.launch)
    const remoteAgy = others?.devices.filter(d => d.id !== LOCAL && !d.revoked).map(d => d.status?.agyLimits) ?? []
    const agyLimits = pickAgyLimits([localAgy, ...remoteAgy])
    return {
      // archive: what became of the latest sessions put in it (the page's toasts).
      archive: { log: readArchiveLog(8) },
      version: version(),
      lang: lang(),
      language: cfg.language ?? 'auto',
      languages: LANGUAGES,
      fsToken: FILE_TOKEN,
      stale,
      limits: own?.limits ?? null,
      ...(agyLimits !== undefined && { agyLimits }),
      items: combined,
      launches: others ? [...launches.list(), ...others.launches] : launches.list(),
      categories,
      swatches: SWATCHES,
      columns: COLUMNS.map(({ id, title }) => ({ id, title })),
      schedules: others ? [...schedules, ...others.schedules] : schedules,
      scheduleLog: readLog(20),
      // terminal: whether the board offers one (config `terminal`); shells: sessions it opened one for.
      terminal: terminalOn(cfg),
      shells: terminalOn(cfg) ? (terminals?.keys() ?? []) : [],
      // mokupilot: whether a session's sheet offers a MokuPilot call with a fork of it.
      mokupilot: mokupilot?.() ?? false,
      // fork: whether the board can fork a session into a new tab with its launcher.
      fork: canFork(cfg),
      // aside: whether a session's sheet offers a side question (/btw typed into the session).
      aside: aside?.() ?? false,
      setup: setup?.() ?? null,
      // wake: only once it ships, while it is on, or while its file has sleepers (dormant otherwise).
      ...wakeOf(wake),
      profiles,
      // What a profile without a start command types: the Profiles panel's placeholder.
      claudeProgram: claudeProgram(cfg.launch?.claude, cfg.launch?.args),
      foldWaiting: foldModeOf(cfg.foldWaiting),
      // Auto-compact's default (#378), '' for off: Settings shows it checked.
      compactDefault: compactDefaultText(cfg.compact),
      // remote: only while the remote mode is on; a board without it sends none.
      ...remoteOf(remote),
      // presence: only while config.json turns it on (#172).
      ...presenceOf(presence),
      ...(todos && { todos }),
      // backup: only once there is a database or a backup target (#233)
      ...backupOf(backup),
      // time: only while config.json turns it on (#233)
      ...timeOf(time),
      // calendar: only while config.json turns it on (#328)
      ...calendarOf(calendar),
      // watches: only while config.json turns them on, for Settings' switch (#596)
      ...(watchesConfig(cfg.watches) && { watches: true as const }),
      // threads: only while config.json turns them on (#379)
      ...threadsOf(threads),
      // journal: only while config.json turns it on (#489)
      ...journalOf(journal),
      // decisions: only while config.json turns them on (#487)
      ...decisionsOf(decisions, items),
      ...(workdeskLine && { workdesk: workdeskLine }),
      ...(dialogLine && { workdeskDialog: dialogLine }),
      // accessRev: the panel's cue to fetch the Remote access view again (never the view itself).
      accessRev: accessRev?.() ?? 0,
      // teamRev: only while config.json turns the peer network on (#231).
      ...teamRevOf(teamRev),
      // teamUnread: likewise, the head's count of unread team messages (#355).
      ...teamUnreadOf(teamUnread),
      // teamWaiting: only while something asked from away waits for the passkey here (#377).
      ...teamWaitingOf(teamWaiting),
      // omarchy: only on a computer with Omarchy, the theme the Terminal style follows.
      ...omarchyOf(omarchy),
      // devices: only while config.json makes this board a master (#500).
      ...(others && { devices: others.devices }),
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
  // (adapters/links.ts); a read that found something new refreshes the board, and its events go
  // into the edge log after it, with the sessions the board has then (adapters/edge-log.ts).
  const edgeLog = createEdgeLog()
  const links = createLinks({ onChange: () => void refresh(), onEvents: edgeLog.add })
  function logEdges(): void {
    try {
      edgeLog.flush(items)
    } catch (err) {
      log(`edge log: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

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

  // A session on another model than config.json's `models` expects (#429) gets a herdr notification
  // once per start (its key and the time its Claude process started): a restart or a wake that
  // brings it back on that model says so again, a later turn does not. Only a running one: a
  // sleeper's tag says what it last ran. Without the rule no item has modelWrong, and nothing goes.
  const modelWarned = new Set<string>()
  async function warnWrongModels(): Promise<void> {
    const startOf = (i: Item): string => `${i.key}\n${i.since ?? ''}`
    const wrong = items.filter(i => i.modelWrong && i.alive && !modelWarned.has(startOf(i)))
    await Promise.all(
      wrong.map(async item => {
        modelWarned.add(startOf(item))
        const vars = {
          name: item.name,
          got: item.modelWrong?.runs ?? '',
          want: familyTitle(item.modelWrong?.want ?? ''),
        }
        try {
          await notify(t('model.wrongTitle', vars), t('model.wrongBody', vars))
        } catch (err) {
          log(`wrong model notification: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    )
  }

  let refreshing = false
  let again = false
  // Who awaits a refresh asked for while one runs: it resolves once the run after it is done, so
  // `await refresh()` always means a collect that started after the call.
  let waiting: (() => void)[] = []
  async function refresh(): Promise<void> {
    if (refreshing) {
      again = true
      return new Promise(resolve => waiting.push(resolve))
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
      items = await collect(deps, { helpers: true, links, seen, ...(observeSessions && { observed: observeSessions }) })
      logEdges()
      launches.observe(items)
      journal?.observe(items)
      stale = false
      lastSuccessfulRefreshAt = Date.now()
      publish()
      await warnWrongProfiles()
      await warnWrongModels()
    } catch (err) {
      stale = true
      observeFailure?.()
      publish()
      log(`refresh: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      refreshing = false
    }
    if (again) {
      again = false
      const done = waiting
      waiting = []
      const release = (): void => {
        for (const resolve of done) resolve()
      }
      void refresh().then(release, release)
    }
  }

  const isStale = () =>
    stale ||
    !lastSuccessfulRefreshAt ||
    Date.now() - lastSuccessfulRefreshAt > Math.max(10000, (cfg.refreshSec ?? 2) * 3000)
  return {
    payload: () => payload,
    items: () => items,
    observation: () => (lastSuccessfulRefreshAt && !isStale() ? { items, observedAt: lastSuccessfulRefreshAt } : null),
    find: key => items.find(i => i.key === key),
    findAny: key => items.find(i => i.key === key) ?? (parseNodeKey(key) ? nodes?.()?.find(key) : undefined),
    stale: isStale,
    publish,
    refresh,
    edges: (since, limit) => edgeLog.read(since, limit),
  }
}
