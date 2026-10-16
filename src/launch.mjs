// New sessions from the web board, and renaming one in Claude and herdr.
//
// A launch runs in the background and is reported in the board payload (`launches`), so the
// page shows a starting card at once and a clear reason when it fails. Two ways to start one:
//   herdr (default)  a tab through herdr (a workspace first when asked), the agent started by
//                    `herdr agent start`, then /rename and the first message typed into it.
//   command          `launch.command` in config.json: an executable and its arguments, with
//                    {placeholders} filled in per argument. No shell, nothing from the request
//                    becomes a command; it should print `pane=<id>` when the session is up.
// The card gets the chosen category as soon as the session has an id; a Claude started by the
// board gets its id up front (--session-id), so even its first brief knows the lane.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkBranch, checkName, sameDir, slugName, uniqueSlug, UNSAFE_CHARS, worktreePath } from './core/launch/names.ts'
import { commandArgs, failureKind, launcherError, launcherLabel, parseLauncherOutput, usesPlaceholder } from './core/launch/launcher-command.ts'
import { resolvePath } from './adapters/files.ts'
import { SLOW, statOf } from './adapters/folders.ts'
import { gitInfo } from './adapters/git.ts'
import { herdr, herdrText } from './adapters/herdr.ts'
import { run, runTree } from './adapters/process.ts'
import { raiseTerminal } from './integrations/terminal-window.ts'
import { inputDraft } from './core/dialogs/input-box.ts'
import { t } from './core/lang.ts'
import { defaultClaudeHome } from './adapters/claude-home.ts'
import { cardsDir, stateDir } from './adapters/paths.ts'
import { readCard, writeCard } from './adapters/cards.ts'
import { keyTowardYes, sameFolder, trustDialog } from './core/dialogs/trust.ts'

const LAUNCH_DIR = join(stateDir(), 'launch') // first messages for {messageFile}, while a launcher runs
const MESSAGE_MAX = 20_000

// ------------------------------------------------------------------ typing into a live agent

const stalled = err => /agent_prompt_stalled/.test(`${err?.code} ${err?.message}`)

/**
 * Type a line into an agent's prompt. Right after a slash command Claude can drop typed text,
 * and a short turn can end before herdr sees it working: both read as agent_prompt_stalled.
 * Text still on screen gets an Enter; text that vanished is typed again (as spawn-agent does).
 */
async function typeLine(pane, text, tries = 3) {
  const line = /^-/.test(text) ? ` ${text}` : text // a leading dash reads as an option to herdr
  for (let i = 1; i <= tries; i++) {
    try {
      await herdr(['agent', 'prompt', pane, line])
      return true
    } catch (err) {
      if (!stalled(err)) throw err
      const screen = await herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => '')
      // Its first line (the screen breaks the rest) still in the prompt: it only needs its Enter.
      if (screen.includes(text.split('\n')[0].slice(0, 30)) || /Pasted text/.test(screen)) {
        await herdr(['pane', 'send-keys', pane, 'enter']).catch(() => {})
        return true
      }
      await new Promise(r => setTimeout(r, 800))
    }
  }
  return false
}

/** Claude's /rename runs without a turn: herdr calls the prompt stalled; the screen says whether it took. */
async function claudeRename(pane, name) {
  try {
    await herdr(['agent', 'prompt', pane, `/rename ${name}`])
  } catch (err) {
    if (!stalled(err)) throw err
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (/Session renamed/i.test(await herdrText(['pane', 'read', pane, '--source', 'visible'], 5000).catch(() => ''))) return true
  }
  return false
}

async function agentNames() {
  try {
    return new Set(((await herdr(['agent', 'list']))?.agents ?? []).map(a => a.name).filter(Boolean))
  } catch {
    return new Set()
  }
}

/**
 * Rename a session in Claude (/rename, what SendMessage, ListAgents and herdr-wake see) and its
 * herdr name. Typed into the session, so only into an idle one that is still the same session.
 */
