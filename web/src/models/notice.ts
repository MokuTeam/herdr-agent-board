// The line a notice gets in the conversation (src/core/notices.ts): a background task reporting
// back or a board reminder, shown small and apart from what the user typed.
import { isReminder, type Notice } from '../../../src/core/notices.ts'
import type { Translator } from '../../../src/core/types.ts'

export type NoticeTone = 'ok' | 'fail' | 'stop' | 'info'

export interface NoticeLine {
  /** The line itself. */
  text: string
  /** A quieter second part. */
  sub: string
  /** The mark's color. */
  tone: NoticeTone
}

/**
 * { text, sub, tone } for a notice: text is the line itself, sub a quieter second part, tone the
 * mark's color: ok | fail | stop | info.
 */
export function noticeLine(n: Notice, t: Translator): NoticeLine {
  if (isReminder(n)) {
    const sub = [n.from && t('notice.from', { name: n.from }), n.cron, n.note].filter(Boolean).join(' · ')
    return { text: `${t(`notice.${n.kind}`)}: ${n.name}`, sub, tone: 'info' }
  }
  const failed = n.status === 'failed' || (n.exit != null && n.exit !== 0)
  const tone = failed ? 'fail' : n.status === 'completed' ? 'ok' : n.status === 'event' ? 'info' : 'stop'
  const status = failed
    ? n.exit
      ? t('notice.status.failedCode', { code: n.exit })
      : t('notice.status.failed')
    : t(`notice.status.${['completed', 'event'].includes(n.status) ? n.status : 'stopped'}`)
  // Without a name of its own the summary says it best, as Claude Code wrote it; with one, what
  // the summary adds (why it failed, a turn limit) goes second.
  if (!n.name) return { text: n.summary || t(`notice.kind.${n.kind}`), sub: '', tone }
  return { text: t('notice.line', { kind: t(`notice.kind.${n.kind}`), name: n.name, status }), sub: n.note || '', tone }
}
