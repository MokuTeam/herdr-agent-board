// The dot at the end of the toolbar: green with fresh herdr data, orange otherwise (models/live.ts).
import { useT } from '../i18n/I18nProvider.tsx'
import { type LiveData, liveView } from '../models/live.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'

const OFFLINE: LiveData = { stale: true, lastSuccessfulRefreshAt: null }

export function LiveDot() {
  const t = useT()
  const { data, connected, dropped } = useBoardContext()
  const view = liveView(connected && data ? data : OFFLINE, t)
  const title = connected ? view.title : t(dropped ? 'live.off' : 'live.none')
  return <span className={view.fresh ? 'live on' : 'live stale'} id="live" title={title} />
}
