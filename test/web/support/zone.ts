/** In another time zone for the length of `fn`: the board's day and clock follow `process.env.TZ`. */
export function inZone<T>(zone: string, fn: () => T): T {
  const was = process.env.TZ
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    process.env.TZ = was ?? 'UTC'
  }
}
