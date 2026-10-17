// The terminal: a session's pane or the board's shell in its folder, live, and typed into
// (services/terminals.ts). It runs commands on this computer: every request that types, opens or
// closes needs the X-Board header, the page's own Origin and fresh herdr data; the stream needs the
// per-run token. `"terminal": false` in config.json turns every route here into a 404.
import { herdr } from '../../adapters/herdr.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { t } from '../../core/lang.ts'
import type { Config, Item, Vars } from '../../core/types.ts'
import { raiseTerminal } from '../../integrations/terminal-window.ts'
import { type Terminals, type TermMessage, type TermResult, terminalOn } from '../../services/terminals.ts'
import { json, type Route } from '../http.ts'

export interface TerminalApp {
  /** The live config: `terminal` and `raiseTerminal` are read at call time. */
  cfg: Config
  terminals: Terminals
  find(key: string): Item | undefined
  /** The board goes out again (a shell opened or closed). */
  publish(): void
}

const TERM_PATH = /^\/api\/term\/([^/]+)\/(agent|shell)\/(stream|open|close|focus|input)$/
// What a page that stopped reading (asleep, half gone) may leave queued before its stream goes.
const MAX_QUEUED = 2 << 20

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-content-type-options': 'nosniff',
}

/** The screen, then line diffs, as Server-Sent Events; `watch` starts the reads and returns their stop. */
function eventStream(req: Request, watch: (send: (msg: TermMessage) => void) => () => void): Response {
  const encoder = new TextEncoder()
  let stop: (() => void) | null = null
  let done = false
  const finish = () => {
    if (done) return
    done = true
    stop?.()
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            finish()
          }
        }
        write('retry: 3000\n\n')
        stop = watch(msg => {
          if (done) return
          // A page that stopped reading does not pile the screen up here.
          if ((controller.desiredSize ?? 0) < 0) {
            finish()
            try {
              controller.error(new Error('the page stopped reading'))
            } catch {}
            return
          }
          write(msg.t === 'ping' ? ': ping\n\n' : `data: ${JSON.stringify(msg)}\n\n`)
          if (msg.t === 'gone') {
            finish()
            try {
              controller.close()
            } catch {}
          }
        })
        // Ended while it was starting: the reads stop now that there is something to stop.
        if (done) stop()
      },
      cancel: finish,
    },
    new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUED }),
  )
  req.signal.addEventListener('abort', finish, { once: true })
  return new Response(stream, { headers: SSE_HEADERS })
}

/** An error's code, else its message: herdr's own words, never what was typed. */
const whyOf = (err: unknown): string => {
  const code = isRecord(err) ? err.code : undefined
  if (code) return String(code)
  return err instanceof Error ? err.message : String(err)
}

/** The fields of an input request: off null that threw (main read them off the body), others have none. */
function fieldsOf(body: unknown): Record<string, unknown> {
  if (body === null) throw new TypeError("Cannot read properties of null (reading 'session')")
  return isRecord(body) ? body : {}
}

export function terminalRoute(app: TerminalApp): Route {
  const { terminals } = app

  /**
   * A pane on show in the page's terminal: the screen, then line diffs. EventSource sends no
   * headers, so the per-run token (only the board's page reads it) stands in for X-Board, as for
   * raw files; the stream only reads.
   */
  function stream(req: Request, refused: Response | null, item: Item, target: string): Response {
    if (refused) return refused
    if (target === 'agent' && item.sleeping) return json(409, { error: t('term.err.asleep') })
    const pane = target === 'shell' ? terminals.shellOf(item.key)?.pane : item.pane
    if (!pane) return json(404, { error: t(target === 'shell' ? 'term.err.noShell' : 'err.noPane') })
    return eventStream(req, send => terminals.watch(pane, { shell: target === 'shell', key: item.key }, send))
  }

  /** What the terminal's buttons and keys do. Errors come back as text keys (core/i18n). */
  async function action(item: Item, target: string, op: string, body: unknown): Promise<TermResult> {
    const fail = (key: string, vars: Vars = {}): TermResult => ({
      ok: false,
      error: t(key, { name: item.name, ...vars }),
    })
    try {
      if (op === 'input') {
        const fields = fieldsOf(body)
        const p = await terminals.inputPane(item, target, fields.session)
        if ('error' in p) return fail(p.error)
        const r = await terminals.input(p.pane, fields.steps)
        return r.ok ? r : fail(r.error, { why: r.why ?? '' })
      }
      if (target !== 'shell') return fail('term.err.target')
      if (op === 'open') {
        const r = await terminals.openShell(item, t('term.tabLabel', { name: item.name }))
        app.publish()
        return r.ok ? r : fail(r.error, { path: r.why ?? '' })
      }
      if (op === 'close') {
        const r = await terminals.closeShell(item.key)
        app.publish()
        return r
      }
      if (op !== 'focus') return fail('term.err.target')
      // focus: the shell's tab in herdr, and the terminal window up.
      const shell = terminals.shellOf(item.key)
      if (!shell) return fail('term.err.noShell')
      await herdr(['tab', 'focus', shell.tab])
      if (app.cfg.raiseTerminal !== false) void raiseTerminal(app.cfg)
      return { ok: true }
    } catch (err) {
      // herdr's message only: nothing typed or read goes to the log or back.
      return fail('term.err.herdr', { why: whyOf(err) })
    }
  }

  return {
    method: 'ANY',
    path: /^\/api\/term\//,
    async handle(req, ctx) {
      if (!terminalOn(app.cfg)) return json(404, { error: t('term.off') })
      const tm = TERM_PATH.exec(ctx.path)
      if (!tm) return json(404, { error: 'not found' })
      const item = app.find(tm[1] ?? '')
      if (!item) return json(404, { error: t('err.gone') })
      const target = tm[2] ?? ''
      const op = tm[3] ?? ''
      if (req.method === 'GET' && op === 'stream') return stream(req, ctx.refuse('fs-token'), item, target)
      if (req.method !== 'POST') return json(405, { error: 'method' })
      // It runs commands on this computer: only from the board's own page, on fresh herdr data.
      const refused = ctx.refuse('board-header') ?? ctx.refuse('origin') ?? ctx.refuse('fresh-data')
      if (refused) return refused
      const r = await action(item, target, op, await ctx.rawBody())
      return json(r.ok ? 200 : 409, r)
    },
  }
}
