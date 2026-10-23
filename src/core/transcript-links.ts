// What a transcript says about working with others: the helpers a call started (a subagent, a
// fork, a workflow), the messages it sent and the sessions it started with spawn-agent, and what
// came in from another session or a teammate. Pure: core/transcript.ts reads the lines,
// core/helpers.ts a helper's own transcript, core/links.ts the links between sessions.

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null)
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A subagent or a fork an Agent (or Task) call started; `id` once its result says. */
export interface HelperLink {
  kind: 'agent' | 'fork'
  type: string
  name: string
  background: boolean
  id: string
}
/** A Workflow call: its name, and its run once its result says. */
export interface WorkflowLink {
  name: string
  run: string
}
/**
 * A SendMessage call: to whom (a name, or the pipe a message came from), its summary and text.
 * `name`: for a reply to a pipe, whoever wrote from it; the server sets `key` to that session's.
 */
export interface SendLink {
  to: string
  summary: string
  text: string
  name?: string
  key?: string | null
}
/** A session spawn-agent started: the name it gave, the pane it printed; `failed` when it did not start. */
export interface SpawnLink {
  name: string
  pane: string
  failed?: boolean
}
export interface CallLinks {
  helper?: HelperLink
  workflow?: WorkflowLink
  send?: SendLink
  spawn?: SpawnLink
}

/**
 * Another session's or a teammate's message: who sent it and what it says. `pipe`: the message
 * pipe another session writes from (the server turns it into that session's `key`); `team`: a
 * teammate's, with its `summary`.
 */
export interface Peer {
  from: string
  text: string
  pipe?: string
  id?: string
  summary?: string
  team?: boolean
  key?: string
}

const attr = (attrs: string, name: string): string => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? ''

/**
 * What a helper was asked to do, from a user line of its transcript, without the frames Claude
 * Code puts around it: a fork's boilerplate (its directive follows), a workflow harness header,
 * a teammate message's tag. { prompt, from } (from: the teammate who asked), or null for the
 * harness's relay of the user's own request, which the helper only reads.
 */
export function promptOf(text: unknown): { prompt: string; from: string } | null {
  const t = String(text ?? '')
  const fork = /^\s*<fork-boilerplate>[\s\S]*?<\/fork-boilerplate>\s*([\s\S]*)$/.exec(t)
  if (fork) return { prompt: (fork[1] ?? '').replace(/^Your directive:\s*/, '').trim(), from: '' }
  const mate = /<teammate-message\b([^>]*)>\s*([\s\S]*?)\s*(?:<\/teammate-message>|$)/.exec(t)
  if (mate && t.trimStart().startsWith('<teammate-message'))
    return { prompt: mate[2] ?? '', from: attr(mate[1] ?? '', 'teammate_id') }
  if (/^\[Workflow harness — user request\]/.test(t)) return null
  const wf = /^\[Workflow harness[^\]]*\][^\n]*\n([\s\S]*)$/.exec(t)
  if (wf) return { prompt: (wf[1] ?? '').replace(/^ {2}/gm, '').trim(), from: '' }
  return { prompt: t.trim(), from: '' }
}

/**
 * Messages from teammates in a user line: [{ from, summary, text }]. Only a line that is one: a
 * prompt that mentions the tag stays the user's.
 */
export function teammateMessages(text: unknown): Peer[] {
  if (
    !String(text ?? '')
      .trimStart()
      .startsWith('<teammate-message')
  )
    return []
  return [...String(text ?? '').matchAll(/<teammate-message\b([^>]*)>\s*([\s\S]*?)\s*<\/teammate-message>/g)].map(
    m => ({
      from: attr(m[1] ?? '', 'teammate_id'),
      summary: clip(attr(m[1] ?? '', 'summary'), 200),
      text: m[2] ?? '',
      team: true,
    }),
  )
}

