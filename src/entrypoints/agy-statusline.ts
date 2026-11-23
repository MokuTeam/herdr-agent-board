// Antigravity CLI's status line (`~/.gemini/antigravity-cli/settings.json` statusLine; installed by
// `board install --agy` when there is none, with `stack_with_default: true` so agy's own status bar
// stays intact). Antigravity pipes the live session state as JSON on stdin; this entrypoint saves
// only the validated quota windows to `agyUsageFile()` without model calls and never fails loudly.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { replaceFile } from '../adapters/json-store.ts'
import { agyUsageFile } from '../adapters/paths.ts'
import { readStdin } from '../adapters/stdin.ts'
import { digestAgyStatusLine } from '../core/agy-limits.ts'

async function main(): Promise<void> {
  const raw = await readStdin()
  const snapshot = digestAgyStatusLine(JSON.parse(raw || '{}'), Date.now())
  if (!snapshot) return
  const file = agyUsageFile()
  mkdirSync(dirname(file), { recursive: true })
  replaceFile(file, JSON.stringify(snapshot))
}

main().catch(() => {})
