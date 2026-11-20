// What the page shows of the archive without a page (src/core/archive.ts has its rules and shapes):
// how long a toast offers Return, what the toasts say when sessions go and come back, the rows of
// the archive's panel by the day they went, and how the archive went for this page (a close the
// server called off, said once). hooks/useArchive.ts and components/archive/ArchivePanel.tsx use it.
import type { ArchiveLogEntry, ParkedEntry, PublicArchiveRecord, ReturnedOne } from '../../../src/core/archive.ts'
import { baseName } from '../../../src/core/launch/names.ts'
import type { BoardCategory } from '../../../src/core/payload.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { capital, dayLabel, longWhen, shortWhen, timeOf } from '../../../src/core/when-format.ts'
import { categoryInfo } from './board-view.ts'
import { plain } from './card.ts'
import { entryText } from './schedule.ts'

/** A text's first letter in lower case, for a reason inside a sentence. */
export const lowerFirst = (s: string, t: Translator): string =>
  s ? (s[0] ?? '').toLocaleLowerCase(t.lang) + s.slice(1) : s

/** How long the server keeps a pane for Return when it has not said (8 s). */
export const UNDO_MS = 8000

/** How long a toast offers Return: until a little before the server closes the pane, 2.5 to 7 s. */
export const returnToastMs = (closeAt: number | null | undefined, undoMs: number, now: number): number =>
  Math.max(2500, Math.min(7000, (closeAt ?? now + undoMs) - now - 1200))

/** What the toast says after a tidy-up (several at once). */
export const archivedManyText = (done: readonly { name: string }[], t: Translator): string =>
  done.length === 1 ? t('archive.done', { name: done[0]?.name ?? '' }) : t('archive.doneMany', { n: done.length })

/** What the toast says when sessions come back: resumed (or on their way back already), or put back as they were. */
export function returnedText(
  done: readonly Pick<ReturnedOne, 'key' | 'name' | 'back' | 'resume' | 'again'>[],
  nameOf: (key: string) => string | undefined,
  t: Translator,
): string {
  // Resumed now, or already on its way back from an earlier Return.
  const resumed = done.filter(d => d.resume || d.again)
  const first = done[0]
  if (done.length === 1 && first)
    return t(resumed.length ? 'archive.resuming' : 'archive.back', {
      name: first.name || nameOf(first.key) || t('session'),
    })
  return resumed.length ? t('archive.resumingMany', { n: done.length }) : t('archive.backMany', { n: done.length })
}

/** A line of the board's archive log (src/core/archive.ts ArchiveLogEntry), as far as the page reads it. */
const isLogEntry = (value: unknown): value is ArchiveLogEntry =>
  typeof value === 'object' &&
  value !== null &&
  'key' in value &&
  typeof value.key === 'string' &&
  'result' in value &&
  typeof value.result === 'string' &&
  (!('why' in value) || value.why === undefined || typeof value.why === 'string') &&
  (!('detail' in value) || value.detail === undefined || typeof value.detail === 'string') &&
  (!('name' in value) || typeof value.name === 'string')

/**
 * How the archive went for this page, from the board's log: a close the server called off because
 * the session got to work meanwhile (it is back on the board) is said once, as an error toast.
 * What the log held when the page opened is old news (`seen` null: the first board).
 */
export function archiveNotes(
  log: readonly unknown[],
  seen: ReadonlySet<string> | null,
  nameOf: (key: string) => string | undefined,
  t: Translator,
): { seen: Set<string>; toasts: string[] } {
  const next = new Set(seen ?? [])
  const toasts: string[] = []
  for (const r of log) {
    if (!isLogEntry(r)) continue
    const id = `${r.key}@${r.at}@${r.result}`
    if (next.has(id)) continue
    next.add(id)
    if (seen && r.result === 'kept')
      toasts.push(
        t('archive.kept', {
          name: nameOf(r.key) || r.name || t('session'),
          why: lowerFirst(t(r.why ?? '', { why: r.detail ?? '' }), t),
        }),
      )
  }
  return { seen: next, toasts }
}

/** One row of the archive's panel, as it shows. */
export interface ArchiveRowView {
  key: string
  name: string
  /** Its lane's color. */
  color: string
  /** When it went: the time, and the whole day in its tooltip. */
  when: string
  whenTitle: string
  /** What its card said last, or its title when that is not its name. */
  note: string
  /** Its lane, folder and workspace; the folder in full in its tooltip. */
  where: string
  cwd: string
  /** Its entries waiting with it, and who archived it when another session did. */
  extra: string
  /** The extra's tooltip: what waits with it. */
  extraTitle: string | null
  /** A Return of it is on its way. */
  returning: boolean
  returnDisabled: boolean
  /** Its trash can asks "Remove?". */
  armed: boolean
  removeDisabled: boolean
}

export interface RowScene {
  t: Translator
  categories: readonly BoardCategory[]
  /** A Return of it asked from this page is on its way. */
  returning: boolean
  armed: boolean
  canMutate: boolean
  canEdit: boolean
}

