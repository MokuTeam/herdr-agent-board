// The dot in the toolbar. An open connection alone does not mean fresh herdr data: green only
// after a successful refresh; orange while waiting for the first one or after a failed one,
// with the time of the last good data. `t` is the page's translator (src/core/i18n/translator.ts).
import type { Translator } from '../../../src/core/i18n/translator.ts'

export type LiveData = { stale: boolean; lastSuccessfulRefreshAt: number | null }
export interface LiveView {
  fresh: boolean
  title: string
}

export function liveView(data: LiveData, t: Translator): LiveView {
  const fresh = data.stale === false && data.lastSuccessfulRefreshAt != null
  const title = fresh
    ? t('live.on')
    : data.lastSuccessfulRefreshAt == null
      ? t('live.waiting')
      : t('live.stale', { time: new Date(data.lastSuccessfulRefreshAt).toLocaleTimeString(t.lang) })
  return { fresh, title }
}

/** What `updateLive` needs of the dot's element. */
export interface LiveElement {
  classList: { toggle(name: string, force?: boolean): boolean }
  title: string
}

export function updateLive(element: LiveElement, data: LiveData, t: Translator): void {
  const { fresh, title } = liveView(data, t)
  element.classList.toggle('on', fresh)
  element.classList.toggle('stale', !fresh)
  element.title = title
}
