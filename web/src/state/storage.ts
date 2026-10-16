// The page's own settings in localStorage, which may be missing or refuse (a private window):
// a read falls back, a write is dropped.
export const storage = {
  get(key: string, fallback: string): string {
    try {
      return localStorage.getItem(key) ?? fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {}
  },
}
