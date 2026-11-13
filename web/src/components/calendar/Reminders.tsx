// A calendar reminder on the page (#335): a calm card at the page's lower right (at the top on a
// phone) while the board has one on show, the same one every open page and the phone show. One
// look says whose (the source's mark and label), when, and what; Join is one tap away, beside
// Snooze and At start; the title opens the event in the Calendar panel; the cross dismisses it.
// A button hides the card at once and tells the board (POST /api/calendar-reminders), which clears
// it everywhere and on the desktop; one the board refused comes back with the reason.
//
// The cards come up on a spring from the edge they rest by (below, above on a phone) and go back
// the same way; with reduced motion they only fade.
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemindersPayload } from '../../../../src/core/payload.ts'
import { errorText, postJson, replyOf } from '../../api/client.ts'
import { useMinute } from '../../hooks/useMinute.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { joinProvider, offersAtStart, reminderWhen, sourceColors, sourceLabel } from '../../models/calendar.ts'
import { PHONE_QUERY } from '../../models/panel-motion.ts'
import { Spring } from '../../models/spring.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { CloseIcon, VideoIcon } from '../icons.tsx'

type Item = RemindersPayload['items'][number]
export type ShowEvent = (e: { source: string; id: string; start: string }) => void

const clock = (at: number, lang: string): string =>
  new Date(at).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' })

export function Reminders({ onOpen }: { onOpen: ShowEvent }) {
  const t = useT()
  const { data, toast, canEdit, connected } = useBoardContext()
  const line = data?.calendar?.reminders
  const items = line?.items ?? []
  // what a card shows: a title or a link changed while it is up shows at once
  const sig = JSON.stringify(items.map(r => [r.id, r.title, r.join ?? '', r.start, r.end, r.label, r.color]))
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const [leaving, setLeaving] = useState<ReadonlyMap<string, Item>>(() => new Map())
  const before = useRef<Item[]>([])
  const now = useMinute(items.length > 0 || leaving.size > 0)
  const lanes = data?.categories ?? []

  // biome-ignore lint/correctness/useExhaustiveDependencies: follows what is on show, not the payload's identity
  const shown = useMemo(() => items.filter(r => !hidden.has(r.id)), [sig, hidden])
  // a page that was away (its stream suspended) may have missed the board taking one out: the board's
  // word on what is on show counts again once it is back
  useEffect(() => {
    if (connected) setHidden(h => (h.size ? new Set() : h))
  }, [connected])
  // a reminder that left (snoozed, dismissed elsewhere, past) goes on its spring; one that comes
  // back after a snooze has the same id and shows again
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the ids on show
  useEffect(() => {
    const ids = new Set(shown.map(r => r.id))
    const gone = before.current.filter(r => !ids.has(r.id))
    if (gone.length)
      setLeaving(m => {
        const next = new Map(m)
        for (const r of gone) next.set(r.id, r)
        return next
      })
    before.current = shown
    const present = new Set(items.map(r => r.id))
    setHidden(h => (h.size && [...h].some(id => !present.has(id)) ? new Set([...h].filter(id => present.has(id))) : h))
  }, [shown, sig])

  const gone = useCallback((id: string) => {
    setLeaving(m => {
      if (!m.has(id)) return m
      const next = new Map(m)
      next.delete(id)
      return next
    })
  }, [])

  const act = async (r: Item, a: 'snooze' | 'start' | 'dismiss' | 'join') => {
    setHidden(h => new Set(h).add(r.id))
    const back = (why: string) => {
      setHidden(h => {
        const next = new Set(h)
        next.delete(r.id)
        return next
      })
      toast(why, true)
    }
    let res: Response
    try {
      res = await postJson('/api/calendar-reminders', { id: r.id, act: a })
    } catch (err) {
      back(errorText(err, t))
      return
    }
    // gone already (its event moved, removed): nothing to bring back
    if (res.ok || res.status === 404) return
    const reply = (await replyOf(res)) as { error?: string }
    back(reply.error || t('err.status', { code: res.status }))
  }

  if (!line && !leaving.size) return null
  const colors = sourceColors(
    [...shown, ...leaving.values()].map(r => ({ id: r.source, kind: r.kind, color: r.color, lane: r.lane })),
    lanes,
  )
  const list = [...shown, ...[...leaving.values()].filter(r => !shown.some(s => s.id === r.id))].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id),
  )
  return (
    <div className="cal-reminders" aria-live="polite">
      {list.map(r => (
        <ReminderCard
          key={r.id}
          r={r}
          leaving={!shown.includes(r)}
          onGone={gone}
          color={colors.get(r.source) ?? 'var(--accent)'}
          whose={sourceLabel({ id: r.source, kind: r.kind, label: r.label, lane: r.lane }, lanes, t)}
          now={now}
          snoozeMin={line?.snoozeMin ?? 5}
          disabled={!canEdit}
          onAct={a => void act(r, a)}
          onOpen={() => onOpen({ source: r.source, id: r.event, start: r.start })}
        />
      ))}
    </div>
  )
}

