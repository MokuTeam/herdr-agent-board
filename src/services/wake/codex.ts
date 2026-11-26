import { existsSync } from 'node:fs'
import { type CodexHome, createCodexHome } from '../../adapters/codex-home.ts'
import { cliWakeHerdr, type WakeHerdr } from '../../adapters/wake-herdr.ts'
import { isCodexSession } from '../../core/codex.ts'
import { codexDraft } from '../../core/dialogs/codex-input.ts'
import type { CodexOps } from './agy.ts'
import { defaultTabOps } from './tabs.ts'

export const codexWakeLine = (session: string): string | null =>
  isCodexSession(session) ? `board resume --codex ${session}` : null

export function defaultCodexOps(herdr: WakeHerdr = cliWakeHerdr, home: CodexHome = createCodexHome()): CodexOps {
  return {
    ...defaultTabOps(existsSync),
    herdr,
    codex: { line: codexWakeLine, draft: codexDraft },
    hasConversation: session => home.transcriptPath(session) !== null,
  }
}