/** Another session's message, from the origin Claude Code records with it. */
export function peerOf(origin: unknown, text: unknown): Peer | null {
  const o = rec(origin)
  const tag = /<cross-session-message\b([^>]*)>\s*([\s\S]*?)\s*(?:<\/cross-session-message>|$)/.exec(String(text ?? ''))
  const body = typeof o?.body === 'string' ? o.body : (tag?.[2] ?? '')
  const from = String(o?.name || attr(tag?.[1] ?? '', 'from-name') || '')
  if (!body.trim() && !from) return null
  return {
    from: from.slice(0, 120),
    pipe: String(o?.from ?? ''),
    text: body.trim(),
    id: String(o?.msg_id ?? ''),
  }
}

/**
 * A Bash or PowerShell call that starts a session with spawn-agent: { name } as it gave -Name or
 * --name ('' when that is a variable). Null for anything else, a spawn-agent without a name included.
 */
export function spawnOf(tool: string, input: unknown): { name: string } | null {
  if (tool !== 'Bash' && tool !== 'PowerShell') return null
  const cmd = String(rec(input)?.command ?? '')
  if (!/(?:^|[\s;&|(=])spawn-agent(?:\.ps1|\.cmd)?\s/i.test(cmd)) return null
  const m = /\s--?name(?:\s+|[=:])(?:"([^"]+)"|'([^']+)'|([^\s"';|&)]+))/i.exec(cmd)
  if (!m) return null
  const name = (m[1] ?? m[2] ?? m[3] ?? '').trim()
  return { name: name.startsWith('$') ? '' : name.slice(0, 120) }
}

/** What spawn-agent printed for the session it started: "pane=<id> name=<name> agent=<id>". */
export function spawnResult(text: unknown): { pane: string; name: string } | null {
  const m = /\bpane=([\w:.-]+)\s+name=(.+?)\s+agent=\S+/.exec(String(text ?? ''))
  return m ? { pane: m[1] ?? '', name: (m[2] ?? '').trim().slice(0, 120) } : null
}

/** A Workflow call's name: its script's meta name, or the saved workflow it ran. */
function workflowName(input: Rec): string {
  const m = /\bname\s*:\s*(['"`])([^'"`\n]{1,120})\1/.exec(String(input.script ?? ''))
  return m ? (m[2] ?? '') : String(input.name ?? '').slice(0, 120)
}

/** What a call that works with others is about, for a line of its own in the thread. */
export function linkOf(name: string, rawInput: unknown): CallLinks | null {
  const input = rec(rawInput) ?? {}
  if (name === 'Agent' || name === 'Task') {
    const type = String(input.subagent_type ?? '')
    return {
      helper: {
        kind: type === 'fork' ? 'fork' : 'agent',
        type: type === 'fork' ? '' : type.slice(0, 80),
        name: String(input.name ?? '').slice(0, 80),
        background: !!input.run_in_background,
        id: '',
      },
    }
  }
  if (name === 'Workflow') return { workflow: { name: workflowName(input), run: '' } }
  if (name === 'SendMessage' && typeof input.to === 'string') {
    // The [ref] a listing adds to a name is not part of it.
    const to = input.to
      .replace(/\s*\[[^\]]*\]\s*$/, '')
      .trim()
      .slice(0, 300)
    return {
      send: {
        to,
        summary: clip(String(input.summary ?? ''), 200),
        text: typeof input.message === 'string' ? clip(input.message, 4000) : '',
      },
    }
  }
  const spawn = spawnOf(name, input)
  return spawn ? { spawn: { ...spawn, pane: '' } } : null
}

/** A result fills in what the call could not know: the helper's id, the run, the new session. */
export function linkResult(tool: CallLinks, block: Rec, result: unknown): void {
  const content = block.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(c => rec(c)?.text ?? '').join('\n')
        : ''
  const r = rec(result)
  if (tool.helper) tool.helper.id = String(r?.agentId ?? /\bagentId:\s*([A-Za-z0-9-]+)/.exec(text)?.[1] ?? '')
  if (tool.workflow) tool.workflow.run = String(r?.runId ?? /[\\/](wf_[A-Za-z0-9-]+)/.exec(text)?.[1] ?? '')
  if (tool.spawn) {
    const spawned = !block.is_error && spawnResult(typeof r?.stdout === 'string' ? r.stdout : text)
    if (spawned) Object.assign(tool.spawn, spawned)
    else tool.spawn.failed = true
  }
}
