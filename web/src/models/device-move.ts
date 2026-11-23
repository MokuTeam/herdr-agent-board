// A session moved to another device from its card's menu (#616): POST /api/move with `device`, as
// `board move --device` moves it (src/services/nodes/move-device.ts), and what the toast says of it.
// First what the move would take is asked (`dryRun`): a folder that does not travel is said at
// once, and uncommitted changes that would go with it are listed in a toast whose "Move with them"
// moves it; with none it moves at once. The card shows "Moving to <device>…" while its files cross
// and its start there is waited for; the toast says where it runs now, or why it stays.
import type { MoveDeps } from './profile-move.ts'

/** One target as POST /api/move answers a device move, as far as the page reads it. */
interface DeviceResult {
  target: string
  result: 'moved' | 'refused' | 'plan'
  why?: string
  plan?: { changes?: { path: string }[]; deleted?: string[] }
}

const isResult = (v: unknown): v is DeviceResult =>
  typeof v === 'object' && v !== null && typeof (v as DeviceResult).target === 'string'

type Deps = Pick<MoveDeps, 't' | 'post' | 'errorText' | 'toast' | 'busy' | 'name'>

/** At most this many changed paths named in the toast; the count says the rest. */
const NAMED = 5

/** POST /api/move for one card: its outcome, or a toast with the call's error and undefined. */
async function ask(deps: Deps, key: string, device: string, dryRun: boolean): Promise<DeviceResult | undefined> {
  try {
    const reply = await deps.post('/api/move', { targets: [key], device, ...(dryRun && { dryRun: true }) })
    return (Array.isArray(reply.results) ? reply.results.filter(isResult) : [])[0]
  } catch (err) {
    deps.toast(deps.errorText(err), true)
    return undefined
  }
}

/** The move itself, the card busy meanwhile. */
async function go(deps: Deps, key: string, device: string, title: string): Promise<void> {
  const t = deps.t()
  const name = deps.name(key)
  deps.busy(key, t('moveDevice.busy', { device: title }))
  let one: DeviceResult | undefined
  try {
    one = await ask(deps, key, device, false)
  } finally {
    deps.busy(key, null)
  }
  if (!one) return
  if (one.result === 'moved') return deps.toast(t('moveDevice.done', { name, device: title }))
  deps.toast(t('move.refused', { name, why: one.why ?? '' }), true)
}

/** A card's session to the device `device` (its title `title`): asked first, then moved, or its changes shown first. */
export async function moveCardToDevice(deps: Deps, key: string, device: string, title: string): Promise<void> {
  const t = deps.t()
  const name = deps.name(key)
  const plan = await ask(deps, key, device, true)
  if (!plan) return
  if (plan.result === 'refused') return deps.toast(t('move.refused', { name, why: plan.why ?? '' }), true)
  const paths = [...(plan.plan?.changes ?? []).map(c => c.path), ...(plan.plan?.deleted ?? [])]
  if (!paths.length) return go(deps, key, device, title)
  const list = paths.slice(0, NAMED).join(', ') + (paths.length > NAMED ? ', …' : '')
  deps.toast(t('moveDevice.changes', { name, device: title, n: paths.length, list }), false, {
    action: { label: t('moveDevice.go'), run: () => void go(deps, key, device, title) },
  })
}
