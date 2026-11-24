// A master's start in words (#504, docs/design/nodes 8): the blocker it waits on, why it stays on
// the device that has its folder, and why no device could take it, as the launch card says them
// (web/src/models/launch.ts) and spawn-agent prints them (core/launch/spawn-board.ts).
import type { Blocker, Refusal, Unfit } from '../placement.ts'
import type { PortableWhy } from '../portable.ts'
import type { Translator } from '../types.ts'

/** Device titles keyed by device id, or the payload's device rows. */
export type DeviceTitles = Readonly<Record<string, string>> | readonly { id: string; title: string }[]

function titleOf(id: string, titles?: DeviceTitles): string {
  if (!titles) return ''
  if (Array.isArray(titles)) return titles.find(d => d.id === id)?.title ?? ''
  return Object.hasOwn(titles, id) ? ((titles as Readonly<Record<string, string>>)[id] ?? '') : ''
}

/** A device as the launch card names it: `local` is this computer unless given a title of its own. */
export const deviceName = (id: string, t: Translator, titles?: DeviceTitles): string => {
  const custom = titleOf(id, titles)
  if (id === 'local') return custom && custom !== 'local' ? custom : t('place.local')
  return custom || id
}

/** What keeps a device from taking a start now (core/placement.ts Blocker), in words. */
export function blockerText(b: Blocker, t: Translator, titles?: DeviceTitles): string {
  const device = deviceName(b.device, t, titles)
  switch (b.kind) {
    case 'sessions':
      return t('place.blocker.sessions', { device, busy: b.busy, max: b.max })
    case 'memory':
      return t('place.blocker.memory', { device, free: Math.max(0, Math.round(b.freeMb)), need: b.needMb })
    case 'load':
      return t('place.blocker.load', { device, load: b.perCore.toFixed(2), max: b.max })
    default:
      return t(`place.blocker.${b.kind}`, { device })
  }
}

/** Why a start stays on the device that has its folder (core/portable.ts PortableWhy), in words. */
export function homeText(why: PortableWhy, t: Translator): string {
  if (why.kind === 'base-unpushed') return t('place.home.base-unpushed', { branch: why.branch })
  if (why.kind === 'local-path') return t('place.home.local-path', { path: why.path })
  if (why.kind === 'name') return t('place.home.name', { name: why.name })
  return t(`place.home.${why.kind}`)
}

function homeFix(why: PortableWhy, t: Translator): string {
  if (why.kind === 'base-unpushed') return t('place.homeFix.base-unpushed', { branch: why.branch })
  return t(`place.homeFix.${why.kind}`)
}

function unfitText(u: Unfit, t: Translator, titles?: DeviceTitles): string {
  const device = deviceName(u.device, t, titles)
  switch (u.kind) {
    case 'tags':
      return t('place.unfit.tags', { device, tags: u.missing.join(', ') })
    case 'no-profile':
    case 'not-logged-in':
      return t(`place.unfit.${u.kind}`, { device, profile: u.profile })
    case 'no-agent':
      return t('place.unfit.no-agent', { device, agent: u.agent })
    case 'commit':
      // An update on its way (#590): the device takes work once it runs this board's commit.
      return t(u.updating ? 'place.unfit.updating' : 'place.unfit.commit', { device })
    default:
      return t(`place.unfit.${u.kind}`, { device })
  }
}

const pinText = (pin: { device: string } | { tag: string }, t: Translator, titles?: DeviceTitles): string =>
  'device' in pin ? deviceName(pin.device, t, titles) : pin.tag

/** Why no device could ever take a start (core/placement.ts Refusal), in words. */
export function refusalText(r: Refusal, t: Translator, titles?: DeviceTitles): string {
  if (r.kind === 'no-device') return t('place.refuse.no-device', { pin: r.pin ? pinText(r.pin, t, titles) : '' })
  if (r.kind === 'unfit') {
    const list = r.devices.map(u => unfitText(u, t, titles)).join('; ')
    if (r.home)
      return t('place.refuse.home', {
        origin: deviceName(r.devices[0]?.device ?? 'local', t, titles),
        why: homeText(r.home, t),
        list,
        fix: homeFix(r.home, t),
      })
    return t('place.refuse.unfit', { list })
  }
  return t('place.refuse.pinned-away', {
    origin: deviceName(r.origin, t, titles),
    why: homeText(r.home, t),
    pin: pinText(r.pin, t, titles),
  })
}
