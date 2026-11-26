// Transition monitor for lost-access incidents (#632): notifies once when a session moves from
// "had access" to "lost it" (desktop notification, MokuPilot day session when present, and the
// parent session that started it via spawn-agent), never repeats while the state stays the same,
// and clears itself on the session's next successful turn.
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { allCards } from '../adapters/cards.ts'
import { notify } from '../adapters/herdr.ts'
import { isRecord, readJson, replaceFile } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import { addEntry } from '../adapters/schedule-store.ts'
import { t } from '../core/lang.ts'
import { inPane } from '../core/links.ts'
import { lostAccessLine, lostAccessSignature } from '../core/lost-access.ts'
import { parseNodeKey } from '../core/nodes.ts'
import type { Card, Item } from '../core/types.ts'

export const lostAccessFile = (): string => join(stateDir(), 'lost-access.json')

export interface LostAccessMonitor {
  /** Returns true when at least one session schedule entry was added. */
  observe(items: readonly Item[], now?: number): Promise<boolean>
}

export interface LostAccessOptions {
  log: (line: string) => void
  sendNotice?: (title: string, body: string) => Promise<void>
  deliverToSession?: (
    target: Item,
    text: string,
    now: number,
    from: { key: string; name: string },
    opts?: { noWake?: boolean },
  ) => void
  cards?: () => ReadonlyMap<string, Card>
  file?: string
}

const isState = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every(val => typeof val === 'string')

function findParent(item: Item, items: readonly Item[], cards: ReadonlyMap<string, Card>): Item | undefined {
  const ref = cards.get(item.key)?.parent
  if (typeof ref === 'string' && ref) {
    const pane = ref.startsWith('pane-') ? ref.slice(5) : ''
    const byCard = items.find(
      p => p.key !== item.key && (p.key === ref || p.session === ref || (pane ? inPane(p, pane) : false)),
    )
    if (byCard) return byCard
  }
  const from = item.links?.from
  if (from && !from.fork) {
    return items.find(p => p.key !== item.key && p.key === from.key)
  }
  return undefined
}

export function createLostAccessMonitor(opts: LostAccessOptions): LostAccessMonitor {
  const file = opts.file ?? lostAccessFile()
  const sendNotice = opts.sendNotice ?? notify
  const deliverToSession =
    opts.deliverToSession ??
    ((target, text, now, from, o) => {
      const local = !parseNodeKey(target.key)
      addEntry({
        key: target.key,
        name: target.name || target.autoName || target.key.slice(0, 8),
        ...(local && target.pane && { pane: target.pane }),
        ...(local && target.cwd && { cwd: target.cwd }),
        text,
        at: now,
        next: now,
        by: 'lost-access',
        from,
        ...(o?.noWake && { noWake: true }),
      })
    })
  const loadCards = opts.cards ?? allCards

  let loaded = false
  let active = new Map<string, string>()

  return {
    async observe(items, now = Date.now()) {
      // Fast path for setups with no active incidents and none on disk: zero reads, writes, or calls.
      if (!loaded && !existsSync(file) && !items.some(i => i.lostAccess)) return false

      if (!loaded) {
        loaded = true
        const saved = readJson(file, isState)
        if (saved) active = new Map(Object.entries(saved))
      }

      const byKey = new Map(items.map(i => [i.key, i]))
      let dirty = false
      for (const key of [...active.keys()]) {
        if (!byKey.get(key)?.lostAccess) {
          active.delete(key)
          dirty = true
        }
      }

      const fresh = items.filter(i => i.lostAccess && !active.has(i.key))
      let scheduled = false
      if (fresh.length) {
        let cardsMap: ReadonlyMap<string, Card> | null = null
        const getCards = (): ReadonlyMap<string, Card> => (cardsMap ??= loadCards())

        for (const item of fresh) {
          const access = item.lostAccess
          if (!access) continue
          active.set(item.key, lostAccessSignature(access))
          dirty = true
          if (item.sleeping) continue

          const label = item.name || item.autoName || item.key.slice(0, 8)
          const line = item.question || lostAccessLine(access, null, t, now)
          const msg = `${label} lost access: ${line}`
          const from = { key: item.key, name: label }

          try {
            await sendNotice(t('access.notifyTitle', { name: label }), line)
          } catch (err) {
            opts.log(`lost access notification: ${err instanceof Error ? err.message : String(err)}`)
          }

          const notified = new Set<string>()
          const day = items.find(i => i.day && i.key !== item.key && !i.lostAccess)
          if (day) {
            try {
              deliverToSession(day, msg, now, from)
              notified.add(day.key)
              scheduled = true
            } catch (err) {
              opts.log(`lost access day notice: ${err instanceof Error ? err.message : String(err)}`)
            }
          }

          const parent = findParent(item, items, getCards())
          if (parent && !notified.has(parent.key) && !parent.lostAccess) {
            try {
              deliverToSession(parent, msg, now, from, { noWake: true })
              scheduled = true
            } catch (err) {
              opts.log(`lost access parent notice: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }
      }

      if (dirty) {
        try {
          if (active.size) replaceFile(file, JSON.stringify(Object.fromEntries(active)), undefined, 0o600)
          else rmSync(file, { force: true })
        } catch (err) {
          opts.log(`lost access state: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return scheduled
    },
  }
}
