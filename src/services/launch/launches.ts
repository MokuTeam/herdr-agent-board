// The launches of this board process: new sessions started from the web board. A launch runs in
// the background (run.ts) and is reported in the board payload (`launches`), so the page shows a
// starting card at once and a clear reason when it fails. This keeps them: starting one, linking
// it to the session it started, the card's buttons (dismiss, go to it, trust, close its tab) and
// what the new-session window offers.
import { readCard, removeCard, writeCard } from '../../adapters/cards.ts'
import { herdr, paneTab, workspaceList } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import { failureKind } from '../../core/launch/launcher-command.ts'
import { sameDir } from '../../core/launch/names.ts'
import { shownProfiles } from '../../core/profiles.ts'
import type { Item, LaunchView } from '../../core/types.ts'
import { raiseTerminal } from '../../integrations/terminal-window.ts'
import type { Deps } from '../deps.ts'
import { LaunchError, type LauncherInfo, launcherFor, removeLeftoverMessages } from './launcher.ts'
import { checkRequest } from './request.ts'
import { type Launch, launchRunner, newLaunch } from './run.ts'

export interface LaunchOptions {
  launcher: LauncherInfo
  workspaces: { id: string; label: string | undefined }[]
  focused: string
  board: string
  recent: string[]
  error: string
}

export type LaunchActionResult = { ok: true } | { ok: false; error: string }
export type StartResult = { ok: true; id: string } | { ok: false; field: string; error: string }

export interface Launches {
  /** `items`: the board now, for the lanes it has and the panes that are not this launch's. */
  start(body: unknown, items?: Item[]): Promise<StartResult>
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
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const errorText = (err: unknown): string =>
  (isRecord(err) && typeof err.message === 'string' && err.message) || String(err)
const codeOf = (err: unknown): string | undefined =>
  isRecord(err) && typeof err.code === 'string' ? err.code : undefined

// What a retry starts from: a worktree or a workspace this launch made already is used, not
// made again (git would refuse the branch; herdr would get a second, empty workspace).
const view = (l: Launch): LaunchView => ({
  id: l.id,
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
})

/** The launches of this board process; `onChange` publishes the board again. */
export function createLaunches({ deps, onChange = () => {} }: { deps: Deps; onChange?: () => void }): Launches {
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

  async function start(body: unknown, items: Item[] = []): Promise<StartResult> {
    const categories = new Set([...deps.cfg.categories.map(c => c.id), ...items.map(i => i.category)])
    const r = await checkRequest(body, { categories })
    if (!r.ok) return r
    const l = newLaunch(r.launch, items)
    launches.set(l.id, l)
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
    changed()
    return { ok: true, id: l.id }
  }

  /** "Trust and continue" on a launch's card (run.ts moves the cursor). */
  async function trust(id: string): Promise<LaunchActionResult> {
    const l = launches.get(id)
    if (l?.state !== 'trust') return { ok: false, error: t('launch.err.gone') }
    return runner.answerTrust(l)
  }

  /** "Close the tab": the launch's tab goes, and the launch with it (and a card nothing but the lane was written to). */
  async function closeTab(id: string): Promise<LaunchActionResult> {
    const l = launches.get(id)
    if (!l?.pane || (l.state !== 'trust' && l.state !== 'waiting')) return { ok: false, error: t('launch.err.gone') }
    try {
      const tab = await paneTab(l.pane)
      if (tab) await herdr(['tab', 'close', tab])
    } catch (err) {
      return { ok: false, error: t('err.focus', { name: l.name, why: messageOf(err) }) }
    }
    l.closed = true
    const laneOnly = (key: string): boolean =>
      Object.keys(readCard(key) ?? {}).every(k => ['key', 'category', 'updatedAt'].includes(k))
    if (l.sessionId && laneOnly(l.sessionId)) removeCard(l.sessionId)
    launches.delete(id)
    changed()
    return { ok: true }
  }

  function observe(items: Item[]): void {
    const claimed = new Set<string>()
    for (const l of launches.values()) {
      let it =
        (l.sessionId ? items.find(i => i.session === l.sessionId) : undefined) ??
        (l.pane ? items.find(i => i.pane === l.pane) : undefined)
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
      const age = now - (l.doneAt ?? now)
      const done = l.state === 'done' && ((!!l.key && !!l.carded && age > 8000) || age > 120_000 || l.dismissed)
      if (done || (l.state === 'failed' && now - l.startedAt > 30 * 60_000)) {
        launches.delete(id)
        gone = true
      }
    }
    if (gone) changed()
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
    if (l.state === 'failed' || l.state === 'done') launches.delete(id)
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
    return {
      launcher: launcherFor(cfg.launch).describe(),
      workspaces,
      focused,
      board: (cfg.placement ?? 'workspace') === 'workspace' ? (cfg.workspace ?? 'Board') : '',
      // Of the profiles the owner shows: a hidden one's folders are not offered.
      recent: await deps.homes.recentFolders(shownProfiles(deps.profiles().list).map(p => p.dir)),
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
    list: () => [...launches.values()].filter(l => !l.dismissed).map(view),
  }
}