export async function renameSession(item, name) {
  if (item.sleeping) return { ok: false, error: t('rename.err.asleep', { name: item.name }) }
  if (!item.session || !item.pane || item.agent !== 'claude') return { ok: false, error: t('rename.err.notClaude', { name: item.name }) }
  try {
    const agent = (await herdr(['agent', 'get', item.pane]))?.agent
    if (!agent || (agent.agent_session?.value ?? null) !== item.session) return { ok: false, error: t('err.sessionChanged', { name: item.name }) }
    // Only a session that waits for input: not mid-turn, not at a dialog, not in a state herdr cannot tell.
    if (agent.agent_status !== 'idle' && agent.agent_status !== 'done') return { ok: false, error: t('rename.err.busy', { name: item.name }) }
    // /rename typed after what the user started in the input box would send both; no input box
    // on screen (a picker, a dialog) is no place to type either.
    const draft = inputDraft(await herdrText(['agent', 'read', item.pane, '--source', 'recent', '--lines', '40', '--ansi'], 10_000))
    if (draft !== '') return { ok: false, error: t(draft === null ? 'rename.err.screen' : 'err.draft', { name: item.name }) }
    const confirmed = await claudeRename(item.pane, name)
    // herdr's name follows only a rename Claude confirmed, so the two do not drift apart.
    if (confirmed) {
      const taken = await agentNames()
      taken.delete(agent.name)
      const slug = uniqueSlug(slugName(name), taken)
      if (slug !== agent.name) await herdr(['agent', 'rename', item.pane, slug]).catch(() => {})
    }
    return { ok: true, confirmed }
  } catch (err) {
    return { ok: false, error: t('rename.err.claude', { why: err.message }) }
  }
}

// ------------------------------------------------------------------ launches

class LaunchError extends Error {
  constructor(message, kind) {
    super(message)
    this.kind = kind
  }
}

const WORKSPACE_ID = /^[A-Za-z0-9][\w:-]{0,39}$/
/** A workspace name herdr takes as a value: no control characters, no leading dash. */
const workspaceName = (s, max) => !!s && s.length <= max && !UNSAFE_CHARS.test(s) && !s.startsWith('-')
const CATEGORY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** Check a launch request. { ok, launch } or { ok: false, error, field }. */
export async function checkRequest(body, { categories = null } = {}) {
  const fail = (field, key, vars) => ({ ok: false, field, error: t(key, vars) })
  const name = String(body?.name ?? '').trim()
  const bad = checkName(name)
  if (bad) return fail('name', bad, { max: 60 })
  const { path: cwd } = resolvePath(body?.cwd)
  if (!cwd) return fail('cwd', 'launch.err.cwdEmpty')
  const st = await statOf(cwd, 3000)
  if (st === SLOW) return fail('cwd', 'launch.err.cwdSlow', { path: cwd })
  if (!st) return fail('cwd', 'launch.err.cwdMissing', { path: cwd })
  if (!st.isDirectory()) return fail('cwd', 'launch.err.cwdFile', { path: cwd })
  // A lane the board has (configured, or one an agent made), or "other" when none was given.
  const category = String(body?.category ?? '') || 'other'
  if (!CATEGORY_ID.test(category) || (categories && category !== 'other' && !categories.has(category))) return fail('category', 'launch.err.category', { id: category })
  const ws = body?.workspace ?? {}
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
  const message = String(body?.message ?? '').trim()
  if (message.length > MESSAGE_MAX) return fail('message', 'launch.err.message', { n: MESSAGE_MAX })
  let worktree = null
  if (body?.worktree) {
    const branch = String(body.worktree.branch ?? '').trim()
    const why = checkBranch(branch)
    if (why) return fail('worktree', why)
    worktree = { branch }
  }
  return { ok: true, launch: { name, label: name, cwd, category, workspaceId, workspaceLabel, newWorkspace: !workspaceId, message, worktree } }
}

/**
 * The launches of this board process. `onChange` publishes the board again; `observe(items)`
 * after each refresh links launches to the sessions they started and gives those their lane.
 */
