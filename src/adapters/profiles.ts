// The Claude profiles on this computer (core/profiles.ts): the config folders found in the home
// folder, the one this process's environment points to, and the list config.json keeps of them.
// CLAUDE_CONFIG_DIR and the home folder are read here only, and only where no caller hands them in.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultProfileDir, mergeProfiles, type Profile, resolveProfileDir } from '../core/profiles.ts'
import { readConfigFile } from './config-file.ts'

export type Env = Record<string, string | undefined>

const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The Claude folders in use here: the default one first, then every ~/.claude-* folder by name,
 * each when it holds settings.json or projects/. mergeProfiles lists the default one even when it
 * is not found, and shows it then only when it is the board's own.
 */
export function findProfileDirs(home: string = homedir()): string[] {
  let names: string[] = []
  try {
    names = readdirSync(home)
  } catch {}
  const used = (dir: string): boolean =>
    isFolder(dir) && (isFile(join(dir, 'settings.json')) || isFolder(join(dir, 'projects')))
  const found = names
    .filter(name => /^\.claude-./i.test(name))
    .sort()
    .map(name => join(home, name))
  return [defaultProfileDir(home), ...found].filter(used)
}

/** The profile folder this process's environment points to (unset: ~/.claude). */
export function inheritedProfileDir(
  env: Env = process.env,
  home: string = homedir(),
  platform: string = process.platform,
): string {
  return resolveProfileDir(env.CLAUDE_CONFIG_DIR, home, platform)
}

/** config.json's `profiles` merged with the found folders; reads, never writes. */
export function loadProfiles(opts: { home?: string; shownDir?: string | null } = {}): Profile[] {
  const home = opts.home ?? homedir()
  return mergeProfiles(readConfigFile()?.profiles, findProfileDirs(home), home, opts.shownDir).list
}
