// What the services need from the outside, built once per process by the entrypoints.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ClaudeHome } from '../adapters/claude-home.ts'
import { type CodexHome, createCodexHome } from '../adapters/codex-home.ts'
import { localFetch } from '../adapters/local-key.ts'
import { createPiHome, type PiHome } from '../adapters/pi-home.ts'
import { createProfileHomes, type ProfileHomes } from '../adapters/profile-homes.ts'
import { findProfileDirs, inheritedProfileDir } from '../adapters/profiles.ts'
import { wakePiFile, wakeSessionsFile } from '../adapters/wake-files.ts'
import { onServer } from '../core/on-server.ts'
import { mergeProfiles, type ProfileSet, profileSet } from '../core/profiles.ts'
import type { Config } from '../core/types.ts'
import { type SleepProvider, sharedHerdrWake } from '../integrations/herdr-wake.ts'
import { sharedBoardWake, sharedFileSleepers } from '../integrations/wake.ts'
import { currentWakeMode } from './wake/mode.ts'

export interface Deps {
  /** The live config object (liveConfig updates it in place), so read it at call time. */
  cfg: Config
  /** The home of the profile this process's env points to (its own sessions, by default). */
  claude: ClaudeHome
  /** Every profile folder's home, one per folder. */
  homes: ProfileHomes
  /** What pi records about its sessions (their session files). */
  pi: PiHome
  /** Codex rollouts, looked up only for panes herdr reports as codex. */
  codex: CodexHome
  /** The profiles: config.json's merged with the folders found; read again when they change, or after a minute. */
  profiles(): ProfileSet
  /**
   * The wake the board talks to (services/wake/mode.ts): the new one (integrations/wake.ts) while it
   * is on and its start ran; else herdr-wake at the config's current wakeUrl, as today, with the
   * sleepers wake's session file still has while wake is off.
   */
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
    codex: createCodexHome(),
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
    // A getter: a config reload that changes wakeUrl or the wake section takes effect on the next
    // call, as before. One provider per kind, url and file, so a forget() reaches the list every
    // caller shares; with wake off and no wake file, today's own. On the board's own server the
    // new wake's takes the board's local key (adapters/local-key.ts).
    get wake() {
      const mode = currentWakeMode(cfg)
      if (mode.kind === 'new')
        return onServer(cfg)
          ? sharedBoardWake(mode.url, wakeSessionsFile(), localFetch(cfg))
          : sharedBoardWake(mode.url, wakeSessionsFile())
      const old = sharedHerdrWake(cfg.wakeUrl)
      const file = wakeSessionsFile()
      // pi's sleepers keep their cards too (#178), from wake's pi file beside it.
      const asleep = !mode.on && (existsSync(file) || existsSync(wakePiFile()))
      return asleep ? sharedFileSleepers(old, file) : old
    },
    log,
  }
}
