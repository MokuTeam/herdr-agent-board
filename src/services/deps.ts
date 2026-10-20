// What the services need from the outside, built once per process by the entrypoints.
import { homedir } from 'node:os'
import type { ClaudeHome } from '../adapters/claude-home.ts'
import { createPiHome, type PiHome } from '../adapters/pi-home.ts'
import { createProfileHomes, type ProfileHomes } from '../adapters/profile-homes.ts'
import { findProfileDirs, inheritedProfileDir } from '../adapters/profiles.ts'
import { mergeProfiles, type ProfileSet, profileSet } from '../core/profiles.ts'
import type { Config } from '../core/types.ts'
import { type SleepProvider, sharedHerdrWake } from '../integrations/herdr-wake.ts'

export interface Deps {
  /** The live config object (liveConfig updates it in place), so read it at call time. */
  cfg: Config
  /** The home of the profile this process's env points to (its own sessions, by default). */
  claude: ClaudeHome
  /** Every profile folder's home, one per folder. */
  homes: ProfileHomes
  /** What pi records about its sessions (their session files). */
  pi: PiHome
  /** The profiles: config.json's merged with the folders found; read again when they change, or after a minute. */
  profiles(): ProfileSet
  /** herdr-wake for the config's current wakeUrl. */
  wake: SleepProvider
  log: (text: string) => void
}

export function defaultDeps(cfg: Config, log: (text: string) => void = () => {}): Deps {
  const inheritedDir = inheritedProfileDir()
  const homes = createProfileHomes()
  let profiles: { at: number; listed: string; set: ProfileSet } | null = null
  return {
    cfg,
    claude: homes.forDir(inheritedDir),
    homes,
    pi: createPiHome(),
    profiles() {
      // A folder made or removed in the home folder shows within a minute; an edit at once.
      const listed = JSON.stringify(cfg.profiles ?? null)
      if (!profiles || profiles.listed !== listed || Date.now() - profiles.at > 60_000) {
        const home = homedir()
        const { list } = mergeProfiles(cfg.profiles, findProfileDirs(home), home, inheritedDir)
        profiles = { at: Date.now(), listed, set: profileSet(list, inheritedDir) }
      }
      return profiles.set
    },
    // A getter: a config reload that changes wakeUrl takes effect on the next call, as before.
    get wake() {
      return sharedHerdrWake(cfg.wakeUrl)
    },
    log,
  }
}
