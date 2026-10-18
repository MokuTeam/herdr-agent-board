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

/** The default folder first (always, there or not), then every ~/.claude-* folder holding settings.json or projects/, by name. */
export function findProfileDirs(home: string = homedir()): string[] {
  let names: string[] = []
  try {
    names = readdirSync(home)
  } catch {}
  const found = names
    .filter(name => /^\.claude-./i.test(name))
    .sort()
    .map(name => join(home, name))
    .filter(dir => isFolder(dir) && (isFile(join(dir, 'settings.json')) || isFolder(join(dir, 'projects'))))
  return [defaultProfileDir(home), ...found]
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