function ReminderCard(props: {
  r: Item
  leaving: boolean
  onGone(id: string): void
  color: string
  whose: string
  now: number
  snoozeMin: number
  disabled: boolean
  onAct(a: 'snooze' | 'start' | 'dismiss' | 'join'): void
  onOpen(): void
}) {
  const { r, leaving, onGone, color, whose, now, snoozeMin, disabled, onAct, onOpen } = props
  const t = useT()
  const ref = useRef<HTMLElement>(null)
  const spring = useRef<Spring | null>(null)
  const start = Date.parse(r.start)
  const end = Date.parse(r.end)
  const span = end > start ? `${clock(start, t.lang)} - ${clock(end, t.lang)}` : clock(start, t.lang)
  const provider = r.join ? joinProvider(r.join) : ''

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    // it comes from the edge it rests by: below on a computer, above on a phone
    const from = matchMedia(PHONE_QUERY).matches ? -12 : 12
    const s: Spring = new Spring({
      value: 0,
      damping: 1,
      response: 0.35,
      precision: 0.002,
      onUpdate: () => {
        const v = s.value
        el.style.opacity = String(v)
        el.style.transform = still ? '' : `translateY(${(1 - v) * from}px) scale(${0.98 + 0.02 * v})`
      },
    })
    spring.current = s
    s.to(1)
    return () => {
      s.stop()
    }
  }, [])
  useEffect(() => {
    const s = spring.current
    const el = ref.current
    if (!s || !el) return
    if (leaving) {
      el.style.pointerEvents = 'none'
      s.onRest = () => onGone(r.id)
      s.to(0)
    } else if (el.style.pointerEvents) {
      // the board refused a button: the card comes back from wherever it was going
      el.style.pointerEvents = ''
      s.onRest = () => {}
      s.to(1)
    }
  }, [leaving, onGone, r.id])

  return (
    <section
      ref={ref}
      className="cal-reminder"
      style={{ '--ev': color, opacity: 0 } as CSSProperties}
      aria-label={`${t('cal.rem.label')}: ${r.title || t('cal.rem.noTitle')}`}
    >
      <div className="cal-rem-meta">
        <span className="cal-mark" />
        <span className="cal-rem-whose">{whose}</span>
        <span className="cal-rem-when">
          {reminderWhen(start, now, t)} · {span}
        </span>
      </div>
      <button type="button" className="cal-rem-title" title={t('cal.rem.open')} onClick={onOpen}>
        {r.title || t('cal.rem.noTitle')}
      </button>
      <div className="cal-rem-actions">
        {r.join ? (
          <a
            className="button primary cal-rem-join"
            href={r.join}
            target="_blank"
            rel="noopener noreferrer"
            title={provider ? t('cal.joinVia', { provider }) : t('cal.join')}
            onClick={() => !disabled && onAct('join')}
          >
            <VideoIcon />
            {t('cal.join')}
          </a>
        ) : (
          <button type="button" className="button primary" onClick={onOpen}>
            {t('cal.rem.open')}
          </button>
        )}
        <button type="button" className="button" disabled={disabled} onClick={() => onAct('snooze')}>
          {t('cal.rem.snoozeFor', { n: snoozeMin })}
        </button>
        {offersAtStart(start, now) && (
          <button type="button" className="button" disabled={disabled} onClick={() => onAct('start')}>
            {t('cal.rem.atStart')}
          </button>
        )}
      </div>
      <button
        type="button"
        className="cal-rem-close"
        disabled={disabled}
        title={t('cal.rem.dismiss')}
        aria-label={t('cal.rem.dismiss')}
        onClick={() => onAct('dismiss')}
      >
        <CloseIcon />
      </button>
    </section>
  )
}
