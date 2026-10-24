// The effort a Claude session is on now, from the line its /effort leaves on screen:
// "Set effort level to max (this session only): ...". The transcript has only the effort of a
// finished turn, and a session-only choice is not written to settings, so this is the live one.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function effortFromScreen(screen: unknown): string {
  const matches = [...String(screen ?? '').matchAll(/Set effort level to (low|medium|high|xhigh|max)\b/gi)]
  return matches.at(-1)?.[1]?.toLowerCase() ?? ''
}
