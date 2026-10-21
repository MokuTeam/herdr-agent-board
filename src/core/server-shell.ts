// Shell words for the server's scripts. No node: import.
/** One shell word: '…' with ' as '\''. Throws on a newline or NUL: callers check values first. */
export function shQuote(s: string): string {
  if (/[\n\r\0]/.test(s)) throw new Error('a newline or NUL cannot reach the server')
  return `'${s.replaceAll("'", `'\\''`)}'`
}
export const isContainerId = (s: string): boolean => /^[0-9a-f]{64}$/.test(s)
/** Absolute, with no newline, NUL or `..` part. */
export const isPlainPath = (s: string): boolean =>
  s.startsWith('/') && !/[\n\r\0]/.test(s) && !s.split('/').includes('..')
export const isUnitName = (s: string): boolean => /^[A-Za-z0-9@._-]+\.service$/.test(s)
