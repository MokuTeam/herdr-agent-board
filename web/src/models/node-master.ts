// Local board redirect and banner decisions for a node (#744): pure, browser-safe logic.
import { isDevice, validMasterUrl } from '../../../src/core/node-key.ts'
import type { NodeMasterPayload } from '../../../src/core/payload.ts'
import { sessionInHash } from './reveal.ts'
import { threadInHash } from './work-threads.ts'

export const STAY_LOCAL_KEY = 'agent-board:stay-local'

export interface SessionStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStore(): SessionStore | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    return null
  }
}

/**
 * Whether this tab chose to stay on the node's local board (`?local=1`).
 * `?local=1` persists in sessionStorage for the tab; `?local=0` clears it.
 */
export function readStayLocal(
  search: string = typeof location !== 'undefined' ? location.search : '',
  store: SessionStore | null = defaultStore(),
): boolean {
  try {
    const param = new URLSearchParams(search).get('local')
    if (param === '1') {
      try {
        store?.setItem(STAY_LOCAL_KEY, '1')
      } catch {}
      return true
    }
    if (param === '0') {
      try {
        store?.removeItem(STAY_LOCAL_KEY)
      } catch {}
      return false
    }
    return store?.getItem(STAY_LOCAL_KEY) === '1'
  } catch {
    return false
  }
}

export type NodeMasterAction =
  | { kind: 'redirect'; url: string }
  | { kind: 'banner'; nodeId: string; masterName: string; url: string | null; offline: boolean }

export interface NodeMasterOptions {
  remote?: boolean
  stayLocal?: boolean
  currentOrigin?: string
  /** The address the node's page was opened at: its deep link goes along with a redirect (#837). */
  opened?: OpenedAt | null
}

/** What of a page's address a redirect looks at (#837). */
export interface OpenedAt {
  pathname: string
  hash: string
}

const UNPRINTABLE = /\p{Cc}/u

/**
 * The deep link of a node's page as the master's board reads it (#837), or '' for none: only the
 * board's own routes on its own page (`/`), `#thread=<key>` as it is and `#session=<key>` (a
 * notification clicked, web-open.ts) with the key the master knows this node's session by
 * (`@<node>:<key>`). No query (`local`, `confirm` are this computer's), no other path or hash.
 */
export function masterDeepLink(opened: OpenedAt | null | undefined, nodeId: string): string {
  if (opened?.pathname !== '/' || !opened.hash.startsWith('#')) return ''
  const thread = threadInHash(opened.hash)
  if (thread) return `#thread=${encodeURIComponent(thread)}`
  const session = sessionInHash(opened.hash) ?? ''
  // A key this node made never starts with "@" (core/node-key.ts parseNodeKey): one that does is no session here.
  if (!session || session.startsWith('@') || session.length > 512 || UNPRINTABLE.test(session) || !isDevice(nodeId))
    return ''
  return `#session=${encodeURIComponent(`@${nodeId}:${session}`)}`
}

/** The master's board URL with the opened page's deep link (#837); the URL as it was without one. */
function withDeepLink(url: string, link: string): string {
  if (!link) return url
  try {
    const u = new URL(url)
    u.hash = link
    return u.href
  } catch {
    return url
  }
}

/**
 * Decides whether a node's local web board should redirect to the master's public board URL or
 * stay local with a quiet banner (#744). Returns null on standalone, master, or remote pages.
 */
export function nodeMasterAction(
  nodeMaster: NodeMasterPayload | undefined,
  options: NodeMasterOptions = {},
): NodeMasterAction | null {
  if (options.remote || !nodeMaster) return null
  const validated = validMasterUrl(nodeMaster.url)
  const origin = options.currentOrigin ?? (typeof location !== 'undefined' ? location.origin : '')
  let target = validated
  if (target && origin) {
    try {
      if (new URL(target).origin === origin) target = null
    } catch {
      target = null
    }
  }
  if (nodeMaster.online && target && !options.stayLocal) {
    return { kind: 'redirect', url: withDeepLink(target, masterDeepLink(options.opened, nodeMaster.nodeId)) }
  }
  return {
    kind: 'banner',
    nodeId: nodeMaster.nodeId,
    masterName: nodeMaster.name,
    url: target,
    offline: !nodeMaster.online,
  }
}
