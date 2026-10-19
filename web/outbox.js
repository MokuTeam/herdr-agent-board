// Messages the board sent that the session's thread does not show yet. Each one shows at once
// as a bubble of its own at the foot of the thread, and goes as soon as the transcript has it:
// in Claude Code's queue (the server's `queued`) or as a user line. Shared with the tests.

/**
 * A message's words, to find what the board sent in what the transcript shows. On its way
 * Claude Code wraps pasted text in <pasted_content id="…"> tags, turns an image's path into
 * "[Image #1]", drops blank lines and can change a path (a pasted "\a" or "\t" is read as a
 * control character); a long message comes clipped. So: no tags, no image marks, no paths, one
 * space between words.
 */
export function messageKey(text) {
  return String(text ?? '')
    .replace(/<\/?pasted_content\b[^>]*>/g, ' ')
    .replace(/\[(?:Image|Pasted text) #\d+[^\]]*\]/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether a message the transcript shows holds what the board sent (its key): the same words,
 * or more of them, since two messages typed in a row can reach Claude as one. A clipped one
 * ("…") is matched by its start.
 */
export function holds(shown, key) {
  if (!key) return false
  const words = messageKey(shown)
  if (` ${words} `.includes(` ${key} `)) return true
  const head = words.replace(/…$/, '').trim()
  return words.endsWith('…') && head.length >= 200 && key.startsWith(head)
}

/**
 * The words the board's message goes by: what was written, or with only files, the line that
 * names them (the text the server types is the message, then "Files:" and their paths).
 */
export const sentKey = (text, filesLabel) => messageKey(text) || messageKey(filesLabel)

/**
 * The board's messages still to show: a failed one until the user retries or takes it back,
 * any other until the transcript shows it after `after` (the newest moment the thread knew of
 * when it was sent), or, once sent, for `keepMs` at most.
 */
export function unsettled(entries, { conversation = [], queued = [] } = {}, now = Date.now(), keepMs = 30_000) {
  const shown = [...conversation.filter(m => m.role === 'user'), ...queued]
  return entries.filter(e => {
    if (e.state === 'failed') return true
    if (e.state === 'sent' && now - e.sentAt > keepMs) return false
    return !shown.some(m => m.at > e.after && holds(m.text, e.key))
  })
}

/** The newest moment a thread knows of: what a message sent now must come after. */
export const newestAt = detail => Math.max(0, ...[...(detail?.conversation ?? []), ...(detail?.queued ?? [])].map(m => m.at || 0))
