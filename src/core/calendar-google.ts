// The `google-workspace` preset of an mcp calendar source (#328): how the board calls the Google
// Workspace MCP server's `get_events` and `manage_event`, and how it reads `get_events`' answer,
// which is text for a model to read rather than JSON. No I/O.
//
// The answer, with `detailed: true`, is a line saying how many it found, then one block per event:
//
//   - "<title>" (Starts: <start> [<zone>; weekday: …], Ends: <end> [<zone>; weekday: …])
//     Description: <text, maybe on several lines>
//     Location: <place, or "No Location">
//     Meeting Link: <the conference's address>
//     Event Type: workingLocation
//     Attendees: <a, b, c, or "None">
//     Attendee Details: <a>: accepted (organizer)
//       <b>: declined (note: "…")
//     ID: <event id> | Link: <its page>
//
// A timed event's start and end are ISO with an offset; an all-day one's are dates, its end the day
// after its last ("exclusive all-day end"). Without `detailed` the ID and Link sit on the first
// line. More pages: "Next page token: <t>" and "Pagination time_min: <t>", both asked again.
import { type CalEvent, type CalSource, type EventKind, type EventResponse, eventOf, joinLinkIn } from './calendar.ts'
import { isDate } from './time.ts'

/** A head line: the title, the start and its bracket, the end and its bracket, the ID and Link when on it. */
const HEAD = /^- "(.*)" \(Starts: (\S+) \[([^\]]*)\], Ends: (\S+) \[([^\]]*)\]\)(?: ID: (\S+) \| Link: (\S+))?\s*$/

/** The fields a block has; a line that starts like none of them goes on with the one before it. */
const LABELS = [
  'Description',
  'Location',
  'Color ID',
  'Recurring Event ID',
  'Recurrence',
  'Event Type',
  'Status',
  'Visibility',
  'Transparency',
  'Creator',
  'Organizer',
  'Meeting Link',
  'Attendees',
  'Attendee Details',
  'Attachments',
  'ID',
]
const LABEL = new RegExp(`^  (${LABELS.join('|')}): ?(.*)$`)

/** The next page's question, when the answer says there is one. */
export interface NextPage {
  pageToken: string
  timeMin: string | null
}

export interface GoogleAnswer {
  events: CalEvent[]
  next: NextPage | null
  /** How many events the answer's first line says it has (this page's); null: it says none. */
  said: number | null
}

const EVENT_KINDS: Record<string, EventKind> = {
  workingLocation: 'workingLocation',
  outOfOffice: 'outOfOffice',
  focusTime: 'focusTime',
}
const ANSWERS: Record<string, EventResponse> = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  needsAction: 'needsAction',
}

/** The zone a bracket names first ("America/New_York; weekday: Monday…"), or none. */
function zoneOfBracket(b: string): string | undefined {
  const first = (b.split(';')[0] ?? '').trim()
  return first && !first.includes(':') ? first : undefined
}

/** The owner's answer in Attendee Details: the line of their address. */
function answerOf(details: string, account: string | null): EventResponse | undefined {
  if (!account) return undefined
  const me = account.toLowerCase()
  for (const line of details.split('\n')) {
    const m = /^\s*(.*?):\s*(\w+)/.exec(line)
    if (!m) continue
    // "Name <addr>" or "addr"
    const who = (m[1] ?? '').trim().toLowerCase()
    const addr = /<([^>]+)>/.exec(who)?.[1] ?? who
    if (addr === me) return ANSWERS[m[2] ?? '']
  }
  return undefined
}

