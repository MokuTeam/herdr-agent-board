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
  /** Claude Code's recap of the session, when it is newer than `doing` (#321): the card's line then. */
  recap: string
  /** The task `doing` names, under the recap that stands over it. */
  task: string
  /** The session went on long after its recap: it says how things stood then, not now. */
  stale: boolean
}

/** How long a session may go on after its recap before the recap reads as of then (#321). */
export const RECAP_STALE_MS = 30 * 60_000

/** The recap, when it is the card's line: there is one and nothing newer was put in `doing`. */
function recapLine(it: Item): string {
  const recap = plain(it.recap)
  if (!recap) return ''
  // A fork's transcript starts with its source's lines: a recap from before the fork is the other's.
  if (it.fork && (it.recapAt ?? 0) < it.fork.at) return ''
  if (!it.doing) return recap
  // A doing of unknown time stays the line, as before recaps.
  return it.recapAt && it.doingAt && it.recapAt > it.doingAt ? recap : ''
}

/** Its result when done or idle, else its last words; `spoken` stands for those. */
const saidOf = (it: Item, spoken = it.lastText): string =>
  plain(it.column === 'done' || it.column === 'idle' ? it.result || spoken : spoken)

export function cardWords(it: Item): CardWords {
  const recap = recapLine(it)
  if (recap) {
    const task = plain(it.doing)
    const lastAt = it.lastAt ?? 0
    const recapAt = it.recapAt ?? 0
    // Written after its last words, the recap tells them already; not a result it was given.
    const told = !!lastAt && !!recapAt && recapAt >= lastAt
    const said = saidOf(it, told ? '' : it.lastText)
    return {
      own: '',
      asked: '',
      said: it.column !== 'me' && said && said !== recap && said !== task ? said : '',
      recap,
      task,
      stale: !!lastAt && !!recapAt && lastAt - recapAt > RECAP_STALE_MS,
    }
  }
  const own = plain(it.doing || (it.title && it.title !== it.name ? it.title : ''))
  const asked = own ? '' : plain(it.prompt)
  const what = own || asked
  const said = saidOf(it)
  return {
    own,
    asked,
    said: it.column !== 'me' && said && said !== what ? said : '',
    recap: '',
    task: '',
    stale: false,
  }
}

/**
 * `text` cut after its first `words` words, with "…" (#321): the card's long lines end at a word,
 * where a clamp's ellipsis can cut into one. A comma or the like before the cut goes with it.
 */
export function clipWords(text: string, words: number): string {
  const kept = text.trim().split(/\s+/).slice(0, Math.max(words, 0)).join(' ')
  return `${kept.replace(/[\s,;:.\-\u2013\u2014]+$/u, '')}…`
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

/** The line under "Needs me": what kind of stop, and the question. */
export function askLine(it: Item, t: Translator): { label: string; text: string } {
  return {
    label: t(it.attention ? `att.${it.attention}` : 'att.default'),
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
