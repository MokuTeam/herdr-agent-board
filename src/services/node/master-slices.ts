// A node's copy of its master's time, calendar, journal and presence for its own page (#780, epic
// #763 T4a; since #786 Team's numbers and the devices too; the parts: core/board-slices.ts). While the
// master holds its relay stream here and has sent its flags, the node asks GET /api/board-slices over the relay every little while
// (paced), and once at once when the master's flags change; a change refreshes the payload. The
// last parts stay while the master is away: the page keeps its panels, whose calls answer 503 and
// whose banner (#744) says the master is offline; a master whose owner turned this computer off
// (`owner: false`) leaves none. Made by server/app.ts only once config.json has
// `node`; nothing of it runs on any other board.
import { pace } from '../../adapters/pacing.ts'
import { type BoardSlices, boardSlicesOf } from '../../core/board-slices.ts'
import type { MasterFlags } from '../../core/master-flags.ts'
import { BOARD_SLICES_PATH, RELAY_ERRORS } from '../../core/master-relay.ts'
import type { MasterRelay } from './master-relay.ts'

export interface NodeMasterSlices {
  /** The parts as the master last gave them; null before it has, or while it has none of them on. */
  current(): BoardSlices | null
  /** Asks the master now (its flags changed). */
  poke(): void
  close(): void
}

export interface NodeMasterSlicesDeps {
  relay: Pick<MasterRelay, 'relay' | 'online'>
  /** The master's flags as the node keeps them (services/node/master-flags.ts). */
  flags(): MasterFlags | null
  /** The parts changed: the payload goes out again. */
  changed(): void
  log(text: string): void
  everyMs?: number
}

const EVERY_MS = 15_000

export function createNodeMasterSlices(deps: NodeMasterSlicesDeps): NodeMasterSlices {
  let last: BoardSlices | null = null
  let lastText = 'null'
  let asking = false
  /** Poked while a question was out: its answer may be older than what poked, so ask again. */
  let again = false
  let closed = false

  // Since #786 the master's devices come with them, which every master of a node has: asked once
  // its flags came, whatever features it has on.
  const wanted = (): boolean => deps.flags() !== null

  function take(next: BoardSlices | null): void {
    const text = JSON.stringify(next)
    if (text === lastText) return
    last = next
    lastText = text
    deps.changed()
  }

  async function ask(): Promise<void> {
    if (closed || !deps.relay.online()) return
    if (asking) {
      again = true
      return
    }
    // No flags from the master yet: none on show here.
    if (!wanted()) return take(null)
    asking = true
    try {
      const res = await deps.relay.relay(new Request(`http://127.0.0.1${BOARD_SLICES_PATH}`), {
        rawPath: BOARD_SLICES_PATH,
        search: '',
        remote: false,
        refuse: () => null,
      })
      if (!res) return
      const body: unknown = await res.json().catch(() => null)
      // The master's owner turned this computer off (`owner: false`): none of its parts on show here.
      if (res.status === 403 && (body as { error?: unknown } | null)?.error === RELAY_ERRORS.owner) return take(null)
      // A master that does not give them yet (an older version) or is away: the last ones stay.
      const slices = res.ok ? boardSlicesOf(body) : null
      if (slices && !closed) take(Object.keys(slices).length ? slices : null)
    } catch (err) {
      deps.log(`master slices: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      asking = false
      if (again && !closed) {
        again = false
        void ask()
      }
    }
  }

  const timer = setInterval(() => void ask(), Math.max(50, Math.round((deps.everyMs ?? EVERY_MS) * pace())))

  return {
    current: () => last,
    poke: () => void ask(),
    close() {
      closed = true
      clearInterval(timer)
    },
  }
}
