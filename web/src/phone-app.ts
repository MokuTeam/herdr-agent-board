// The board in a phone's browser as an app (src/core/pwa.ts), once the page starts: the service
// worker (web/sw.js) that keeps the page's own files for when there is no connection, the color
// of the phone's status bar, which follows the board's light or dark, and what goes wrong on the
// page, which goes to the board's log (models/page-errors.ts): nobody sees the phone's console.
import { pageLog } from './api/client.ts'
import { buildOf, errorReporter, watchPageErrors } from './models/page-errors.ts'

export function startPhoneApp(): void {
  watchPageErrors(window, reportPageError)
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('sw.js').catch(() => {})
  followThemeColor()
  noteStart()
}

/** Which build of the page's script runs: the phone's page names it (app.js?v=<build>, core/pwa.ts). */
const pageBuild = (): string => buildOf(document.querySelector<HTMLScriptElement>('script[src*="app.js"]')?.src)

/** An error on the phone's page, into the board's log, once (components/ErrorBoundary.tsx, watchPageErrors). */
export const reportPageError = errorReporter(pageLog, () => ({ userAgent: navigator.userAgent, build: pageBuild() }))

/**
 * A page that started over (a reload, or the system took it back, as Android may while the camera
 * runs) goes in the board's log: a file being picked then is lost with the page (#102). The draft's
 * text is kept anyway (models/drafts.ts).
 */
function noteStart(): void {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const discarded = (document as { wasDiscarded?: boolean }).wasDiscarded === true
  if (discarded || nav?.type === 'reload')
    pageLog(`started over (${discarded ? 'discarded by the system' : 'reloaded'}), build ${pageBuild()}`)
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
