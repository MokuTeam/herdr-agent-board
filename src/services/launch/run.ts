// One launch, from a checked request to a session that waits for input: a worktree and a
// workspace first when asked, the launcher (launcher.ts), Claude's folder-trust dialog held on
// the card until it is answered, another dialog waited out, and the name and first message the
// launcher did not type. The card gets the chosen lane as soon as the session has an id.
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import { writeCard } from '../../adapters/cards.ts'
import { SLOW, statOf } from '../../adapters/folders.ts'
import { gitInfo } from '../../adapters/git.ts'
import { agentGet, type HerdrAgent, herdr, herdrText, workspaceCreate, workspacePanes } from '../../adapters/herdr.ts'
import { run } from '../../adapters/process.ts'
import { keyTowardYes, sameFolder, type TrustDialog, trustDialog } from '../../core/dialogs/trust.ts'
import { t } from '../../core/lang.ts'
import { launcherError } from '../../core/launch/launcher-command.ts'
import { slugName, uniqueSlug, worktreePath } from '../../core/launch/names.ts'
import type { Item, LaunchFailure, LaunchState, LaunchStep } from '../../core/types.ts'
import type { Deps } from '../deps.ts'
import { LaunchError, type LaunchEvents, launcherFor } from './launcher.ts'
import { claudeRename, inputEmpty, takenNames, typeLine } from './prompt.ts'
import type { LaunchRequest } from './request.ts'

/** A launch as the board keeps it while it runs. */
export interface Launch extends LaunchRequest {
  id: string
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
  worktreeMade: boolean
  dismissed: boolean
  closed: boolean
  trusting: boolean
}

/** A new launch for a checked request; `items`: the board as it is now. */
export function newLaunch(request: LaunchRequest, items: Item[]): Launch {
  return {
    ...request,
    id: randomUUID().slice(0, 8),
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
      writeCard(id, { category: l.category })
      l.carded = id
    },
  })

  async function runLaunch(l: Launch): Promise<void> {
    if (l.worktree) await makeWorktree(l, l.worktree.branch)
    if (l.newWorkspace) {
      step(l, 'workspace')
      const ws = await workspaceCreate(l.cwd, l.workspaceLabel)
      l.workspaceId = ws.id
      l.rootPane = ws.pane
      l.rootTab = ws.tab
    }
    const launcher = launcherFor(deps.cfg.launch)
    const r = await launcher.start(l, events(l))
    if (r.dialog && (await trustShown(l, 3))) {
      // Claude asks to trust the folder: the card asks the user, and the board goes on once it is.
      await holdForTrust(l)
      // What the launcher did not get to: the names and the first message.
      await finishStart(l, { kind: r.agent, nameAgent: !r.named })
    } else {
      if (r.failure) throw r.failure
      if (r.dialog) {
        // Another dialog holds it: the user answers it in herdr, the board waits and goes on.
        l.state = 'waiting'
        step(l, 'dialog')
        await untilReady(l, 15 * 60_000)
        l.state = 'starting'
      }
      // What the launcher did not get to: herdr's own start named the agent, so /rename and the
      // first message; the board's spawn-agent stopped at a dialog before any of the names.
      if (!r.typed) {
        if (r.named) await nameAndBrief(l, r.agent)
        else await finishStart(l, { kind: r.agent, nameAgent: true })
      }
    }
    // A new workspace starts with a tab of shells; a launcher command opened its own tab beside it.
    if (launcher.kind !== 'herdr' && l.rootTab && l.pane && l.pane !== l.rootPane)
      await tidy(l.workspaceId, l.rootTab, l.pane)
  }

  async function makeWorktree(l: Launch, branch: string): Promise<void> {
    step(l, 'worktree')
    const git = await gitInfo(l.cwd)
    if (!git) throw new LaunchError(t('launch.err.notGit', { path: l.cwd }), 'worktree')
    const path = worktreePath(git.root, branch)
    if (await statOf(path)) throw new LaunchError(t('launch.err.worktreeExists', { path }), 'worktree')
    const r = await run('git', ['-C', git.root, 'worktree', 'add', '-b', branch, path], { timeout: 60_000 })
    if (r.code !== 0) {
      const why = launcherError(r.stdout, r.stderr).message || r.error?.message || ''
      throw new LaunchError(t('launch.err.worktreeGit', { why }), 'worktree')
    }
    // The session works in the same place below the checkout as the folder that was picked.
    const below = relative(git.root, l.cwd)
    const inside = below && !below.startsWith('..') ? join(path, below) : path
    const st = await statOf(inside)
    l.cwd = st && st !== SLOW && st.isDirectory() ? inside : path
    l.worktreeMade = true
  }

  /** Claude's /rename and the first message, once the agent herdr started waits for input. */
  async function nameAndBrief(l: Launch, kind: string): Promise<void> {
    const pane = paneOf(l)
    if (kind === 'claude') {
      step(l, 'rename')
      // The name is cosmetic and Claude runs by now: a herdr error here must not mark the launch
      // failed, or a retry would start a second session.
      await claudeRename(pane, l.name).catch(err => deps.log(`launch ${l.name}: /rename: ${messageOf(err)}`))
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

  async function untilReady(l: Launch, limit: number): Promise<void> {
    const deadline = Date.now() + limit
    while (Date.now() < deadline && !l.dismissed && !l.closed) {
      await sleep(1500)
      if (ready(await agentNow(l))) return
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
      if (d && sameFolder(d.folder, l.cwd)) return d
    }
    return null
  }

  /** Keep the launch on the board, asking, until the folder is trusted (here or in herdr) or its tab closed. */
  async function holdForTrust(l: Launch): Promise<void> {
    l.state = 'trust'
    l.error = ''
    step(l, 'trust')
    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline && !l.dismissed && !l.closed) {
      await sleep(1500)
      const agent = await agentNow(l)
      if (ready(agent)) {
        l.state = 'starting'
        return
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
    if (kind === 'claude') {
      step(l, 'rename')
      try {
        if ((await inputEmpty(pane)) && (await claudeRename(pane, l.name)) && nameAgent) {
          const taken = await takenNames()
          await herdr(['agent', 'rename', pane, uniqueSlug(slugName(l.name), taken)])
        }
      } catch (err) {
        deps.log(`launch ${l.name}: naming: ${messageOf(err)}`)
      }
    }
    if (l.message) {
      step(l, 'message')
      if (!(await inputEmpty(pane))) throw new LaunchError(t('launch.err.message.draft'), 'message')
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
