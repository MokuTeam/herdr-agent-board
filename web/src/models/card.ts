// What a card on the board says: its words, its age, the question it waits on, its alarm.
import type { FormQuestion } from '../../../src/core/dialogs/question-form.ts'
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import { longWhen, shortWhen } from '../../../src/core/when-format.ts'
import { attentionTime } from './attention.ts'
import { restartOf } from './restart.ts'
import { entryText } from './schedule.ts'

/** Markdown down to plain text, for one-glance card lines. */
export const plain = (s: unknown): string =>
  String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' … ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#+|[-*•]|\d+\.)\s+/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** "5 min ago" and the like, against the board's clock `now`; nothing for no time. */
export function ago(ms: number | null | undefined, now: number, t: Translator): string {
  if (!ms) return ''
  const m = Math.floor((now - ms) / 60_000)
  if (m < 1) return t('ago.now')
  if (m < 60) return t('ago.min', { n: m })
  const h = Math.floor(m / 60)
  return h < 24 ? t('ago.h', { n: h }) : t('ago.d', { n: Math.floor(h / 24) })
}

/** A turn is on: it works, or a dialog stopped it midway. */
export const inTurn = (it: Pick<Item, 'status'>): boolean => it.status === 'working' || it.status === 'blocked'

/**
 * Asleep in the idle column: a one-line card. A restart on its way keeps the card whole: it says
 * so, and does not fold up while Claude is out (`schedules`: the board's). A favorite stays whole.
 */
export const compact = (
  it: Pick<Item, 'key' | 'sleeping' | 'column' | 'favorite'>,
  schedules: readonly ScheduleEntry[] = [],
): boolean => !!it.sleeping && it.column === 'idle' && !it.favorite && !restartOf(schedules, it.key)

/**
 * Asleep in "Waiting": folded down to its name, what it waits for and its time, whole while it is
 * pointed at or focused (models/fold.ts). A restart on its way keeps it whole, as for `compact`,
 * and so does being a favorite.
 */
export const folds = (
  it: Pick<Item, 'key' | 'sleeping' | 'column' | 'favorite'>,
  schedules: readonly ScheduleEntry[] = [],
): boolean => !!it.sleeping && it.column === 'ext' && !it.favorite && !restartOf(schedules, it.key)

// The server builds it (launches.decorate): its id and state are enough to tell it from nothing.
const isLaunch = (value: unknown): value is LaunchView =>
  typeof value === 'object' && value !== null && 'id' in value && 'state' in value

/** A session the board started and that is not done starting: its launch, else null. */
export const launchOf = (it: Item): LaunchView | null => (isLaunch(it.launch) ? it.launch : null)

/** A question that does not need an answer: the card offers to take it off "Needs me". */
export const dismissable = (it: Pick<Item, 'attention'>): boolean =>
  it.attention === 'ask' || it.attention === 'question' || it.attention === 'later'

export interface CardWords {
  /** What it works on in its own words, or Claude's title of the session. */
  own: string
  /** Else your last request. */
  asked: string
  /** What it said last (its result when done), when that is worth a line. */
  said: string
}

export function cardWords(it: Item): CardWords {
  const own = plain(it.doing || (it.title && it.title !== it.name ? it.title : ''))
  const asked = own ? '' : plain(it.prompt)
  const what = own || asked
  const said = plain(it.column === 'done' || it.column === 'idle' ? it.result || it.lastText : it.lastText)
  return { own, asked, said: it.column !== 'me' && said && said !== what ? said : '' }
}

/** Under "Needs me" the age says how long it has waited for you: since its question, else since its last activity. */
export function cardAge(it: Item, now: number, t: Translator): { text: string; title: string } {
  const waiting = attentionTime(it)
  const text = ago(waiting || (it.column === 'ext' ? it.waitSince || it.activity : it.activity), now, t)
  const title = waiting
    ? t(it.askSince ? 'attention.waitAge' : 'attention.activityAge', { age: ago(waiting, now, t) })
    : ''
  return { text, title }
}

/**
 * What it asks is to be done in its own browser (browser_ask_owner: a sign-in, a captcha), not
 * answered in the chat: the card's ask is its browser's (core/types.ts ItemDesktop.asks).
 */
export const asksInBrowser = (it: Pick<Item, 'attention' | 'desktop'>): boolean =>
  it.attention === 'ask' && !!it.desktop?.asks

/** The line under "Needs me": what kind of stop (an ask to do in its browser says so), and the question. */
export function askLine(it: Item, t: Translator): { label: string; text: string } {
  return {
    label: asksInBrowser(it) ? t('desk.askLabel') : t(it.attention ? `att.${it.attention}` : 'att.default'),
    text: plain(it.question) || t(it.attention === 'later' ? 'card.lookLater' : 'card.needsDecision'),
  }
}

/** A question form on a card: the first question, its options in one line, how many more. */
export function questionLine(
  questions: FormQuestion[],
  t: Translator,
): { header: string; question: string; options: string; more: string } {
  const q = questions[0]
  const options = (q?.options ?? []).map(o => o.label).join(' · ') + (q?.multiSelect ? ` · ${t('qa.any')}` : '')
  return {
    header: q?.header ?? '',
    question: plain(q?.question),
    options,
    more: questions.length > 1 ? t('qa.more', { n: questions.length - 1 }) : '',
  }
}

export interface AlarmView {
  /** The soonest entry is due and waits for the session. */
  due: boolean
  /** It repeats (cron). */
  repeat: boolean
  when: string
  title: string
}

/**
 * The session's schedule entries (the server sorts them, soonest first) as the clock by its name;
 * a restart has a line of its own on the card, not a time.
 */
export function alarmOf(schedules: ScheduleEntry[], key: string, now: number, t: Translator): AlarmView | null {
  const list = schedules.filter(e => e.key === key && e.kind !== 'restart')
  const first = list[0]
  if (!first) return null
  const title = t('sched.badge', {
    n: list.length,
    when: longWhen(first.next, t, now),
    text: plain(entryText(first, t)),
  })
  return { due: first.next <= now, repeat: !!first.cron, when: shortWhen(first.next, t, now), title }
}
