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

const SPAWN_AGENT = /(?:^|[\s;&|(=])spawn-agent(?:\.ps1|\.cmd)?\s/gi
const NAME = /\s--?name(?:\s+|[=:])(?:"([^"]+)"|'([^']+)'|([^\s"';|&)]+))/i

/**
 * A Bash or PowerShell call's spawn-agent runs, in order: [{ name }] as each gave -Name or --name
 * ('' when that is a variable), the first one after it and before the next spawn-agent. One
 * without a name is left out; [] for any other call.
 */
export function spawnsOf(tool: string, input: unknown): { name: string }[] {
  if (tool !== 'Bash' && tool !== 'PowerShell') return []
  const cmd = String(rec(input)?.command ?? '')
  const starts = [...cmd.matchAll(SPAWN_AGENT)].map(m => m.index ?? 0)
  return starts.flatMap((start, i) => {
    const m = NAME.exec(cmd.slice(start, starts[i + 1] ?? cmd.length))
    if (!m) return []
    const name = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    return [{ name: name.startsWith('$') ? '' : name.slice(0, 120) }]
  })
}

/** The first of spawnsOf, or null: a call's spawn-agent for its line in the thread. */
export const spawnOf = (tool: string, input: unknown): { name: string } | null => spawnsOf(tool, input)[0] ?? null

const SPAWNED = /\bpane=([\w:.-]+)\s+name=(.+?)\s+agent=\S+/g

/** What spawn-agent printed for each session it started, in order: "pane=<id> name=<name> agent=<id>". */
export function spawnResults(text: unknown): { pane: string; name: string }[] {
  return [...String(text ?? '').matchAll(SPAWNED)].map(m => ({
    pane: m[1] ?? '',
    name: (m[2] ?? '').trim().slice(0, 120),
  }))
}

/** The first of spawnResults, or null. */
export const spawnResult = (text: unknown): { pane: string; name: string } | null => spawnResults(text)[0] ?? null
/**
 * The simple commands of a Bash or PowerShell command line, each as its words: quotes taken off,
 * here-document bodies and comments left out, a `$(` or `(` starting a command of its own. Enough to
 * tell what a command runs from what it only mentions, not a shell.
 */
export function commandWords(cmd: string, tool: 'Bash' | 'PowerShell' = 'Bash'): string[][] {
  const pwsh = tool === 'PowerShell'
  const esc = pwsh ? '`' : '\\'
  const out: string[][] = []
  let words: string[] = []
  let word: string | null = null
  const heredocs: { tag: string; tabs: boolean }[] = []
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i] ?? ''
    if (c === '\n') {
      endCommand()
      i++
      // A here-document's lines are its text, up to the line that is its tag.
      for (const doc of heredocs.splice(0)) {
        while (i < cmd.length) {
          const eol = cmd.indexOf('\n', i)
          const line = cmd.slice(i, eol < 0 ? cmd.length : eol)
          i = eol < 0 ? cmd.length : eol + 1
          if ((doc.tabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === doc.tag) break
        }
      }
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
    } else if (';&|(){}'.includes(c)) {
      endCommand()
      i++
    } else if (pwsh && c === '<' && cmd[i + 1] === '#') {
      // A PowerShell block comment, <# … #>.
      endWord()
      const end = cmd.indexOf('#>', i + 2)
      i = end < 0 ? cmd.length : end + 2
    } else if (c === '#' && word === null) {
      // A comment, to the end of the line.
      const end = cmd.indexOf('\n', i)
      i = end < 0 ? cmd.length : end
    } else if (
      pwsh &&
      c === '@' &&
      (cmd[i + 1] === '"' || cmd[i + 1] === "'") &&
      /^[ \t]*\r?\n/.test(cmd.slice(i + 2))
    ) {
      // A PowerShell here-string: its text, to a line that starts with its closing quote and @.
      const close = new RegExp(`\\n${cmd[i + 1]}@`).exec(cmd.slice(i))
      const end = close ? i + close.index + 3 : cmd.length
      word = (word ?? '') + cmd.slice(cmd.indexOf('\n', i) + 1, close ? i + close.index : cmd.length)
      i = end
    } else if (c === "'") {
      const end = cmd.indexOf("'", i + 1)
      word = (word ?? '') + cmd.slice(i + 1, end < 0 ? cmd.length : end)
      i = end < 0 ? cmd.length : end + 1
    } else if (c === '"') {
      let s = ''
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) s += cmd[i] === esc && i + 1 < cmd.length ? cmd[++i] : cmd[i]
      word = (word ?? '') + s
      i++
    } else if (c === esc) {
      // An escaped character; at the end of a line, the command goes on on the next one.
      if (cmd[i + 1] !== '\n') word = (word ?? '') + (cmd[i + 1] ?? '')
      i += 2
    } else if (!pwsh && c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      // A here-document: <<TAG, <<-TAG, <<'TAG', <<"TAG".
      endWord()
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|()<>]+))/.exec(cmd.slice(i))
      if (m) heredocs.push({ tag: m[2] ?? m[3] ?? m[4] ?? '', tabs: m[1] === '-' })
      i += m ? m[0].length : 2
    } else {
      word = (word ?? '') + c
      i++
    }
  }
  endCommand()
  return out
}

