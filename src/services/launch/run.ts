// One launch, from a checked request to a session that waits for input: a worktree and a
// workspace first when asked, the launcher (launcher.ts), Claude's folder-trust dialog held on
// the card until it is answered, another dialog waited out, and the name and first message the
// launcher did not type. The card gets the chosen lane as soon as the session has an id, and the
// profile it is meant to run in, for the board to check against the one its hooks report.
//
// A session coming back from the archive (services/archive.ts) starts the same way, resumed by its
// id (`--resume <id>` instead of --session-id; `{resume}` for a launch.command, which without it
// leaves the resume to the board's own spawn-agent), with no /rename and no first message: it
// keeps its name, its card and its conversation. A fork (services/launch/fork.ts) is a new session
// that starts with a copy of another one's conversation: named and briefed as any new one.
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { writeCard } from '../../adapters/cards.ts'
import { SLOW, statOf, within } from '../../adapters/folders.ts'
import { gitInfo, repoRoot } from '../../adapters/git.ts'
import {
  agentGet,
  type HerdrAgent,
  type HerdrWorktree,
  herdr,
  herdrText,
  tabCreateRoot,
  workspaceCreate,
  workspacePanes,
  worktreeCreate,
  worktreeOpen,
} from '../../adapters/herdr.ts'
import { run } from '../../adapters/process.ts'
import { keyTowardYes, sameFolder, type TrustDialog, trustDialog } from '../../core/dialogs/trust.ts'
import { t } from '../../core/lang.ts'
import { launcherError } from '../../core/launch/launcher-command.ts'
import {
  baseName,
  sameDir,
  slugName,
  ticketOf,
  ticketSlugName,
  uniqueSlug,
  worktreePath,
} from '../../core/launch/names.ts'
import { forkCard } from '../../core/links.ts'
import { PI_AGENT } from '../../core/pi.ts'
import type { Item, LaunchFailure, LaunchState, LaunchStep } from '../../core/types.ts'
import type { Deps } from '../deps.ts'
import { LaunchError, type LaunchEvents, launcherFor, notePane, openInProfile } from './launcher.ts'
import { claudeRename, inputEmpty, piName, takenNames, typeLine } from './prompt.ts'
import type { LaunchRequest } from './request.ts'

/** A launch as the board keeps it while it runs. */
export interface Launch extends LaunchRequest {
  id: string
  /** The id of the session it resumes (Return, from the archive), null for a new one. */
  resume: string | null
  /** The id of the session whose conversation it starts with (a fork), null for none. */
  fork: string | null
  state: LaunchState
  step: LaunchStep
  startedAt: number
  doneAt: number | null
  /** The panes on the board when it started: one matched to it while its launcher runs is new. */
  knownPanes: Set<string | null>
  pane: string | null
  key: string | null
  error: string
  kind: LaunchFailure | ''
  sessionId: string | null
  /** The key whose card has its lane. */
  carded: string | null
  rootPane: string | null
  rootTab: string | null
  /** A tab the worktree came with, left over once the profile's own tab was opened. */
  spareTab: string | null
  /** The setup's ticket convention: case- names, -wt/<ticket> paths, linked workspaces. */
  ticketNames: boolean
  worktreeMade: boolean
  dismissed: boolean
  closed: boolean
  trusting: boolean
}

/**
 * A new launch for a checked request; `items`: the board as it is now; `resume`: the session it
 * resumes; `fork`: the session whose conversation it starts with.
 */
export function newLaunch(
  request: LaunchRequest,
  items: Item[],
  resume: string | null = null,
  fork: string | null = null,
): Launch {
  return {
    ...request,
    id: randomUUID().slice(0, 8),
    resume,
    fork,
    state: 'starting',
    step: 'prepare',
    startedAt: Date.now(),
    doneAt: null,
    knownPanes: new Set(items.map(i => i.pane)),
    pane: null,
    key: null,
    error: '',
    kind: '',
    sessionId: null,
    carded: null,
    rootPane: null,
    rootTab: null,
    spareTab: null,
    ticketNames: false,
    worktreeMade: false,
    dismissed: false,
    closed: false,
    trusting: false,
  }
}

