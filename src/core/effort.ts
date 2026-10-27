// The effort a Claude session is on now, from the line its /effort leaves on screen:
// "Set effort level to max (this session only): ...". The transcript has only the effort of a
// finished turn, and a session-only choice is not written to settings, so this is the live one.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function effortFromScreen(screen: unknown): string {
  const matches = [...String(screen ?? '').matchAll(/Set effort level to (low|medium|high|xhigh|max)\b/gi)]
  return matches.at(-1)?.[1]?.toLowerCase() ?? ''
}

/** The model the session is on now, from "Set model to Sonnet 5.5 and saved ..." or "… (this session only)". */
export function modelFromScreen(screen: unknown): string {
  const matches = [...String(screen ?? '').matchAll(/Set model to ([^\n]+?)(?= and saved| \(this session only\)|$)/gim)]
  return matches.at(-1)?.[1]?.trim() ?? ''
}

/**
 * Whether the meter reads the session's screen: a Claude session that is awake and has a pane. A
 * sleeping one may keep a pane that holds a shell by now; other agents have no such lines.
 */
export const meterReads = (item: {
  agent?: string | null | undefined
  sleeping?: boolean | undefined
  pane?: string | null | undefined
}): boolean => item.agent === 'claude' && !item.sleeping && !!item.pane

/** A message that changes what the meter shows: Claude's own /model or /effort. */
export const changesMeter = (text: unknown): boolean => /^\/(model|effort)(\s|$)/i.test(String(text ?? '').trim())