/** `get_events`' text read as events; one block that does not read is left out, never guessed. */
export function googleEvents(text: string, source: Pick<CalSource, 'id' | 'account'>): GoogleAnswer {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const events: CalEvent[] = []
  let next: NextPage | null = null
  let timeMin: string | null = null
  let block: { head: RegExpExecArray; fields: Map<string, string> } | null = null
  let field: string | null = null

  const close = () => {
    if (!block) return
    const [, title, start, startB, end, , headId, headLink] = block.head
    const f = block.fields
    const idLine = f.get('ID') ?? ''
    const m = /^(\S+)(?:\s*\|\s*Link:\s*(\S+))?/.exec(idLine.trim())
    const id = m?.[1] ?? headId
    const link = m?.[2] ?? headLink
    const allDay = isDate(start ?? '') && isDate(end ?? '')
    const location = (f.get('Location') ?? '').trim()
    const place = location && location !== 'No Location' ? location : ''
    const attendees = (f.get('Attendees') ?? '').trim()
    const description = f.get('Description') ?? ''
    const kind = EVENT_KINDS[(f.get('Event Type') ?? '').trim()]
    const status = (f.get('Status') ?? '').trim().toLowerCase()
    const e = eventOf(
      {
        id,
        title,
        start,
        end,
        allDay,
        zone: allDay ? undefined : zoneOfBracket(startB ?? ''),
        location: place,
        join: joinLinkIn(f.get('Meeting Link'), place, description) ?? undefined,
        link,
        attendees: attendees && attendees !== 'None' ? attendees.split(',').filter(a => a.trim()).length : undefined,
        status: status === 'cancelled' ? 'cancelled' : status === 'tentative' ? 'tentative' : 'confirmed',
        response: answerOf(f.get('Attendee Details') ?? '', source.account),
        kind,
        series: (f.get('Recurring Event ID') ?? '').trim() || undefined,
      },
      source.id,
    )
    if (e) events.push(e)
    block = null
    field = null
  }

  for (const line of lines) {
    const head = HEAD.exec(line)
    if (head) {
      close()
      block = { head, fields: new Map() }
      continue
    }
    const token = /^Next page token: (\S+)\s*$/.exec(line)
    if (token) {
      close()
      next = { pageToken: token[1] as string, timeMin: null }
      continue
    }
    const min = /^Pagination time_min: (\S+)\s*$/.exec(line)
    if (min) {
      close()
      timeMin = min[1] as string
      continue
    }
    if (!block) continue
    const l = LABEL.exec(line)
    if (l) {
      field = l[1] as string
      // a later line of the same name is the description's text, not a field
      if (!block.fields.has(field)) {
        block.fields.set(field, l[2] ?? '')
        if (field === 'ID') close()
        continue
      }
    }
    if (field) block.fields.set(field, `${block.fields.get(field) ?? ''}\n${line}`)
  }
  close()
  if (next) next.timeMin = timeMin
  const said = /^\s*Successfully retrieved (\d+) events?/i.exec(text)
  return { events, next, said: said ? Number(said[1]) : null }
}

/** The window as the preset asks for it: RFC 3339 in UTC. */
const rfc = (at: number): string => new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')

/** How many events a page asks for: the server's own most. */
export const GOOGLE_PAGE = 250

/** `get_events`' arguments for a calendar and a window (and the page after the first). */
export function googleListArgs(
  source: Pick<CalSource, 'account'>,
  calendar: string,
  from: number,
  to: number,
  page?: NextPage | null,
): Record<string, unknown> {
  return {
    user_google_email: source.account,
    calendar_id: calendar,
    time_min: page?.timeMin ?? rfc(from),
    time_max: rfc(to),
    max_results: GOOGLE_PAGE,
    detailed: true,
    single_events: true,
    ...(page && { page_token: page.pageToken }),
  }
}

/** What a write asks the provider, in the board's words. */
export interface WriteAsk {
  op: 'create' | 'update' | 'delete'
  /** The event's id at the provider (update, delete). */
  id?: string
  calendar?: string
  title?: string
  start?: string
  end?: string
  allDay?: boolean
  location?: string
  note?: string
}

/** `manage_event`'s arguments for a write. */
export function googleWriteArgs(
  source: Pick<CalSource, 'account' | 'calendars'>,
  ask: WriteAsk,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    user_google_email: source.account,
    action: ask.op,
    calendar_id: ask.calendar ?? source.calendars[0] ?? 'primary',
  }
  if (ask.id) args.event_id = ask.id
  if (ask.title !== undefined) args.summary = ask.title
  if (ask.start !== undefined) args.start_time = ask.start
  if (ask.end !== undefined) args.end_time = ask.end
  if (ask.location !== undefined) args.location = ask.location
  if (ask.note !== undefined) args.description = ask.note
  return args
}

/** The event id a write's answer names ("… ID: abc123 …", "Event ID: abc123"), or null. */
export function writtenId(text: string): string | null {
  const m = /\b(?:Event )?ID:\s*([A-Za-z0-9_@.-]+)/i.exec(text)
  return m?.[1] ?? null
}