export type TrustAnswer = { ok: true } | { ok: false; error: string }

export interface LaunchRunner {
  /** Run a launch to a session waiting for input; rejects with why it failed. */
  run(l: Launch): Promise<void>
  /** "Trust and continue" for a launch held at the folder-trust dialog. */
  answerTrust(l: Launch): Promise<TrustAnswer>
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const ready = (agent: HerdrAgent | null): boolean => agent?.status === 'idle' || agent?.status === 'done'

/**
 * Where `cwd` is below the checkout `root`, compared as real paths: '' when it is not below it.
 * Git gives the canonical root (/private/tmp on macOS) where the picker may have used an alias.
 * Bounded too: a network share may disappear after the request was checked.
 */
export async function worktreeSubdir(
  root: string,
  cwd: string,
  {
    canonicalize = realpath,
    timeoutMs = 2000,
  }: { canonicalize?: (path: string) => Promise<string>; timeoutMs?: number } = {},
): Promise<string> {
  const paths = await within(
    Promise.all([canonicalize(root), canonicalize(cwd)]).catch(() => null),
    timeoutMs,
  )
  if (paths === SLOW) throw new LaunchError(t('launch.err.cwdSlow', { path: cwd }), 'worktree')
  if (!paths) throw new LaunchError(t('launch.err.cwdMissing', { path: cwd }), 'worktree')
  const below = relative(paths[0], paths[1])
  return below !== '..' && !below.startsWith(`..${sep}`) && !isAbsolute(below) ? below : ''
}

/** The launch's pane: past its launcher's start, a launch that needs one has one. */
function paneOf(l: Launch): string {
  if (!l.pane) throw new LaunchError(t('launch.err.paneGone'), 'other')
  return l.pane
}

/** Runs launches; `step` records a launch's step and publishes the board. */
export function launchRunner({
  deps,
  step,
}: {
  deps: Deps
  step: (l: Launch, name: LaunchStep) => void
}): LaunchRunner {
  const events = (l: Launch): LaunchEvents => ({
    step: name => step(l, name),
    pane: pane => {
      l.pane = pane
    },
    session: id => {
      l.sessionId = id
      // A fork's card says whose fork it is, and since when (core/links.ts).
      writeCard(id, { category: l.category, profileWant: l.profile, ...(l.fork && forkCard(l.fork)) })
      l.carded = id
    },
  })

  const agentSlug = (l: Launch): string => (l.ticketNames ? ticketSlugName(l.name) : slugName(l.name))

  async function runLaunch(l: Launch): Promise<void> {
    // A resumed one has its id and its card already; the card is told the profile it is meant to
    // run in, as for any start.
    if (l.resume) {
      l.sessionId = l.resume
      writeCard(l.resume, { profileWant: l.profile })
      l.carded = l.resume
    }
    const linked = deps.cfg.launch?.linkedWorkspaces === true
    l.ticketNames = linked
    if (l.worktree) await makeWorktree(l, l.worktree.branch, linked)
    if (l.newWorkspace) {
      step(l, 'workspace')
      const git = linked ? await gitInfo(l.cwd) : null
      if (git) {
        // A checkout with a repository: its workspace is linked to it, and one per checkout.
        const root = (await repoRoot(git.root)) ?? git.root
        let ws: HerdrWorktree
        try {
          ws = await worktreeOpen(root, git.root, l.workspaceLabel || baseName(git.root) || l.name)
        } catch (err) {
          throw new LaunchError(t('launch.err.worktreeGit', { why: messageOf(err) }), 'worktree')
        }
        l.workspaceId = ws.id
        l.newWorkspace = false
        await openLaunchTab(l, ws, false)
      } else {
        // In the profile's env: what starts in its first tab runs in that profile.
        const ws = await openInProfile(l, env => workspaceCreate(l.cwd, l.workspaceLabel, env))
        l.workspaceId = ws.id
        l.rootPane = ws.pane
        l.rootTab = ws.tab
        if (ws.pane) notePane(l, ws.pane, ws.terminal)
      }
    }
    const launcher = launcherFor(deps.cfg.launch, { resume: !!l.resume, fork: !!l.fork })
    const r = await launcher.start(l, events(l))
    // The agent herdr says came up once a dialog was answered: the board's spawn-agent stops at
    // one before it can say whether its start command started Claude or pi.
    let kind = r.agent
    if (r.dialog && (await trustShown(l, 3))) {
      // Claude asks to trust the folder: the card asks the user, and the board goes on once it is.
      kind = (await holdForTrust(l))?.kind || kind
      // What the launcher did not get to: the names and the first message.
      await finishStart(l, { kind, nameAgent: !r.named })
    } else {
      if (r.failure) throw r.failure
      if (r.dialog) {
        // Another dialog holds it: the user answers it in herdr, the board waits and goes on.
        l.state = 'waiting'
        step(l, 'dialog')
        kind = (await untilReady(l, 15 * 60_000))?.kind || kind
        l.state = 'starting'
      }
      // What the launcher did not get to: herdr's own start named the agent, so /rename and the
      // first message; the board's spawn-agent stopped at a dialog before any of the names.
      if (!r.typed) {
        if (r.named) await nameAndBrief(l, kind)
        else await finishStart(l, { kind, nameAgent: true })
      }
    }
    // A new workspace starts with a tab of shells; a launcher command opened its own tab beside it.
    // A worktree opened with a profile's env leaves its first tab empty: it goes too.
    if (l.spareTab && l.pane) await tidy(l.workspaceId, l.spareTab, l.pane)
    else if (launcher.kind !== 'herdr' && l.rootTab && l.pane && l.pane !== l.rootPane)
      await tidy(l.workspaceId, l.rootTab, l.pane)
    l.spareTab = null
  }

  /**
   * The launch's own tab in a workspace herdr opened: the first one when it leaves the env alone,
   * else a tab of its own with the profile's env (worktree open/create take no --env). A workspace
   * that was already open keeps its first tab: its pane may hold a session already.
   */
  async function openLaunchTab(l: Launch, ws: HerdrWorktree, spareRootTab: boolean): Promise<void> {
    l.rootTab = ws.alreadyOpen ? null : ws.tab
    if (l.configDir === null && !ws.alreadyOpen) {
      l.rootPane = ws.pane
      if (ws.pane) notePane(l, ws.pane, ws.terminal)
      return
    }
    const opened = await openInProfile(l, env => tabCreateRoot(ws.id, l.cwd, l.label, env))
    l.rootPane = opened.pane
    if (spareRootTab && ws.tab && !ws.alreadyOpen) l.spareTab = ws.tab
    notePane(l, opened.pane, opened.terminal)
  }

  async function makeWorktree(l: Launch, branch: string, linked: boolean): Promise<void> {
    step(l, 'worktree')
    const git = await gitInfo(l.cwd)
    if (!git) throw new LaunchError(t('launch.err.notGit', { path: l.cwd }), 'worktree')
    // Git returns a canonical root (e.g. /private/tmp on macOS); the picker may have used an
    // alias. Compare canonical paths before carrying the subfolder over.
    const below = await worktreeSubdir(git.root, l.cwd)
    const root = linked ? ((await repoRoot(git.root)) ?? git.root) : git.root
    const path = worktreePath(root, branch, linked)
    // The session works in the same place below the checkout as the folder that was picked.
    const inside = below ? join(path, below) : path
    // The session's folder once the worktree is there: below it as picked, else its root. Set only
    // then, so a launch that fails before keeps the folder a retry makes the worktree from.
    const into = async (): Promise<void> => {
      const st = await statOf(inside)
      l.cwd = st && st !== SLOW && st.isDirectory() ? inside : path
    }
    if (!linked) {
      // As before: a plain git worktree beside the repo; the workspace is made after it.
      if (await statOf(path)) throw new LaunchError(t('launch.err.worktreeExists', { path }), 'worktree')
      const r = await run('git', ['-C', git.root, 'worktree', 'add', '-b', branch, path], { timeout: 60_000 })
      if (r.code !== 0) {
        const why = launcherError(r.stdout, r.stderr).message || r.error?.message || ''
        throw new LaunchError(t('launch.err.worktreeGit', { why }), 'worktree')
      }
      await into()
      l.worktreeMade = true
      return
    }
    // herdr links the workspace to the repository, and one workspace per checkout: an existing
    // ticket worktree is opened again rather than made twice — only when it is the branch asked
    // for. fix/a and fix-a land in one folder, and must not take each other's branch.
    const existing = !!(await statOf(path))
    if (existing) {
      const at = await gitInfo(path)
      if (!at || !sameDir(at.root, path)) throw new LaunchError(t('launch.err.worktreeExists', { path }), 'worktree')
      if (at.branch !== branch)
        throw new LaunchError(t('launch.err.worktreeBranch', { path, branch, found: at.branch }), 'worktree')
    }
    let ws: HerdrWorktree
    try {
      ws = existing
        ? await worktreeOpen(root, path, ticketOf(branch))
        : await worktreeCreate(root, branch, (await gitInfo(root))?.branch || 'HEAD', path, ticketOf(branch))
    } catch (err) {
      throw new LaunchError(t('launch.err.worktreeGit', { why: messageOf(err) }), 'worktree')
    }
    await into()
    l.worktreeMade = true
    l.workspaceId = ws.id
    l.newWorkspace = false
    await openLaunchTab(l, ws, !existing)
  }

  /** Claude's /rename and the first message, once the agent herdr started waits for input. */
  async function nameAndBrief(l: Launch, kind: string): Promise<void> {
    const pane = paneOf(l)
    // A resumed session keeps the name it had.
    if (kind === 'claude' && !l.resume) {
      step(l, 'rename')
      // The name is cosmetic and Claude runs by now: a herdr error here must not mark the launch
      // failed, or a retry would start a second session.
      await claudeRename(pane, l.name).catch(err => deps.log(`launch ${l.name}: /rename: ${messageOf(err)}`))
    } else if (kind === PI_AGENT && !l.resume) {
      step(l, 'rename')
      await piName(pane, l.name).catch(err => deps.log(`launch ${l.name}: /name: ${messageOf(err)}`))
    }
    if (l.message) {
      step(l, 'message')
      if (!(await typeLine(pane, l.message))) throw new LaunchError(t('launch.err.message.lost'), 'message')
    }
  }

  /** What herdr says of the launch's agent now (null when it cannot say); a pane that is gone ends the launch. */
  async function agentNow(l: Launch): Promise<HerdrAgent | null> {
    const pane = paneOf(l)
    try {
      return await agentGet(pane, 5000)
    } catch (err) {
      if (/not.?found|no such/i.test(messageOf(err))) throw new LaunchError(t('launch.err.paneGone'), 'other')
      return null
    }
  }

  /** Wait until the launch's agent waits for input; what herdr then says of it. */
  async function untilReady(l: Launch, limit: number): Promise<HerdrAgent | null> {
    const deadline = Date.now() + limit
    while (Date.now() < deadline && !l.dismissed && !l.closed) {
      await sleep(1500)
      const agent = await agentNow(l)
      if (ready(agent)) return agent
    }
    throw new LaunchError(t(l.dismissed ? 'launch.err.dismissed' : 'launch.err.dialogTimeout'), 'dialog')
  }

  /** Close the tab a new workspace came with, if no agent runs in it (the session is elsewhere). */
  async function tidy(workspace: string, tab: string, pane: string): Promise<void> {
    try {
      const panes = (await workspacePanes(workspace)).filter(p => p.tab === tab)
      if (panes.length && !panes.some(p => p.agent || p.pane === pane)) await herdr(['tab', 'close', tab])
    } catch {}
  }

  // -------------------------------------------------------------- the folder-trust dialog

  /**
   * The trust dialog the launch's pane ends in, for the launch's own folder; else null. `tries`:
   * right after herdr calls the agent blocked, the dialog may still be drawing.
   */
  async function trustShown(l: Launch, tries = 1): Promise<TrustDialog | null> {
    if (!l.pane) return null
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(700)
      const screen = await herdrText(['pane', 'read', l.pane, '--source', 'visible'], 5000).catch(() => '')
      const d = trustDialog(screen)
      if (d && sameFolder(d.folder, l.cwd, homedir())) return d
    }
    return null
  }