/** herdr's options that take a value, before its command and in the ones that send to a pane. */
const HERDR_VALUE_OPTIONS = new Set([
  '--session',
  '--machine',
  '--remote',
  '--remote-keybindings',
  '--until',
  '--timeout',
])
/** What herdr commands type into a pane, by the words that name them. */
const HERDR_SENDS = new Set(['agent prompt', 'agent send-keys', 'pane send-text', 'pane send-keys', 'pane run'])

/**
 * A Bash or PowerShell call that types into another pane with herdr (`herdr agent prompt <target>`,
 * `agent send-keys`, `pane send-text`, `pane send-keys`, `pane run`): [{ target, verb }] for each
 * such command it runs, `target` '' when that is a variable. A command that only mentions one (in a
 * file it writes, a message, an echo) or asks for its help is none, nor one with --current.
 */
export function promptsOf(tool: string, input: unknown): { target: string; verb: string }[] {
  if (tool !== 'Bash' && tool !== 'PowerShell') return []
  const cmd = String(rec(input)?.command ?? '')
  if (!/herdr/i.test(cmd)) return []
  const out: { target: string; verb: string }[] = []
  for (const words of commandWords(cmd, tool)) {
    let w = 0
    while (w < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[w] ?? '')) w++
    while (['env', 'command', 'exec', 'nohup'].includes(words[w] ?? '')) w++
    const exe = (words[w] ?? '').split(/[\\/]/).pop() ?? ''
    // A shell started on a command line of its own: what that line runs.
    const inner = words.findIndex((a, n) => n > w && /^-(?:c|command)$/i.test(a))
    if (/^(?:ba|z)?sh$|^(?:pwsh|powershell)(?:\.exe)?$/i.test(exe) && inner > w) {
      const shell = /^(?:pwsh|powershell)/i.test(exe) ? 'PowerShell' : 'Bash'
      out.push(...promptsOf(shell, { command: words[inner + 1] ?? '' }))
      continue
    }
    if (!/^herdr(?:\.exe)?$/i.test(exe)) continue
    const args = words.slice(w + 1)
    if (args.some(a => a === '--help' || a === '-h' || a === '--current')) continue
    const positional: string[] = []
    for (let a = 0; a < args.length && positional.length < 3; a++) {
      const arg = args[a] ?? ''
      if (HERDR_VALUE_OPTIONS.has(arg)) a++
      else if (!arg.startsWith('-')) positional.push(arg)
    }
    const verb = positional.slice(0, 2).join(' ')
    const target = positional[2]
    if (!HERDR_SENDS.has(verb) || target === undefined) continue
    out.push({ target: target.startsWith('$') ? '' : target.slice(0, 120), verb })
  }
  return out
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
