// Codex hooks use the same matcher groups as Claude, but live in their own hooks.json.
import { BOARD_EVENTS, normPath, quote, withOurHook } from './install-plan.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function planCodexHooks(settings: unknown, script: string): Record<string, unknown> {
  if (settings !== undefined && !isRecord(settings)) throw new Error('hooks.json is not a JSON object; left as it was')
  const next: Record<string, unknown> = structuredClone(settings ?? {})
  if (next.hooks !== undefined && !isRecord(next.hooks))
    throw new Error('hooks.json hooks is not an object; left as it was')
  const hooks = isRecord(next.hooks) ? next.hooks : {}
  next.hooks = hooks
  const ours = (command: string): boolean =>
    /agent-board.*[\\/]entrypoints[\\/]codex-hook\.ts/.test(command) || normPath(command).includes(normPath(script))
  // Codex runs Windows commands through a shell; a quoted executable path can be misparsed.
  const command = `bun ${quote(script)}`
  const hook = { hooks: [{ type: 'command', command, timeout: 10 }] }
  for (const event of BOARD_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event]))
      throw new Error(`hooks.json ${event} is not a list; left as it was`)
    const entries = hooks[event]
    if (
      Array.isArray(entries) &&
      entries.some(
        e =>
          isRecord(e) &&
          Array.isArray(e.hooks) &&
          e.hooks.some(h => isRecord(h) && h.type === 'command' && h.command === command),
      )
    )
      continue
    hooks[event] = withOurHook(hooks[event], hook, ours, [])
  }
  return next
}
