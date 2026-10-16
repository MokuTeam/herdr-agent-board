// Thin async wrapper over the herdr CLI. HERDR_BIN_PATH hides the socket transport
// (Unix socket or Windows named pipe), so plugins should call herdr through it.
import { execFile } from 'node:child_process'

const BIN = process.env.HERDR_BIN_PATH || 'herdr'

export class HerdrError extends Error {
  code: string | undefined
  constructor(args: string[], code: string | undefined, message: string) {
    super(`herdr ${args.slice(0, 2).join(' ')}: ${code ? `${code}: ` : ''}${message}`)
    this.code = code
  }
}

/** A herdr token value, e.g. `agent_session: { value: '<claude session id>' }`. */
export interface HerdrToken {
  value?: string
  [key: string]: unknown
}

export interface HerdrWorkspace {
  workspace_id: string
  label?: string
  [key: string]: unknown
}

export interface HerdrTab {
  tab_id: string
  workspace_id: string
  [key: string]: unknown
}

export interface HerdrPane {
  pane_id: string
  tab_id?: string
  workspace_id?: string
  /** The agent kind running in the pane ('claude', ...); absent for plain terminals. */
  agent?: string
  agent_status?: string
  agent_session?: HerdrToken | null
  cwd?: string
  label?: string
  terminal_title_stripped?: string
  tokens?: Record<string, unknown>
  [key: string]: unknown
}

export interface HerdrSnapshot {
  workspaces: HerdrWorkspace[]
  tabs: HerdrTab[]
  panes: HerdrPane[]
  focused_pane_id?: string
  [key: string]: unknown
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

function run(args: string[], timeoutMs: number | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      BIN,
      args,
      { encoding: 'utf8', timeout: timeoutMs ?? 0, windowsHide: true, maxBuffer: 32 << 20 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout)
        const out = `${asString(stdout)}${asString(stderr)}`.trim()
        let code: string | undefined
        let message = out || err.message
        try {
          const e = (JSON.parse(out) as { error?: { code?: string; message?: string } }).error
          code = e?.code
          message = e?.message ?? message
        } catch {}
        reject(new HerdrError(args, code, message))
      },
    )
  })
}

/** Run a herdr command and return the `result` of its JSON answer (null for commands that print nothing). */
export async function herdr<T = unknown>(args: string[], timeoutMs = 30_000): Promise<T> {
  const out = await run(args, timeoutMs)
  return (out.trim() ? (JSON.parse(out) as { result: T }).result : null) as T
}

/** Run a herdr command that prints plain text (pane read, agent read). */
export function herdrText(args: string[], timeoutMs = 30_000): Promise<string> {
  return run(args, timeoutMs)
}

/** Workspaces, tabs, panes and agents in one call. */
export async function snapshot(): Promise<HerdrSnapshot> {
  return (await herdr<{ snapshot: HerdrSnapshot }>(['api', 'snapshot'])).snapshot
}