export function createLaunches({ cfg, log = () => {}, onChange = () => {} }) {
  const launches = new Map()
  // First messages a launcher never got to read (the board stopped mid-launch) do not stay on disk.
  try {
    for (const f of readdirSync(LAUNCH_DIR)) if (/^[0-9a-f]{8}\.txt$/.test(f)) unlinkSync(join(LAUNCH_DIR, f))
  } catch {}
  const changed = () => onChange()
  const spec = () => cfg.launch ?? {}

  async function start(body, items = []) {
    const r = await checkRequest(body, { categories: new Set([...cfg.categories.map(c => c.id), ...items.map(i => i.category)]) })
    if (!r.ok) return r
    const l = { ...r.launch, id: randomUUID().slice(0, 8), state: 'starting', step: 'prepare', startedAt: Date.now(), knownPanes: new Set(items.map(i => i.pane)), pane: null, key: null, error: '', kind: '' }
    launches.set(l.id, l)
    runLaunch(l)
      .then(() => {
        l.state = 'done'
        l.doneAt = Date.now()
      })
      .catch(err => {
        if (l.dismissed || l.closed) return void launches.delete(l.id) // waved off, or its tab closed: nothing to show
        l.state = 'failed'
        l.error = err.message || String(err)
        l.kind = err.kind || failureKind(l.error, err.code)
        log(`launch ${l.name}: ${l.error}`)
      })
      .finally(changed)
    changed()
    return { ok: true, id: l.id }
  }

  const step = (l, name) => {
    l.step = name
    changed()
  }

  async function runLaunch(l) {
    if (l.worktree) {
      step(l, 'worktree')
      const git = await gitInfo(l.cwd)
      if (!git) throw new LaunchError(t('launch.err.notGit', { path: l.cwd }), 'worktree')
      const path = worktreePath(git.root, l.worktree.branch)
      if (await statOf(path)) throw new LaunchError(t('launch.err.worktreeExists', { path }), 'worktree')
      const r = await run('git', ['-C', git.root, 'worktree', 'add', '-b', l.worktree.branch, path], { timeout: 60_000 })
      if (r.code !== 0) throw new LaunchError(t('launch.err.worktreeGit', { why: launcherError(r.stdout, r.stderr).message || r.error?.message }), 'worktree')
      // The session works in the same place below the checkout as the folder that was picked.
      const below = relative(git.root, l.cwd)
      const inside = below && !below.startsWith('..') ? join(path, below) : path
      l.cwd = (await statOf(inside))?.isDirectory?.() ? inside : path
      l.worktreeMade = true
    }
    if (l.newWorkspace) {
      step(l, 'workspace')
      const r = await herdr(['workspace', 'create', '--cwd', l.cwd, '--label', l.workspaceLabel, '--no-focus'])
      l.workspaceId = r.workspace.workspace_id
      l.rootPane = r.root_pane?.pane_id ?? null
      l.rootTab = r.tab?.tab_id ?? null
    }
    if (spec().command) await viaCommand(l)
    else await viaHerdr(l)
  }

  /** A Claude the board starts gets its session id now, so its card (and lane) exist before it does. */
  function ownSessionId(l) {
    l.sessionId = randomUUID()
    writeCard(l.sessionId, { category: l.category })
    l.carded = l.sessionId
  }

  async function viaHerdr(l) {
    step(l, 'tab')
    let pane
    if (l.rootPane) {
      pane = l.rootPane
      if (l.rootTab) await herdr(['tab', 'rename', l.rootTab, l.label]).catch(() => {})
    } else {
      pane = (await herdr(['tab', 'create', '--workspace', l.workspaceId, '--cwd', l.cwd, '--label', l.label, '--no-focus'])).root_pane.pane_id
    }
    l.pane = pane
    const kind = String(spec().agent ?? 'claude')
    const args = (Array.isArray(spec().args) ? spec().args : []).map(String)
    if (kind === 'claude' && !args.some(a => /^(--session-id|-r|--resume|-c|--continue)$/.test(a))) {
      ownSessionId(l)
      args.push('--session-id', l.sessionId)
    }
    l.agent = uniqueSlug(slugName(l.name), await agentNames())
    step(l, 'agent')
    const ms = Math.max(10, Number(spec().timeoutSec) || 120) * 1000
    try {
      await herdr(['agent', 'start', l.agent, '--kind', kind, '--pane', pane, '--timeout', String(Math.min(ms, 300_000)), ...(args.length ? ['--', ...args] : [])], ms + 15_000)
    } catch (err) {
      if (err.code !== 'agent_not_ready' && !/agent_not_ready/.test(err.message)) {
        const agent = kind === 'claude' ? 'Claude' : kind
        throw new LaunchError(/timeout|timed out/i.test(err.message) ? t('launch.err.notReady', { s: ms / 1000, agent }) : err.message, failureKind(err.message))
      }
      // Claude asks to trust the folder: the card asks the user, and the board goes on once it is.
      if (await trustShown(l, 3)) {
        await holdForTrust(l)
        return finishStart(l, { kind, nameAgent: false })
      }
      // Another dialog holds it: the user answers it in herdr, the board waits and goes on.
      l.state = 'waiting'
      step(l, 'dialog')
      await untilReady(l, 15 * 60_000)
      l.state = 'starting'
    }
    if (kind === 'claude') {
      step(l, 'rename')
      // The name is cosmetic and Claude runs by now: a herdr error here must not mark the launch
      // failed, or a retry would start a second session.
      await claudeRename(pane, l.name).catch(err => log(`launch ${l.name}: /rename: ${err.message}`))
    }
    if (l.message) {
      step(l, 'message')
      if (!(await typeLine(pane, l.message))) throw new LaunchError(t('launch.err.message.lost'), 'message')
    }
  }

  async function untilReady(l, limit) {
    const deadline = Date.now() + limit
    while (Date.now() < deadline && !l.dismissed && !l.closed) {
      await new Promise(r => setTimeout(r, 1500))
      let agent = null
      try {
        agent = (await herdr(['agent', 'get', l.pane], 5000))?.agent
      } catch (err) {
        if (/not.?found|no such/i.test(err.message)) throw new LaunchError(t('launch.err.paneGone'), 'other')
      }
      if (agent && (agent.agent_status === 'idle' || agent.agent_status === 'done')) return
    }
    throw new LaunchError(t(l.dismissed ? 'launch.err.dismissed' : 'launch.err.dialogTimeout'), 'dialog')
  }

  async function viaCommand(l) {
    const template = spec().command
    const vars = { name: l.name, label: l.label, cwd: l.cwd, workspace: l.workspaceId, workspaceLabel: l.workspaceLabel, category: l.category, message: l.message, messageFile: '', sessionId: '' }
    if (usesPlaceholder(template, 'sessionId')) {
      ownSessionId(l)
      vars.sessionId = l.sessionId
    }
    let file = null
    let held = false
    if (l.message && usesPlaceholder(template, 'messageFile')) {
      // Only this user may read it; a new file every time, never one someone put there.
      mkdirSync(LAUNCH_DIR, { recursive: true, mode: 0o700 })
      file = join(LAUNCH_DIR, `${l.id}.txt`)
      writeFileSync(file, l.message, { mode: 0o600, flag: 'wx' })
      vars.messageFile = file
    }
    try {
      const { file: exe, args } = commandArgs(template, vars)
      step(l, 'command')
      // The board runs in a pane of its own workspace: the launcher must not take that for "here".
      const env = { ...process.env, HERDR_WORKSPACE_ID: l.workspaceId }
      delete env.HERDR_PANE_ID
      delete env.HERDR_TAB_ID
      const timeout = Math.max(1, Number(spec().timeoutSec) || 180) * 1000
      const r = await runTree(exe, args, { timeout, env, cwd: l.cwd })
      const out = parseLauncherOutput(r.stdout)
      if (out.pane) l.pane = out.pane
      if (r.code !== 0) {
        if (r.error?.code === 'ENOENT') throw new LaunchError(t('launch.err.launcherMissing', { file: exe }), 'launcher')
        if (r.killed) throw new LaunchError(t('launch.err.launcherTimeout', { s: timeout / 1000 }), 'timeout')
        const e = launcherError(r.stdout, r.stderr)
        if (!l.pane && e.pane) l.pane = e.pane
        const kind = failureKind(e.message, r.error?.code)
        // A launcher gives up where Claude asks to trust the folder; the session is there, waiting.
        if (kind === 'dialog' && (await trustShown(l, 3))) held = true
        else throw new LaunchError(e.message || r.error?.message || t('err.status', { code: r.code }), kind)
      }
    } finally {
      if (file) try { unlinkSync(file) } catch {}
    }
    if (held) {
      await holdForTrust(l)
      // What the launcher did not get to: the names and the first message.
      await finishStart(l, { kind: 'claude', nameAgent: true })
    }
    // A new workspace starts with a tab of shells; the launcher opened its own tab beside it.
    if (l.rootTab && l.pane && l.pane !== l.rootPane) await tidy(l.workspaceId, l.rootTab, l.pane)
  }

  // -------------------------------------------------------------- the folder-trust dialog

  /**
   * The trust dialog the launch's pane ends in, for the launch's own folder; else null. `tries`:
   * right after herdr calls the agent blocked, the dialog may still be drawing.
   */
  async function trustShown(l, tries = 1) {
    if (!l.pane) return null
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise(r => setTimeout(r, 700))
      const screen = await herdrText(['pane', 'read', l.pane, '--source', 'visible'], 5000).catch(() => '')
      const d = trustDialog(screen)
      if (d && sameFolder(d.folder, l.cwd)) return d
    }
    return null
  }

  /** Keep the launch on the board, asking, until the folder is trusted (here or in herdr) or its tab closed. */
  async function holdForTrust(l) {
    l.state = 'trust'
    l.error = ''
    step(l, 'trust')
    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline && !l.dismissed && !l.closed) {
      await new Promise(r => setTimeout(r, 1500))
      let agent = null
      try {
        agent = (await herdr(['agent', 'get', l.pane], 5000))?.agent
      } catch (err) {
        if (/not.?found|no such/i.test(err.message)) throw new LaunchError(t('launch.err.paneGone'), 'other')
      }
      if (agent && (agent.agent_status === 'idle' || agent.agent_status === 'done')) {
        l.state = 'starting'
        return
      }
      // Trusted, and Claude asks something else (a project's MCP servers, say): that one is
      // answered in herdr, and the card says so instead of "trusting" on and on.
      if (l.state === 'trust' && agent?.agent_status === 'blocked' && !(await trustShown(l))) {
        l.state = 'waiting'
        step(l, 'dialog')
      }
    }
    throw new LaunchError(t(l.dismissed ? 'launch.err.dismissed' : 'launch.err.dialogTimeout'), 'dialog')
  }

  /** Whether Claude's input box is there and empty: nothing is typed over what the user started. */
  async function inputEmpty(pane) {
    const screen = await herdrText(['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi'], 10_000).catch(() => null)
    return screen !== null && inputDraft(screen) === ''
  }

  /**
   * The rest of a start once a trusted Claude waits for input: its name (Claude's /rename, and
   * herdr's when the launcher did not set it) and the first message, each only into an empty
   * input box. A name that does not take is no failure; a message that cannot go is.
   */
  async function finishStart(l, { kind, nameAgent }) {
    if (kind === 'claude') {
      step(l, 'rename')
      try {
        if ((await inputEmpty(l.pane)) && (await claudeRename(l.pane, l.name)) && nameAgent) {
          const taken = await agentNames()
          await herdr(['agent', 'rename', l.pane, uniqueSlug(slugName(l.name), taken)])
        }
      } catch (err) {
        log(`launch ${l.name}: naming: ${err.message}`)
      }
    }
    if (l.message) {
      step(l, 'message')
      if (!(await inputEmpty(l.pane))) throw new LaunchError(t('launch.err.message.draft'), 'message')
      if (!(await typeLine(l.pane, l.message))) throw new LaunchError(t('launch.err.message.lost'), 'message')
    }
  }

  /**
   * "Trust and continue": only on the trust dialog for this launch's folder, the cursor moved
   * one key at a time to "Yes" as the screen shows it, then Enter. The launch goes on by itself
   * once Claude is ready.
   */
  async function trust(id) {
    const l = launches.get(id)
    if (!l || l.state !== 'trust') return { ok: false, error: t('launch.err.gone') }
    if (l.trusting) return { ok: true }
    l.trusting = true
    try {
      for (let i = 0; i < 4; i++) {
        const d = await trustShown(l)
        if (!d) return { ok: false, error: t('launch.err.notTrust') }
        const key = keyTowardYes(d)
        if (key === null) return { ok: false, error: t('launch.err.trustCursor') }
        if (key === '') {
          await herdr(['pane', 'send-keys', l.pane, 'enter'])
          step(l, 'trusting')
          return { ok: true }
        }
        await herdr(['pane', 'send-keys', l.pane, key])
        await new Promise(r => setTimeout(r, 300))
      }
      return { ok: false, error: t('launch.err.trustCursor') }
    } catch (err) {
      return { ok: false, error: t('err.send', { name: l.name, why: err.message }) }
    } finally {
      l.trusting = false
    }
  }

  /** "Close the tab": the launch's tab goes, and the launch with it (and a card nothing but the lane was written to). */
  async function closeTab(id) {
    const l = launches.get(id)
    if (!l?.pane || (l.state !== 'trust' && l.state !== 'waiting')) return { ok: false, error: t('launch.err.gone') }
    try {
      const tab = (await herdr(['pane', 'get', l.pane]))?.pane?.tab_id
      if (tab) await herdr(['tab', 'close', tab])
    } catch (err) {
      return { ok: false, error: t('err.focus', { name: l.name, why: err.message }) }
    }
    l.closed = true
    if (l.sessionId && Object.keys(readCard(l.sessionId) ?? {}).every(k => ['key', 'category', 'updatedAt'].includes(k))) {
      try {
        unlinkSync(join(cardsDir(), `${l.sessionId}.json`))
      } catch {}
    }
    launches.delete(id)
    changed()
    return { ok: true }
  }

  /** Close the tab a new workspace came with, if no agent runs in it (the session is elsewhere). */
  async function tidy(workspace, tab, pane) {
    try {
      const panes = ((await herdr(['pane', 'list', '--workspace', workspace]))?.panes ?? []).filter(p => p.tab_id === tab)
      if (panes.length && !panes.some(p => p.agent || p.pane_id === pane)) await herdr(['tab', 'close', tab])
    } catch {}
  }

  /** After a refresh: which item each launch started, and its category on its card. */
  function observe(items) {
    const claimed = new Set()
    for (const l of launches.values()) {
      let it = (l.sessionId && items.find(i => i.session === l.sessionId)) || (l.pane && items.find(i => i.pane === l.pane)) || null
      // A launcher that says its pane only at the end: while it runs, a new agent pane in that
      // folder and workspace is taken for it, and the pane it prints settles it. herdr's own path
      // and launchers given {sessionId} need no guess: they are matched by the session id.
      const guess = !it && !l.pane && !l.sessionId && l.step === 'command' && l.state === 'starting' && l.workspaceLabel
      if (guess) it = items.find(i => !l.knownPanes.has(i.pane) && i.workspace === l.workspaceLabel && sameDir(i.cwd, l.cwd) && !claimed.has(i.key) && ![...launches.values()].some(o => o !== l && o.key === i.key))
      if (!it) continue
      claimed.add(it.key)
      l.key = it.key
      l.pane ??= it.pane
      // Its card gets the lane under the key it has now. A Claude pane is keyed by its session id
      // in a moment, so only other agents get a card by their pane.
      if (l.carded !== it.key && (it.session || it.agent !== 'claude')) {
        try {
          writeCard(it.key, { category: l.category })
          l.carded = it.key
        } catch {}
      }
    }
    // Started ones go once their card is on the board; failed ones stay until dismissed (or 30 min).
    const now = Date.now()
    let gone = false
    for (const [id, l] of launches) {
      const done = l.state === 'done' && ((l.key && l.carded && now - l.doneAt > 8000) || now - l.doneAt > 120_000 || l.dismissed)
      if (done || (l.state === 'failed' && now - l.startedAt > 30 * 60_000)) {
        launches.delete(id)
        gone = true
      }
    }
    if (gone) changed()
  }

  /** An item a launch started: in the chosen lane until its card says so too, and how the launch goes. */
  function decorate(item) {
    const l = [...launches.values()].find(x => x.key === item.key)
    if (!l) return item
    const starting = l.state !== 'done' && !l.dismissed
    // Until /rename went through, herdr knows it by its terminal's title ("claude"): the card shows the name it was started with.
    const name = starting && item.name === item.autoName ? l.name : item.name
    return { ...item, name, category: item.categorySet ? item.category : l.category, launch: starting ? view(l) : null }
  }

  // What a retry starts from: a worktree or a workspace this launch made already is used, not
  // made again (git would refuse the branch; herdr would get a second, empty workspace).
  const view = l => ({ id: l.id, name: l.name, cwd: l.cwd, category: l.category, workspace: l.workspaceLabel, workspaceId: l.workspaceId || null, state: l.state, step: l.step, error: l.error, kind: l.kind, pane: l.pane, key: l.key, startedAt: l.startedAt, doneAt: l.doneAt ?? null, message: l.message, worktree: l.worktreeMade ? null : l.worktree, newWorkspace: l.newWorkspace && !l.workspaceId })

  /**
   * Take a launch off the board. A failed one goes; one still running only stops showing: it
   * goes on, and its session still gets its lane (a dialog it waits on is given up on).
   */
  function dismiss(id) {
    const l = launches.get(id)
    if (!l) return { ok: false, error: t('launch.err.gone') }
    l.dismissed = true
    if (l.state === 'failed' || l.state === 'done') launches.delete(id)
    changed()
    return { ok: true }
  }

  /** Go to a launch's tab in herdr (it may be no agent yet: a shell, or one waiting for a dialog). */
  async function focusLaunch(id) {
    const l = launches.get(id)
    if (!l?.pane) return { ok: false, error: t('launch.err.gone') }
    try {
      const tab = (await herdr(['pane', 'get', l.pane]))?.pane?.tab_id
      if (!tab) throw new Error(t('launch.err.paneGone'))
      await herdr(['tab', 'focus', tab])
    } catch (err) {
      return { ok: false, error: t('err.focus', { name: l.name, why: err.message }) }
    }
    if (cfg.raiseTerminal !== false) raiseTerminal(cfg)
    return { ok: true }
  }

  /** What the window needs: the launcher, herdr's workspaces, recent folders. */
  async function options() {
    let workspaces = []
    let focused = ''
    let error = ''
    try {
      const list = (await herdr(['workspace', 'list'], 8000))?.workspaces ?? []
      workspaces = list.map(w => ({ id: w.workspace_id, label: w.label }))
      focused = list.find(w => w.focused)?.workspace_id ?? ''
    } catch (err) {
      error = err.message
    }
    const command = spec().command
    return {
      launcher: command ? { kind: 'command', name: launcherLabel(command) } : { kind: 'herdr', agent: String(spec().agent ?? 'claude') },
      workspaces,
      focused,
      board: (cfg.placement ?? 'workspace') === 'workspace' ? (cfg.workspace ?? 'Board') : '',
      recent: await defaultClaudeHome().recentFolders(),
      error,
    }
  }

  return { start, observe, decorate, dismiss, focus: focusLaunch, trust, closeTab, options, list: () => [...launches.values()].filter(l => !l.dismissed).map(view) }
}
