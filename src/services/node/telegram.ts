// Node-side Telegram delivery (#701): served only on the node's master door (server/routes/node.ts).
// Delegates to the node's own wake process (`POST /route`) when wake is up so wake's session file,
// locks, and profile state stay consistent; falls back to direct local delivery via herdr when wake
// is off or unreachable.
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isRecord } from '../../adapters/json-store.ts'
import { peekWakeSessions } from '../../adapters/wake-files.ts'
import { cliWakeHerdr, type WakeHerdr } from '../../adapters/wake-herdr.ts'
import { sameDir } from '../../core/launch/names.ts'
import { defaultProfileDir, type ProfileSet, profileForDir } from '../../core/profiles.ts'
import type { Config } from '../../core/types.ts'
import { wakeConfig } from '../../core/wake/config.ts'
import { isRouteResult, parseRouteItemsBody } from '../../core/wake/node-route.ts'
import { formatPrompt, resolve } from '../../core/wake/route.ts'
import { plainProfile } from '../../core/wake/rules.ts'
import { isFreed, type WakeSessions } from '../../core/wake/sessions.ts'
import { type Follow, followFiles } from '../wake/follow.ts'
import { type Timing, wakeInPane, withPane } from '../wake/pane-ops.ts'
import { defaultTabOps, openTab, type TabOps } from '../wake/tabs.ts'
import { deliverLive, notWoken, routeSnapshot, wokeNote } from '../wake/telegram.ts'
import type { Answer } from './bundle.ts'

export interface NodeTelegram {
  route(body: unknown): Promise<Answer>
}

export interface NodeTelegramDeps {
  cfg: Config
  profiles(): ProfileSet
  herdr?: WakeHerdr
  readSessions?: () => WakeSessions
  tabs?: TabOps
  follow?: Follow
  machine?: string
  platform?: string
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  askWake?: boolean
  log(text: string): void
  refresh?(): void
  sleep?(ms: number): Promise<void>
  now?(): number
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function lineProfile(set: ProfileSet, dir: string | undefined, platform: string): string | null {
  if (!dir) return null
  const id = profileForDir(set.list, dir)?.id
  if (!id) return null
  return plainProfile(id) || !sameDir(dir, defaultProfileDir(homedir(), platform)) ? id : null
}

export function createNodeTelegram(deps: NodeTelegramDeps): NodeTelegram {
  const herdr = deps.herdr ?? cliWakeHerdr
  const readSessions = deps.readSessions ?? (() => peekWakeSessions())
  const tabs = deps.tabs ?? defaultTabOps(path => existsSync(path))
  const follow = deps.follow ?? followFiles
  const machine = deps.machine ?? (process.env.COMPUTERNAME || hostname())
  const platform = deps.platform ?? process.platform
  const fetchFn = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const timing: Timing = {
    log: text => deps.log(text),
    ...(deps.sleep && { sleep: deps.sleep }),
    ...(deps.now && { now: deps.now }),
  }

  return {
    async route(body) {
      const parsed = parseRouteItemsBody(body)
      if (!parsed) return { status: 400, body: { ok: false, error: 'body' } }
      const { items, liveOnly } = parsed
      const first = items[0]
      if (!first) return { status: 200, body: { matched: true, result: { ok: true } } }
      const topic = first.topic ?? first.key

      const wake = wakeConfig(deps.cfg.wake)
      if (wake.enabled && deps.askWake !== false) {
        try {
          const res = await fetchFn(`http://127.0.0.1:${wake.port}/route`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items, ...(liveOnly && { liveOnly: true }) }),
            signal: AbortSignal.timeout((wake.wakeTimeoutSec + 60) * 1000),
          })
          if (res.status === 503) return { status: 200, body: { matched: true, result: { retry: 15 } } }
          if (res.ok) {
            const ans: unknown = await res.json().catch(() => null)
            if (isRecord(ans) && ans.matched === false) return { status: 200, body: { matched: false } }
            if (isRecord(ans) && ans.matched === true && isRouteResult(ans.result)) {
              if ('ok' in ans.result) deps.refresh?.()
              return { status: 200, body: { matched: true, result: ans.result } }
            }
          }
        } catch {}
      }

      // Fallback when wake is off or unreachable: route directly via local herdr and wake-sessions.json.
      try {
        const snap = await herdr.snapshot()
        const sessions = readSessions()
        const target = resolve(first, routeSnapshot(snap), sessions, machine)
        if (!target || (liveOnly && target.session)) return { status: 200, body: { matched: false } }

        const result = await withPane(target.pane, async () => {
          let pane = target.pane
          let wokeHere = Boolean(target.session)
          if (target.session) {
            const entry = sessions[target.pane]
            const dir = entry?.profileDir ?? defaultProfileDir(homedir(), platform)
            const profile = lineProfile(deps.profiles(), dir, platform)
            const timeoutMs = wake.wakeTimeoutSec * 1000
            if (entry && isFreed(entry)) {
              const freshSnap = await herdr.snapshot()
              const up = freshSnap.panes.find(p => p.agent === 'claude' && p.agent_session?.value === target.session)
              if (up) {
                pane = up.pane_id
                wokeHere = false
              } else {
                const was = entry.freed
                const name = entry.name || entry.title || ''
                const openedPane = await openTab(
                  tabs,
                  {
                    ...(was.workspace !== undefined && { workspace: was.workspace }),
                    ...(was.workspaceLabel !== undefined && { workspaceLabel: was.workspaceLabel }),
                    cwd: entry.cwd ?? '',
                    label: name || 'claude',
                    ...(was.tabLabel !== undefined && { tabLabel: was.tabLabel }),
                    ...(was.worktree && { worktree: was.worktree }),
                  },
                  freshSnap,
                )
                try {
                  follow.paneOpened(entry.session, openedPane)
                } catch (err) {
                  deps.log(`could not update the schedule: ${messageOf(err)}`)
                }
                const woke = await wakeInPane(
                  herdr,
                  { pane: openedPane, session: target.session, profile },
                  { ...timing, timeoutMs, platform, fresh: true },
                )
                if (!woke.ok) {
                  await herdr.rename(openedPane, `💤 ${name}`).catch(() => {})
                  return notWoken(openedPane, woke, topic, text => deps.log(text))
                }
                pane = woke.pane ?? openedPane
              }
            } else {
              const woke = await wakeInPane(
                herdr,
                { pane: target.pane, session: target.session, profile },
                { ...timing, timeoutMs, platform },
              )
              if (!woke.ok) return notWoken(target.pane, woke, topic, text => deps.log(text))
              pane = woke.pane ?? pane
              await herdr.rename(pane, null).catch(() => {})
            }
          }
          const r = await withPane(pane, () => deliverLive(herdr, pane, formatPrompt(items), timing))
          if (!('ok' in r)) return r
          deps.log(
            `delivered ${items.length} message(s) for ${first.key} to ${pane}${wokeHere ? ' after waking it' : ''}`,
          )
          deps.refresh?.()
          return wokeHere ? { ok: true, note: wokeNote(target.title) } : r
        })
        return { status: 200, body: { matched: true, result } }
      } catch (err) {
        deps.log(`node telegram delivery failed: ${messageOf(err)}`)
        return { status: 200, body: { matched: true, result: { retry: 30 } } }
      }
    },
  }
}