  /**
   * Keep the launch on the board, asking, until the folder is trusted (here or in herdr) or its tab
   * closed; what herdr then says of its agent.
   */
  async function holdForTrust(l: Launch): Promise<HerdrAgent | null> {
    l.state = 'trust'
    l.error = ''
    step(l, 'trust')
    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline && !l.dismissed && !l.closed) {
      await sleep(1500)
      const agent = await agentNow(l)
      if (ready(agent)) {
        l.state = 'starting'
        return agent
      }
      // Trusted, and Claude asks something else (a project's MCP servers, say): that one is
      // answered in herdr, and the card says so instead of "trusting" on and on.
      if (l.state === 'trust' && agent?.status === 'blocked' && !(await trustShown(l))) {
        l.state = 'waiting'
        step(l, 'dialog')
      }
    }
    throw new LaunchError(t(l.dismissed ? 'launch.err.dismissed' : 'launch.err.dialogTimeout'), 'dialog')
  }

  /**
   * The rest of a start once a trusted Claude waits for input: its name (Claude's /rename, and
   * herdr's when the launcher did not set it) and the first message, each only into an empty
   * input box. A name that does not take is no failure; a message that cannot go is.
   */
  async function finishStart(l: Launch, { kind, nameAgent }: { kind: string; nameAgent: boolean }): Promise<void> {
    const pane = paneOf(l)
    // A resumed session has its name; its herdr name is given when the launcher did not.
    if (kind === 'claude' && l.resume) {
      if (nameAgent)
        await takenNames()
          .then(taken => herdr(['agent', 'rename', pane, uniqueSlug(agentSlug(l), taken)]))
          .catch(err => deps.log(`launch ${l.name}: naming: ${messageOf(err)}`))
    } else if (kind === 'claude') {
      step(l, 'rename')
      try {
        if ((await inputEmpty(pane)) && (await claudeRename(pane, l.name)) && nameAgent) {
          const taken = await takenNames()
          await herdr(['agent', 'rename', pane, uniqueSlug(agentSlug(l), taken)])
        }
      } catch (err) {
        deps.log(`launch ${l.name}: naming: ${messageOf(err)}`)
      }
    } else if (kind === PI_AGENT && !l.resume) {
      // pi's input box is not one the board reads (core/dialogs/input-box.ts is Claude's): a pi
      // that just answered its dialog has nothing typed in it yet.
      step(l, 'rename')
      try {
        if ((await piName(pane, l.name)) && nameAgent) {
          const taken = await takenNames()
          await herdr(['agent', 'rename', pane, uniqueSlug(agentSlug(l), taken)])
        }
      } catch (err) {
        deps.log(`launch ${l.name}: naming: ${messageOf(err)}`)
      }
    }
    if (l.message) {
      step(l, 'message')
      if (kind !== PI_AGENT && !(await inputEmpty(pane)))
        throw new LaunchError(t('launch.err.message.draft'), 'message')
      if (!(await typeLine(pane, l.message))) throw new LaunchError(t('launch.err.message.lost'), 'message')
    }
  }

  /**
   * "Trust and continue" for a launch held at the trust dialog: only on the dialog for its folder,
   * the cursor moved one key at a time to "Yes" as the screen shows it, then Enter. The launch
   * goes on by itself once Claude is ready.
   */
  async function answerTrust(l: Launch): Promise<TrustAnswer> {
    if (l.trusting) return { ok: true }
    l.trusting = true
    try {
      for (let i = 0; i < 4; i++) {
        const d = await trustShown(l)
        if (!d || !l.pane) return { ok: false, error: t('launch.err.notTrust') }
        const key = keyTowardYes(d)
        if (key === null) return { ok: false, error: t('launch.err.trustCursor') }
        if (key === '') {
          await herdr(['pane', 'send-keys', l.pane, 'enter'])
          step(l, 'trusting')
          return { ok: true }
        }
        await herdr(['pane', 'send-keys', l.pane, key])
        await sleep(300)
      }
      return { ok: false, error: t('launch.err.trustCursor') }
    } catch (err) {
      return { ok: false, error: t('err.send', { name: l.name, why: messageOf(err) }) }
    } finally {
      l.trusting = false
    }
  }

  return { run: runLaunch, answerTrust }
}
