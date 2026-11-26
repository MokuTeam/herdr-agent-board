// The launches of this board process: new sessions started from the web board. A launch runs in
// the background (run.ts) and is reported in the board payload (`launches`), so the page shows a
// starting card at once and a clear reason when it fails. This keeps them: starting one, linking
// it to the session it started, the card's buttons (dismiss, go to it, trust, close its tab) and
// what the new-session window offers, the agents a start may pick among it (core/launch/agents.ts).
import { hostname } from 'node:os'
import { readCard, removeCard, writeCard } from '../../adapters/cards.ts'
import { cachedCodexModels } from '../../adapters/codex-home.ts'
import { herdr, paneTab, paneTabTerminal, workspaceList } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { findCommand } from '../../adapters/setup-facts.ts'
import { isAgyItem } from '../../core/agy.ts'
import { CODEX_AGENT, isCodexSession } from '../../core/codex.ts'
import { t } from '../../core/lang.ts'
import {
  CLAUDE_AGENT,
  defaultAgent,
  type LaunchAgent,
  type LaunchAgentId,
  launchAgents,
} from '../../core/launch/agents.ts'
import { failureKind } from '../../core/launch/launcher-command.ts'
import { sameDir } from '../../core/launch/names.ts'
import { refusalText } from '../../core/launch/place-text.ts'
import type { NodeFolderFacts } from '../../core/launch/spawn-node.ts'
import { forkCard } from '../../core/links.ts'
import { nodesConfig } from '../../core/nodes.ts'
import { isPiItem, piSessionId } from '../../core/pi.ts'
import { shownProfiles } from '../../core/profiles.ts'
import type { Item, LaunchView } from '../../core/types.ts'
import { raiseTerminal } from '../../integrations/terminal-window.ts'
import type { Deps } from '../deps.ts'
import { herdrCannotResume, LaunchError, type LauncherInfo, launcherFor, removeLeftoverMessages } from './launcher.ts'
import { checkRequest, type ParentFacts } from './request.ts'
import { type Launch, launchRunner, newLaunch } from './run.ts'

export interface LaunchOptions {
  launcher: LauncherInfo
  /** The agents a start may name (its `agent`), the default first; none when the config's launcher picks it. */
  agents: LaunchAgent[]
  codexModels?: Record<string, string[]>
  /** The one a start that names none starts as: `launch.default` when offered, else Claude Code. */
  agent: LaunchAgentId
  workspaces: { id: string; label: string | undefined }[]
  focused: string
  board: string
  recent: string[]
  /** The setup's ticket conventions: linked workspaces, -wt/<ticket> paths, case- names. */
  linkedWorkspaces: boolean
  /** The launcher can start a session on a model of its own: the window offers the field. */
  takesModel: boolean
  error: string
}

export type LaunchActionResult = { ok: true } | { ok: false; error: string }
/** `session`: the session id a start the placer took will have (#505), so spawn-agent can find it on a node. */
export type StartResult = { ok: true; id: string; session?: string } | { ok: false; field: string; error: string }

/**
 * A start the server makes, never the page: `resume`, the id of a session to bring back from the
 * archive (services/archive.ts), resumed with no first message; `fork`, the id of a session whose
 * conversation a new one starts with (services/launch/fork.ts); `parent`, the card whose profile it
 * keeps when that card is not on the board (checkRequest).
 */
export interface StartOptions {
  codexFork?: true
  resume?: string | null
  fork?: string | null
  parent?: ParentFacts | null
  /**
   * A node's start from its master (#504, services/node/launch.ts): the session id the master picked,
   * which is the launch's id too, and a lane the master checked (this board may not have it yet).
   */
  node?: { session: string; exactSession?: boolean } | null
  /** A person asked for it (the New session window); false for an agent's start (T9). The placer reads it. */
  byHand?: boolean
  /** The Claude session id the board chose (a verifier, #492): Claude Code under that id here, or no start. */
  sessionId?: string | null
  /** A verifier's start on a worker's node (#675): placed there with that node's own folder and profile. */
  remote?: string | null
  /**
   * spawn-agent on a node (#760, services/nodes/spawn-from.ts): the folder is that node's, as its
   * facts say, and the placer applies the rule of core/portable.ts to them. `nodeProfile`: the
   * request's profile is the node's own id, which this board does not have.
   */
  origin?: { device: string; facts: NodeFolderFacts; nodeProfile?: boolean } | null
  /**
   * spawn-agent --trust (#798): from a node's session (spawn-from.ts), or a master's start for this
   * node (services/node/launch.ts). The board answers the folder-trust dialog for the launch's folder.
   */
  trust?: boolean
}

