// A message's words, as the board's own messages are found in a session's transcript: by the web
// board's outbox (web/src/models/outbox.ts) and for a message's pictures (core/sent-pictures.ts). Pure, no imports.

/**
 * A message's words, to find what the board sent in what the transcript shows. On its way
 * Claude Code wraps pasted text in <pasted_content id="…"> tags, turns an image's path into
 * "[Image #1]", drops blank lines and can change a path (a pasted "\a" or "\t" is read as a
 * control character); a queued one, or one the thread's budget cut, comes clipped. So: no tags,
 * no image marks, no paths, one space between words.
 */
export function messageKey(text: unknown): string {
  return String(text ?? '')
    .replace(/<\/?pasted_content\b[^>]*>/g, ' ')
    .replace(/\[(?:Image|Pasted text) #\d+[^\]]*\]/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
