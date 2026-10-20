// Install from the Profiles panel: the board's hooks and status line into one profile's
// settings.json, the agents' skill into its skills folder, and herdr's own Claude hook (herdr
// writes it), as the install action puts them into every shown profile (adapters/hook-settings.ts,
// adapters/agents-skill.ts, adapters/herdr.ts). Only into a shown profile, and only into a folder
// that is there.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installSkill } from '../adapters/agents-skill.ts'
import type { EditResult } from '../adapters/config-file.ts'
import { claudeIntegrationInstall } from '../adapters/herdr.ts'
import { installInto } from '../adapters/hook-settings.ts'
import { ROOT } from '../adapters/paths.ts'
import { readText } from '../adapters/setup-facts.ts'
import type { InstallPaths } from '../core/install-plan.ts'
import { t } from '../core/lang.ts'
import { boardFiles } from '../core/setup.ts'
import type { Deps } from './deps.ts'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const firstLine = (text: string): string => text.split(/\r?\n/)[0] ?? ''
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The board's hooks and status line into the shown profile `id`, running the Bun that runs the
 * board, then the agents' skill (someone else's of that name stays), then herdr's own Claude hook:
 * a herdr that cannot write it leaves the rest in, and the answer says so.
 */
export async function installProfile(deps: Pick<Deps, 'profiles'>, id: string): Promise<EditResult> {
  const profile = deps.profiles().list.find(p => p.id === id)
  if (!profile) return { ok: false, error: t('err.profile.missing', { id }) }
  if (profile.hidden) return { ok: false, error: t('err.profile.hiddenInstall', { title: profile.title }) }
  if (!isFolder(profile.dir)) return { ok: false, error: t('err.profile.noFolder', { path: profile.dir }) }
  // The paths as the install action has them; the commands' folder is the install action's alone.
  const files = boardFiles(ROOT)
  const paths: InstallPaths = { bun: process.execPath, ...files, binDir: join(homedir(), '.local', 'bin') }
  const out = installInto(profile.dir, paths)
  if (!out.ok) return { ok: false, error: out.error }
  const skill = readText(files.skill)
  try {
    if (skill !== null) installSkill(profile.dir, skill)
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
  try {
    await claudeIntegrationInstall(profile.dir)
  } catch (err) {
    return { ok: false, error: t('err.profile.herdrHook', { title: profile.title, error: firstLine(messageOf(err)) }) }
  }
  return { ok: true }
}
