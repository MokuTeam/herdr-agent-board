// What the services need from the outside, built once per process by the entrypoints.
import { type ClaudeHome, defaultClaudeHome } from '../adapters/claude-home.ts'
import type { Config } from '../core/types.ts'
import { type SleepProvider, sharedHerdrWake } from '../integrations/herdr-wake.ts'

export interface Deps {
  /** The live config object (liveConfig updates it in place), so read it at call time. */
  cfg: Config
  claude: ClaudeHome
  /** herdr-wake for the config's current wakeUrl. */
  wake: SleepProvider
  log: (text: string) => void
}

export function defaultDeps(cfg: Config, log: (text: string) => void = () => {}): Deps {
  return {
    cfg,
    claude: defaultClaudeHome(),
    // A getter: a config reload that changes wakeUrl takes effect on the next call, as before.
    get wake() {
      return sharedHerdrWake(cfg.wakeUrl)
    },
    log,
  }
}
