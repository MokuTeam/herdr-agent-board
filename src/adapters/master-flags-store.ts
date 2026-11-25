// A node's copy of its master's feature flags (#775, core/master-flags.ts): <state>/node/master-flags.json,
// beside the node's own files, never in config.json. Written by the node's board when its master
// sends them (services/node/master-flags.ts); read by its `board` command and its hooks. A board
// without `node` reads nothing here.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../core/lang.ts'
import { type MasterFlags, masterFlagsOf } from '../core/master-flags.ts'
import { readJson, replaceFile } from './json-store.ts'
import { nodeDir } from './paths.ts'

export const masterFlagsFile = (): string => join(nodeDir(), 'master-flags.json')

/** The flags as they last came, or null: none yet, or a file that does not read. */
export const readMasterFlags = (): MasterFlags | null =>
  masterFlagsOf(readJson(masterFlagsFile(), (v): v is unknown => true))

export function writeMasterFlags(flags: MasterFlags): void {
  mkdirSync(nodeDir(), { recursive: true })
  replaceFile(masterFlagsFile(), `${JSON.stringify(flags, null, 2)}\n`)
}

/**
 * A Settings write of a master-owned feature on a node (#775): refused, naming the master, as the
 * node's config.json is not where it is set. Null where config.json (`raw`) has no `node`.
 */
export function masterOwnedEdit(
  raw: Record<string, unknown> | null,
): { ok: false; error: string; code: 'masterOwned' } | null {
  if (typeof raw?.node !== 'object' || raw.node === null) return null
  const name = readMasterFlags()?.master
  return { ok: false, code: 'masterOwned', error: name ? t('node.masterOwned', { name }) : t('node.masterOwnedNone') }
}

/** A node's flags: only where config.json has `node` (an object); anything else reads nothing. */
export const nodeMasterFlags = (cfg: { node?: unknown }): MasterFlags | null =>
  typeof cfg.node === 'object' && cfg.node !== null ? readMasterFlags() : null
