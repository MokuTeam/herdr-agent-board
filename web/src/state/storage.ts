// The page's own settings in localStorage, which may be missing or refuse (a private window):
// a read falls back, a write is dropped.
export const storage = {
  /** The value saved under `key`, else null. */
  read(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  get(key: string, fallback: string): string {
    return storage.read(key) ?? fallback
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {}
  },
}
