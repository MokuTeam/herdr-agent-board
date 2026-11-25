// Local board redirect and banner decisions for a node (#744): pure, browser-safe logic.
import { validMasterUrl } from '../../../src/core/node-key.ts'
import type { NodeMasterPayload } from '../../../src/core/payload.ts'

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
    return { kind: 'redirect', url: target }
  }
  return {
    kind: 'banner',
    nodeId: nodeMaster.nodeId,
    masterName: nodeMaster.name,
    url: target,
    offline: !nodeMaster.online,
  }
}
