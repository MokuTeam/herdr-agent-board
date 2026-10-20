// The board in a phone's browser as an app (src/core/pwa.ts), once the page starts: the service
// worker (web/sw.js) that keeps the page's own files for when there is no connection, and the
// color of the phone's status bar, which follows the board's light or dark.

export function startPhoneApp(): void {
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('sw.js').catch(() => {})
  followThemeColor()
}

/** One theme-color, the board's background as it is now: the system's, or the one picked in Settings. */
function followThemeColor(): void {
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
  const [meta, ...rest] = metas
  if (!meta) return
  for (const m of rest) m.remove()
  meta.removeAttribute('media')
  const sync = () => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    if (color) meta.content = color
  }
  sync()
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync)
}
