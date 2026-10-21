// Install from the Profiles panel: the board's hooks and status line (wake's too while wake is on)
// into one profile's settings.json, the agents' skill into its skills folder, and herdr's own
// Claude hook (herdr writes it), as the install action puts them into every shown profile
// (adapters/hook-settings.ts, adapters/agents-skill.ts, adapters/herdr.ts). Only into a shown
// profile, and only into a folder that is there. The panel's edits go through here too: one that
// shows a hidden profile installs into it at once.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installSkill } from '../adapters/agents-skill.ts'
import { configFile, type EditResult, editProfiles, readConfigFile } from '../adapters/config-file.ts'
import { claudeIntegrationInstall } from '../adapters/herdr.ts'
import { herdrHookInstalled, hooksInstalled, installInto } from '../adapters/hook-settings.ts'
import { isRecord } from '../adapters/json-store.ts'
import { ROOT } from '../adapters/paths.ts'
import { loadProfiles } from '../adapters/profiles.ts'
import { readText } from '../adapters/setup-facts.ts'
import type { InstallPaths } from '../core/install-plan.ts'
import { t } from '../core/lang.ts'
import type { Profile } from '../core/profiles.ts'
import { boardFiles } from '../core/setup.ts'
import { wakeSwitch } from '../core/wake/config.ts'
import type { Deps } from './deps.ts'

// The files of this copy of the board: a profile's settings.json has its hooks when they run these.
const FILES = boardFiles(ROOT)
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
 * This copy's hooks and herdr's own are in the settings.json of the profile folder `dir`: the
 * Profiles panel offers no Install for it.
 */
export const hooksInPlace = (dir: string): boolean => hooksInstalled(dir, FILES) && herdrHookInstalled(dir)

/**
 * The board's hooks and status line into the shown profile `id`, running the Bun that runs the
 * board, then the agents' skill (someone else's of that name stays), then herdr's own Claude hook:
 * a herdr that cannot write it leaves the rest in, and the answer says so.
 */
export async function installProfile(deps: Pick<Deps, 'profiles'>, id: string): Promise<EditResult> {
  const profile = deps.profiles().list.find(p => p.id === id)
  if (!profile) return { ok: false, error: t('err.profile.missing', { id }) }
  if (profile.hidden) return { ok: false, error: t('err.profile.hiddenInstall', { title: profile.title }) }
  return installShown(profile)
}

/** installProfile's install, into a profile that is shown. */
async function installShown(profile: Profile): Promise<EditResult> {
  if (!isFolder(profile.dir)) return { ok: false, error: t('err.profile.noFolder', { path: profile.dir }) }
  // The paths as the install action has them; the commands' folder is the install action's alone.
  const paths: InstallPaths & { wakeHook: string } = {
    bun: process.execPath,
    ...FILES,
    binDir: join(homedir(), '.local', 'bin'),
  }
  // Wake's hooks too while config.json says wake is on, as the install action reads it (#119).
  const wake = wakeSwitch({ exists: existsSync(configFile()), raw: readConfigFile() })
  const out = installInto(profile.dir, paths, { wake })
  if (!out.ok) return { ok: false, error: out.error }
  const skill = readText(FILES.skill)
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

/**
 * A Profiles panel edit (adapters/config-file.ts editProfiles). One that shows a hidden profile
 * then installs into it as Install does, unless its hooks and herdr's are in already, and
 * `installed` runs after that install. The show stays saved whatever the install answers; what
 * the install could not do is the answer, as Install's own.
 */
export async function editProfile(body: unknown, installed: () => void): Promise<EditResult> {
  const showing = isRecord(body) && body.op === 'update' && body.hidden === false ? body.id : undefined
  // Hidden or not as config.json has it, which the edit reads and writes; the live config
  // (deps.profiles) follows it only when its watcher has read it again.
  const was = showing === undefined ? undefined : loadProfiles().find(p => p.id === showing)
  const done = editProfiles(body)
  if (!done.ok || !was?.hidden) return done
  const profile = loadProfiles().find(p => p.id === showing)
  if (!profile || profile.hidden || hooksInPlace(profile.dir)) return done
  const out = await installShown(profile)
  installed()
  return out
}
