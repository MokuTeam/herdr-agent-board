// Install from the Profiles panel: the board's hooks and status line into one profile's
// settings.json, as the install action writes them into every shown profile
// (adapters/hook-settings.ts). Only into a shown profile, and only into a folder that is there.
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EditResult } from '../adapters/config-file.ts'
import { installInto } from '../adapters/hook-settings.ts'
import { ROOT } from '../adapters/paths.ts'
import type { InstallPaths } from '../core/install-plan.ts'
import { t } from '../core/lang.ts'
import { boardFiles } from '../core/setup.ts'
import type { Deps } from './deps.ts'

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The board's hooks and status line into the shown profile `id`, running the Bun that runs the board. */
export function installProfile(deps: Pick<Deps, 'profiles'>, id: string): EditResult {
  const profile = deps.profiles().list.find(p => p.id === id)
  if (!profile) return { ok: false, error: t('err.profile.missing', { id }) }
  if (profile.hidden) return { ok: false, error: t('err.profile.hiddenInstall', { title: profile.title }) }
  if (!isFolder(profile.dir)) return { ok: false, error: t('err.profile.noFolder', { path: profile.dir }) }
  // The paths as the install action has them; the commands' folder is the install action's alone.
  const paths: InstallPaths = { bun: process.execPath, ...boardFiles(ROOT), binDir: join(homedir(), '.local', 'bin') }
  const out = installInto(profile.dir, paths)
  return out.ok ? { ok: true } : { ok: false, error: out.error }
}