/** How a launch went, for a start of the server's own that waits on it (a verifier, #492); null once it is gone. */
export interface LaunchState {
  state: Launch['state']
  error: string
  sessionId: string | null
}

/**
 * The placer (#504, services/nodes/placer.ts), there only while config.json has `nodes`: a new
 * start goes to it between the request's check and the run, and it starts it here (runLocal), on
 * a node, or keeps it in its queue.
 */
export interface LaunchPlacer {
  /** A checked new start, already among the launches: placed now, sent to a node, or queued. */
  take(l: Launch, byHand: boolean): void
  /** A queued start is cancelled: out of the queue and its file. */
  cancel(id: string): void
  /** Whether the node a start went to shows it now (its launch or its session): its card is the node's then. */
  shown(l: Launch): boolean
  /** The board was refreshed: a session of this computer may have gone to sleep. */
  observe(items: Item[]): void
}

export interface Launches {
  /** `items`: the board now, for the lanes it has and the panes that are not this launch's. */
  start(body: unknown, items?: Item[], options?: StartOptions): Promise<StartResult>
  /** After each refresh: links launches to the sessions they started and gives those their lane. */
  observe(items: Item[]): void
  /** An item a launch started: in the chosen lane until its card says so too, and how the launch goes. */
  decorate(item: Item): Item
  dismiss(id: string): LaunchActionResult
  focus(id: string): Promise<LaunchActionResult>
  trust(id: string): Promise<LaunchActionResult>
  closeTab(id: string): Promise<LaunchActionResult>
  options(): Promise<LaunchOptions>
  list(): LaunchView[]
  /** The placer's (#504): a start it took or read back from its queue, run here as any other. */
  runLocal(l: Launch): void
  /** The placer's (#504): a queued start read back from the queue's file after a restart, shown again. */
  adopt(l: Launch): void
  /** The placer's (#504): its launch changed; the board publishes again. */
  changed(): void
  /** A launch's state by its id, dismissed or not. */
  state(id: string): LaunchState | null
  /** A launch's state by its chosen `sessionGiven` (#675), for queued or adopted starts. */
  sessionState?(session: string): LaunchState | null
  /** Cancel a queued start of the placer's by id or `sessionGiven` (#675); false when none is queued. */
  cancelQueued?(id: string, session?: string): boolean
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const errorText = (err: unknown): string =>
  (isRecord(err) && typeof err.message === 'string' && err.message) || String(err)
const codeOf = (err: unknown): string | undefined =>
  isRecord(err) && typeof err.code === 'string' ? err.code : undefined

// A card with nothing else on it was only the launch's: the board wrote the lane and the profile
// it is meant to run in, the hooks the profile it reports.
const LANE_ONLY = [
  'key',
  'category',
  'updatedAt',
  'profileWant',
  'modelWant',
  'profile',
  'profileDir',
  'forkOf',
  'forkAt',
  'parent',
]
const laneOnly = (key: string): boolean => Object.keys(readCard(key) ?? {}).every(k => LANE_ONLY.includes(k))

// What a retry starts from: a worktree or a workspace this launch made already is used, not
// made again (git would refuse the branch; herdr would get a second, empty workspace).
const view = (l: Launch): LaunchView => ({
  id: l.id,
  resume: l.resume,
  fork: l.fork,
  name: l.name,
  cwd: l.cwd,
  category: l.category,
  workspace: l.workspaceLabel,
  workspaceId: l.workspaceId || null,
  state: l.state,
  step: l.step,
  error: l.error,
  kind: l.kind,
  pane: l.pane,
  key: l.key,
  startedAt: l.startedAt,
  doneAt: l.doneAt,
  message: l.message,
  worktree: l.worktreeMade ? null : l.worktree,
  newWorkspace: l.newWorkspace && !l.workspaceId,
  profile: l.profile,
  parent: l.parent,
  agent: l.agent,
  model: l.model,
  ...(l.place && { place: l.place }),
})

/** Whether `pi` is a command on the board's PATH (a .ps1 or .cmd on Windows too). */
export function piOnPath(): boolean {
  const found = findCommand('pi')
  return !!(found.ps ?? found.sh)
}

/** Whether `agy` is a command on the board's PATH (a .ps1 or .cmd on Windows too). */
export function agyOnPath(): boolean {
  const found = findCommand('agy')
  return !!(found.ps ?? found.sh)
}

/** Whether `codex` is a command on the board's PATH (a .ps1 or .cmd on Windows too). */
export function codexOnPath(): boolean {
  const found = findCommand('codex')
  return !!(found.ps ?? found.sh)
}

/** The launches of this board process; `onChange` publishes the board again. */
export function createLaunches({
  deps,
  onChange = () => {},
  placer = () => null,
  frozen = () => false,
}: {
  deps: Deps
  onChange?: () => void
  /** The placer while config.json has `nodes` (#504), else null. */
  placer?: () => LaunchPlacer | null
  /** True while a master handover freeze is active (#697). */
  frozen?: () => boolean
}): Launches {
  const launches = new Map<string, Launch>()
  removeLeftoverMessages()
  const changed = (): void => onChange()
  const runner = launchRunner({
    deps,
    step: (l, name) => {
      l.step = name
      changed()
    },
  })

  async function start(
    body: unknown,
    items: Item[] = [],
    {
      resume = null,
      fork = null,
      parent = null,
      node = null,
      byHand = true,
      sessionId = null,
      remote = null,
      codexFork,
      origin = null,
      trust = false,
    }: StartOptions = {},
  ): Promise<StartResult> {
    if (frozen()) {
      return { ok: false, field: 'launcher', error: 'Master handover is in progress; new session starts are paused.' }
    }
    const categories = new Set([...deps.cfg.categories.map(c => c.id), ...items.map(i => i.category)])
    // Resume, fork, a node's own start from its master and a local verifier (#492) are never placed:
    // they run where they are, a local verifier in the worker's folder on this computer. A node
    // verifier (#675, `remote` set) goes through the placer, pinned to its worker's node.
    const placing = resume || fork || node || (sessionId && !remote) ? null : placer()
    if (remote && !placing) return { ok: false, field: 'pin', error: t('place.refuse.no-device', { pin: remote }) }
    if (origin && !placing)
      return { ok: false, field: 'pin', error: t('place.refuse.no-device', { pin: origin.device }) }
    // Only the board's own spawn-agent types a profile's start command: the others never read it.
    const launcher = launcherFor(deps.cfg.launch, { resume: !!resume, fork: !!fork, ...(codexFork && { codexFork }) })
    const r = await checkRequest(body, {
      // A node's start runs in its master's lane, which the bundle (T10) may not have brought yet.
      categories: node ? null : categories,
      ...(codexFork ? { codexFork } : { profiles: deps.profiles() }),
      items,
      typesCommand: launcher.kind === 'builtin',
      ...(parent && { parent }),
      // A start of the server's own (a fork, a verifier) picks no agent: Claude Code's.
      // A resume from the archive may be Claude or Antigravity (never defaulted to agy/pi).
      agents: () =>
        fork || sessionId || node?.exactSession
          ? []
          : resume
            ? launchAgents(
                deps.cfg.launch,
                () => false,
                agyOnPath,
                isRecord(body) && body.agent === CODEX_AGENT ? codexOnPath : undefined,
              )
            : launchAgents(deps.cfg.launch, piOnPath, agyOnPath, codexOnPath),
      standard: offered => (resume ? CLAUDE_AGENT : defaultAgent(deps.cfg.launch, offered)),
      pi: deps.cfg.launch?.pi,
      agy: deps.cfg.launch?.agy,
      // "Where" and a node's folder are read only while the board places (#504).
      ...(placing && { pins: true }),
      ...(placing && remote && { remote, nodeProfile: true }),
      ...(placing &&
        origin && { remote: origin.device, anyPin: true, ...(origin.nodeProfile && { nodeProfile: true }) }),
    })
    if (!r.ok) return r
    // launch.agent whose arguments pick the session cannot resume one: refused before anything runs.
    if (
      resume &&
      r.launch.agent !== CODEX_AGENT &&
      launcher.kind === 'herdr' &&
      herdrCannotResume(deps.cfg.launch ?? {}, r.launch.profileArgs)
    )
      return { ok: false, field: 'launcher', error: t('archive.err.cannotResume') }
    if (
      fork &&
      !codexFork &&
      launcher.kind === 'herdr' &&
      herdrCannotResume(deps.cfg.launch ?? {}, r.launch.profileArgs)
    )
      return { ok: false, field: 'launcher', error: t('fork.err.launcher') }
    // A model it cannot pass on is refused, not left out: the session would run on another one.
    // A new Codex session starts through herdr's launcher whatever the config's (run.ts).
    const starts =
      r.launch.agent === CODEX_AGENT && !codexFork ? launcherFor(deps.cfg.launch, { codex: true }) : launcher
    if (r.launch.model && !starts.takesModel) return { ok: false, field: 'model', error: t('launch.err.modelLauncher') }
    // A resumed session keeps its conversation: no first message goes into it. A fork starts with
    // a copy of its source's in the source's folder: no worktree.
    const request = resume ? { ...r.launch, message: '' } : fork ? { ...r.launch, worktree: null } : r.launch
    const l = newLaunch(request, items, resume, fork)
    if (origin) l.originFacts = origin.facts
    if (trust && !resume && !fork) l.trust = true
    if (node) {
      l.id = node.session
      l.sessionGiven = node.session
      if (node.exactSession) l.exactSession = true
    }
    if (sessionId) {
      l.sessionGiven = sessionId
      l.exactSession = true
    }
    launches.set(l.id, l)
    if (placing) placing.take(l, byHand)
    else runLocal(l)
    changed()
    return { ok: true, id: l.id, ...(placing && l.sessionGiven && { session: l.sessionGiven }) }
  }

  /** Runs a launch here: its state and failure for its card. */
  function runLocal(l: Launch): void {
    runner
      .run(l)
      .then(() => {
        l.state = 'done'
        l.doneAt = Date.now()
      })
      .catch((err: unknown) => {
        // Waved off, or its tab closed: nothing to show.
        if (l.dismissed || l.closed) {
          launches.delete(l.id)
          return
        }
        l.state = 'failed'
        l.error = errorText(err)
        l.kind = err instanceof LaunchError ? err.kind : failureKind(l.error, codeOf(err))
        deps.log(`launch ${l.name}: ${l.error}`)
      })
      .finally(changed)
  }

  /** "Trust and continue" on a launch's card (run.ts moves the cursor). */
  async function trust(id: string): Promise<LaunchActionResult> {
    const l = launches.get(id)
    if (l?.state !== 'trust') return { ok: false, error: t('launch.err.gone') }
    return runner.answerTrust(l)
  }

  /**
   * "Close the tab": the launch's tab goes, and the launch with it (and a card nothing but the lane
   * was written to: the board's own fields, and the profile the hooks reported).
   */
  async function closeTab(id: string): Promise<LaunchActionResult> {
    const l = launches.get(id)
    if (!l?.pane || (l.state !== 'trust' && l.state !== 'waiting')) return { ok: false, error: t('launch.err.gone') }
    try {
      // A pane that holds another terminal than the one the board opened is not the launch's: herdr
      // gave its id out again after it started over, and the launch's own tab is gone already.
      const { tab, terminal } = await paneTabTerminal(l.pane)
      const reused = !!l.terminal && !!terminal && terminal !== l.terminal
      if (tab && !reused) await herdr(['tab', 'close', tab])
    } catch (err) {
      return { ok: false, error: t('err.focus', { name: l.name, why: messageOf(err) }) }
    }
    l.closed = true
    // A resumed session's card is its own from before: it stays.
    if (l.sessionId && !l.resume && laneOnly(l.sessionId)) removeCard(l.sessionId)
    launches.delete(id)
    changed()
    return { ok: true }
  }

  function observe(items: Item[]): void {
    const claimed = new Set<string>()
    // A pi session started with the board's id is keyed by its file, whose name holds that id.
    const started = (i: Item, id: string): boolean => i.session === id || (isPiItem(i) && piSessionId(i.session) === id)
    for (const l of launches.values()) {
      const id = l.sessionId
      let it =
        (id ? items.find(i => started(i, id)) : undefined) ?? (l.pane ? items.find(i => i.pane === l.pane) : undefined)
      // A launcher that says its pane only at the end: while it runs, a new agent pane in that
      // folder and workspace is taken for it, and the pane it prints settles it. herdr's own path
      // and launchers given {sessionId} need no guess: they are matched by the session id.
      const guess = !it && !l.pane && !l.sessionId && l.step === 'command' && l.state === 'starting' && l.workspaceLabel
      if (guess) {
        it = items.find(
          i =>
            !l.knownPanes.has(i.pane) &&
            i.workspace === l.workspaceLabel &&
            sameDir(i.cwd, l.cwd) &&
            !claimed.has(i.key) &&
            ![...launches.values()].some(o => o !== l && o.key === i.key),
        )
      }
      if (!it) continue
      if (
        (l.codexFork || (l.agent === CODEX_AGENT && l.resume)) &&
        (it.agent !== 'codex' ||
          !(l.sessionId || l.resume) ||
          !isCodexSession(it.session ?? '') ||
          it.session?.toLowerCase() !== (l.sessionId || l.resume)?.toLowerCase())
      )
        continue
      claimed.add(it.key)
      l.key = it.key
      l.pane ??= it.pane
      // Its card gets the lane under the key it has now. A Claude pane is keyed by its session id
      // in a moment, so only other agents get a card by their pane.
      if (l.carded !== it.key && (it.session || it.agent !== 'claude')) {
        try {
          writeCard(it.key, {
            category: l.category,
            // Codex has no Claude profile: a fork keeps its name and source, a new one its model.
            ...(l.codexFork
              ? { name: l.name, ...(l.fork && forkCard(l.fork)) }
              : l.agent === CODEX_AGENT
                ? {}
                : { profileWant: l.profile }),
            ...(l.model && { modelWant: l.model }),
            ...(l.parent && !l.fork && !l.resume && { parent: l.parent }),
          })
          // pi's card is under its file and agy's under its conversation id: the start card goes once moved.
          if ((isPiItem(it) || isAgyItem(it)) && l.carded && laneOnly(l.carded)) removeCard(l.carded)
          l.carded = it.key
        } catch {}
      }
    }
    // Started ones go once their card is on the board; failed ones stay until dismissed (or 30 min).
    // One a master sent to a node goes once the node shows it (#504).
    const now = Date.now()
    let gone = false
    const placing = placer()
    for (const [id, l] of launches) {
      const age = now - (l.doneAt ?? now)
      const there = !!l.place?.device && !!placing?.shown(l)
      const done =
        l.state === 'done' && ((!!l.key && !!l.carded && age > 8000) || age > 120_000 || l.dismissed || there)
      if (done || (l.state === 'failed' && now - l.startedAt > 30 * 60_000)) {
        launches.delete(id)
        gone = true
      }
    }
    if (gone) changed()
    placing?.observe(items)
  }

  function decorate(item: Item): Item {
    const l = [...launches.values()].find(x => x.key === item.key)
    if (!l) return item
    const starting = l.state !== 'done' && !l.dismissed
    // Until /rename went through, herdr knows it by its terminal's title ("claude"): the card shows the name it was started with.
    const name = starting && item.name === item.autoName ? l.name : item.name
    return { ...item, name, category: item.categorySet ? item.category : l.category, launch: starting ? view(l) : null }
  }

  /**
   * Take a launch off the board. A failed one goes; one still running only stops showing: it
   * goes on, and its session still gets its lane (a dialog it waits on is given up on).
   */
  function dismiss(id: string): LaunchActionResult {
    const l = launches.get(id)
    if (!l) return { ok: false, error: t('launch.err.gone') }
    l.dismissed = true
    // A queued start of the placer's (#504) is cancelled: out of its queue, and off the board.
    if (l.state === 'queued') placer()?.cancel(id)
    if (l.state === 'failed' || l.state === 'done' || l.state === 'queued') launches.delete(id)
    changed()
    return { ok: true }
  }

  /** Go to a launch's tab in herdr (it may be no agent yet: a shell, or one waiting for a dialog). */
  async function focusLaunch(id: string): Promise<LaunchActionResult> {
    const l = launches.get(id)
    if (!l?.pane) return { ok: false, error: t('launch.err.gone') }
    try {
      const tab = await paneTab(l.pane)
      if (!tab) throw new Error(t('launch.err.paneGone'))
      await herdr(['tab', 'focus', tab])
    } catch (err) {
      return { ok: false, error: t('err.focus', { name: l.name, why: messageOf(err) }) }
    }
    if (deps.cfg.raiseTerminal !== false) raiseTerminal(deps.cfg)
    return { ok: true }
  }

  /** What the window needs: the launcher, herdr's workspaces, recent folders. */
  async function options(): Promise<LaunchOptions> {
    let workspaces: LaunchOptions['workspaces'] = []
    let focused = ''
    let error = ''
    try {
      const list = await workspaceList(8000)
      workspaces = list.map(w => ({ id: w.id, label: w.label }))
      focused = list.find(w => w.focused)?.id ?? ''
    } catch (err) {
      error = messageOf(err)
    }
    const cfg = deps.cfg
    const agents = launchAgents(cfg.launch, piOnPath, agyOnPath, codexOnPath)
    const launcher = launcherFor(cfg.launch)
    return {
      launcher: launcher.describe(),
      agents,
      ...(agents.some(agent => agent.id === CODEX_AGENT) && { codexModels: await cachedCodexModels() }),
      agent: defaultAgent(cfg.launch, () => agents),
      workspaces,
      focused,
      board: (cfg.placement ?? 'workspace') === 'workspace' ? (cfg.workspace ?? 'Board') : '',
      // Of the profiles the owner shows: a hidden one's folders are not offered.
      recent: await deps.homes.recentFolders(shownProfiles(deps.profiles().list).map(p => p.dir)),
      linkedWorkspaces: cfg.launch?.linkedWorkspaces === true,
      takesModel: launcher.takesModel,
      error,
    }
  }

  return {
    start,
    observe,
    decorate,
    dismiss,
    focus: focusLaunch,
    trust,
    closeTab,
    options,
    // A start a master sent to a node shows as the node's own launch once the node has it: one card, not two.
    list: () => [...launches.values()].filter(l => !l.dismissed && !(l.place?.device && placer()?.shown(l))).map(view),
    runLocal,
    adopt(l) {
      launches.set(l.id, l)
      changed()
    },
    changed,
    state: id => {
      const l = launches.get(id)
      return l ? stateOf(l) : null
    },
    sessionState: session => {
      const l = [...launches.values()].find(x => x.sessionGiven === session)
      return l ? stateOf(l) : null
    },
    cancelQueued: (id, session) => {
      const l =
        (id ? launches.get(id) : undefined) ??
        (session ? [...launches.values()].find(x => x.sessionGiven === session) : undefined)
      if (l?.state !== 'queued') return false
      dismiss(l.id)
      return true
    },
  }
  function stateOf(l: Launch): LaunchState {
    let error = l.error
    if (l.state === 'failed' && !error) {
      if (l.place?.refuse) {
        const cfg = nodesConfig(deps.cfg.nodes, hostname())
        const titles = cfg
          ? Object.fromEntries(Object.entries(cfg.devices).map(([dev, d]) => [dev, d.title]))
          : undefined
        error = refusalText(l.place.refuse, t, titles)
      } else if (l.place?.queueFull) error = t('place.queueFull')
    }
    return { state: l.state, error, sessionId: l.sessionId }
  }
}