export function archiveRowView(r: PublicArchiveRecord, s: RowScene): ArchiveRowView {
  const { t } = s
  const lane = categoryInfo([...s.categories], r.category)
  const returning = !!r.returning || s.returning
  const where = [lane.title, baseName(r.cwd), r.workspace && t('meta.workspace', { name: r.workspace })].filter(
    (x): x is string => !!x,
  )
  // The count, unless the row lists the entries themselves (#295).
  const listed = !!r.parked?.length
  const extra = [
    r.held && !listed && t('archive.held', { n: r.held }),
    r.from?.name && t('archive.by', { name: r.from.name }),
  ]
  return {
    key: r.key,
    name: r.name,
    color: lane.color,
    when: timeOf(r.archivedAt, t),
    whenTitle: capital(longWhen(r.archivedAt, t), t),
    note: plain(r.note || (r.title !== r.name ? r.title : '')),
    where: where.join(' · '),
    cwd: r.cwd,
    extra: extra.filter((x): x is string => !!x).join(' · '),
    extraTitle: r.held && !listed ? t('archive.heldHint') : null,
    returning,
    returnDisabled: returning || !s.canMutate,
    armed: s.armed,
    removeDisabled: !s.canEdit || r.state === 'closing' || returning,
  }
}

/** Records by the day they went (the list is newest first already), each day a group under its title. */
export function archiveGroups<R extends Pick<PublicArchiveRecord, 'archivedAt'>>(
  list: readonly R[],
  t: Translator,
  now = Date.now(),
): { title: string; records: R[] }[] {
  const groups: { title: string; records: R[] }[] = []
  for (const r of list) {
    const title = capital(dayLabel(r.archivedAt, t, now), t)
    const last = groups.at(-1)
    if (last?.title === title) last.records.push(r)
    else groups.push({ title, records: [r] })
  }
  return groups
}

/** What the search reads of a day: its label and the time ("yesterday 14:05"). */
export const archiveDayText =
  (t: Translator, now = Date.now()) =>
  (ms: number): string =>
    `${dayLabel(ms, t, now)} ${timeOf(ms, t)}`

// ---------------------------------------------------------------- the entries parked with a session

/** One entry that waits with an archived session, as its row lists it (#295). */
export interface ParkedView {
  id: string
  /** When it is due once Return puts it back: "15:30", "Fri 9:00", "20 Oct"; "runs no more". */
  time: string
  timeTitle: string
  /** A one-off that came due while it waited: it goes out once the session is back and free (orange). */
  overdue: boolean
  /** A repeating one whose rule has no run left: Return drops it, Move cannot take it. */
  ended: boolean
  repeats: boolean
  cron: string
  text: string
}

/** The entries of a record, soonest first (those that run no more last), as its row lists them. */
export function parkedViews(r: Pick<PublicArchiveRecord, 'parked'>, t: Translator, now = Date.now()): ParkedView[] {
  const list = (r.parked ?? []).filter((e): e is ParkedEntry => typeof e?.id === 'string' && typeof e.text === 'string')
  return [...list]
    .sort((a, b) => (a.due ?? Number.POSITIVE_INFINITY) - (b.due ?? Number.POSITIVE_INFINITY))
    .map(e => {
      const ended = typeof e.due !== 'number'
      const due = ended ? 0 : (e.due as number)
      return {
        id: e.id,
        time: ended ? t('archive.parked.ended') : shortWhen(due, t, now),
        timeTitle: ended
          ? t('archive.parked.endedHint')
          : `${capital(longWhen(due, t, now), t)} · ${t('archive.parked.due')}`,
        overdue: !ended && due <= now,
        ended,
        repeats: !!e.cron,
        cron: e.cron ?? '',
        text: entryText(e, t),
      }
    })
}

/** Where Move can send an entry: the sessions on the board (none on its way into the archive), by lane in the board's order, by name within one. */
export function moveTargets(
  items: readonly Pick<Item, 'key' | 'name' | 'category'>[],
  categories: readonly BoardCategory[],
  skip: (key: string) => boolean,
  t: Translator,
): { lane: string; sessions: { key: string; name: string }[] }[] {
  const order = new Map(categories.map((c, i) => [c.id, i]))
  const lanes = new Map<string, { key: string; name: string }[]>()
  for (const it of items) {
    if (skip(it.key)) continue
    const list = lanes.get(it.category) ?? []
    list.push({ key: it.key, name: it.name || t('session') })
    lanes.set(it.category, list)
  }
  return [...lanes]
    .sort(([a], [b]) => (order.get(a) ?? categories.length) - (order.get(b) ?? categories.length))
    .map(([id, sessions]) => ({
      lane: categoryInfo([...categories], id).title,
      sessions: sessions.sort((a, b) => a.name.localeCompare(b.name, t.lang)),
    }))
}
