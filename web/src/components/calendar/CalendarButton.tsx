// The toolbar's Calendar button (#328), while the board has the calendar on: it opens the panel.
// When a call is on or starts within fifteen minutes, its time to go and its title sit beside the
// icon in the source's colour, and a call with a join link has it one tap away next to the button.
import type { CSSProperties } from 'react'
import { useMinute } from '../../hooks/useMinute.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { joinProvider, untilText } from '../../models/calendar.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { CalendarIcon, VideoIcon } from '../icons.tsx'

/** How soon a call shows beside the button. */
const SOON_MS = 15 * 60_000

export function CalendarButton({ onOpen }: { onOpen(): void }) {
  const t = useT()
  const { data } = useBoardContext()
  const line = data?.calendar
  const now = useMinute(!!line?.next)
  if (!line) return null
  const next = line.next
  const start = next ? Date.parse(next.start) : 0
  const end = next ? Date.parse(next.end) : 0
  const soon = !!next && start - SOON_MS <= now && end > now
  const lane = next?.lane ? data?.categories.find(c => c.id === next.lane)?.color : undefined
  const color = next?.color ?? lane ?? 'var(--accent)'
  const when = soon ? untilText(start, end, now, t) : ''
  return (
    <span className={classNames('cal-tb', soon && 'soon')} style={{ '--ev': color } as CSSProperties}>
      <button
        type="button"
        className={classNames('pill-toggle', !soon && 'icon-only')}
        id="calendar-open"
        title={soon && next ? `${next.title} · ${when}` : t('cal.openHint')}
        onClick={onOpen}
      >
        <CalendarIcon />
        <span data-i18n={soon ? undefined : 'cal.open'}>
          {soon && next ? `${when} · ${next.title}` : t('cal.open')}
        </span>
        {line.failing > 0 && <span className="cal-tb-bad" title={t('cal.someFailing')} />}
      </button>
      {soon && next?.join && (
        <a
          className="pill-toggle icon-only cal-tb-join"
          href={next.join}
          target="_blank"
          rel="noopener noreferrer"
          title={joinProvider(next.join) ? t('cal.joinVia', { provider: joinProvider(next.join) }) : t('cal.join')}
          aria-label={`${t('cal.join')}: ${next.title}`}
        >
          <VideoIcon />
        </a>
      )}
    </span>
  )
}
