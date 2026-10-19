// A session's helpers as rows (the old page's helpers.js helperRowHTML, runRowHTML): the kind's
// icon, the title, what it does now (or what it is), how long it ran and how it stands. A clock
// that runs moves on every second (hooks/useSecond.ts).
import type { MouseEvent } from 'react'
import type { PublicHelper, WorkflowRun } from '../../../../src/core/helpers.ts'
import { useSecond } from '../../hooks/useSecond.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { clock, helperTitle, toneOf, took } from '../../models/helper-model.ts'
import { HelperIcon } from './glyphs.tsx'

/** The mark for a status: a spinner while it works, else a small round sign. */
export function StatusMark({ status }: { status: string }) {
  if (status === 'running')
    return (
      <span className="h-mark run">
        <HelperIcon name="spin" />
      </span>
    )
  const tone = toneOf(status)
  const name = tone === 'ok' ? 'check' : tone === 'fail' ? 'cross' : tone === 'idle' ? 'idle' : 'stop'
  return (
    <span className={`h-mark ${tone}`}>
      <HelperIcon name={name} />
    </span>
  )
}

/** A clock that runs since `at`: its data-since says when it started, as the old page's did. */
export function Since({ at, className }: { at: number; className?: string }) {
  const now = useSecond()
  return (
    <span className={className} data-since={Number(at)}>
      {clock(now - Number(at))}
    </span>
  )
}

/** How long something ran: a running one's clock moves on. */
export function HelperTime({ startedAt, status, ms }: { startedAt: number | null; status: string; ms: number | null }) {
  if (status === 'running' && startedAt) return <Since className="h-time" at={startedAt} />
  return <span className="h-time">{ms != null ? clock(ms) : ''}</span>
}

/** A helper's icon by its kind, in its teammate color when it has one. */
export function KindIcon({ kind, color }: { kind: string; color?: string | undefined }) {
  return (
    <span className={`h-icon k-${kind}`} data-color={color || undefined}>
      <HelperIcon name={kind} />
    </span>
  )
}

export type OpenFrom = (el: HTMLElement) => void

/** A helper as a row: what it is, what it does now, its clock and status. `depth`: under the one that started it. */
export function HelperRow({ h, onOpen }: { h: PublicHelper & { depth?: number }; onOpen?: OpenFrom | undefined }) {
  const t = useT()
  const title = helperTitle(h)
  const now = h.status === 'running' && (h.now || h.after || h.waiting)
  const what = now ? (
    h.now ? (
      <>
        <b>{h.now.label}</b> {h.now.detail}
      </>
    ) : h.waiting ? (
      t('helpers.waitingBg', { n: h.waiting })
    ) : (
      t('helpers.after', { tool: h.after })
    )
  ) : (
    [h.status === 'running' ? t('helpers.thinking') : '', h.type, h.name && h.name !== title ? h.name : '', h.phase]
      .filter(Boolean)
      .join(' · ')
  )
  return (
    <button
      type="button"
      className={h.depth ? 'helper-row nested' : 'helper-row'}
      data-helper={h.id}
      data-status={h.status}
      style={{ '--depth': Math.min(3, h.depth ?? 0) }}
      title={`${title} · ${t(`helpers.status.${h.status}`)}`}
      onClick={(e: MouseEvent<HTMLElement>) => onOpen?.(e.currentTarget)}
    >
      <KindIcon kind={h.kind} color={h.color} />
      <span className="h-main">
        <span className="h-title">{title}</span>
        <span className="h-now">{what}</span>
      </span>
      <HelperTime startedAt={h.startedAt} status={h.status} ms={took(h)} />
      <StatusMark status={h.status} />
    </button>
  )
}

/** A workflow run as a row: its name, its agents, its status. */
export function RunRow({ w, onOpen }: { w: WorkflowRun; onOpen?: OpenFrom | undefined }) {
  const t = useT()
  const sub = [t('helpers.kind.run'), w.agents && t('helpers.agents', { n: w.agents })].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      className="helper-row"
      data-run-open={w.id}
      data-status={w.status}
      onClick={(e: MouseEvent<HTMLElement>) => onOpen?.(e.currentTarget)}
    >
      <KindIcon kind="workflow" />
      <span className="h-main">
        <span className="h-title">{w.name || w.id}</span>
        <span className="h-now">{sub}</span>
      </span>
      <HelperTime
        startedAt={w.startedAt}
        status={w.status}
        ms={w.startedAt ? (w.endedAt ?? w.activity) - w.startedAt : null}
      />
      <StatusMark status={w.status} />
    </button>
  )
}
