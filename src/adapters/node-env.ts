// A node's env file per profile (#507, docs/design/nodes 7.2, 10 item 4): `<state>/node/env/<profile>.env`,
// written by a file sink in `env` format, read for a launch, spawn-agent and `board resume` on a board
// with `node`. Values are never logged: a refused name is said by its name alone.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EnvMap, parseEnvFile } from '../core/node-env.ts'
import { nodeDir } from './node-store.ts'

/** The env file of a profile on a node. */
export const nodeEnvFile = (profile: string): string => join(nodeDir(), 'env', `${profile}.env`)

/** A profile's id as one file name: no separator, no dots alone, nothing Windows refuses in a name. */
const fileNamed = (profile: string): boolean =>
  /^[^\\/:*?"<>|\0]{1,64}$/.test(profile) && !/^\.+$/.test(profile) && profile.trim() === profile

/**
 * The profile's env file read, or null when there is none. A name the board keeps for itself is
 * left out and said through `log`, as is a file that is there but cannot be read (by its code) and a
 * profile whose id is no file name.
 */
export function readNodeEnv(profile: string, log: (text: string) => void): EnvMap | null {
  if (!fileNamed(profile)) {
    log(`node env: the profile id ${JSON.stringify(profile)} is no file name: no env file read`)
    return null
  }
  let text: string
  try {
    text = readFileSync(nodeEnvFile(profile), 'utf8')
  } catch (err) {
    const code = (err as { code?: unknown })?.code
    if (code !== 'ENOENT') log(`node env: ${profile}.env not read: ${typeof code === 'string' ? code : 'error'}`)
    return null
  }
  const { vars, refused } = parseEnvFile(text)
  for (const name of refused) log(`node env: ${name} in ${profile}.env is set by the board itself: left out`)
  return vars
}
