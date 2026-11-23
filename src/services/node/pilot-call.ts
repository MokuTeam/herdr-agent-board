// Node-side MokuPilot call agent runner (#618): served only on the node's master door
// (server/routes/node.ts). Runs the forked `claude -p --input-format stream-json --output-format
// stream-json` process in the session's folder and Claude profile on this node, streams its NDJSON
// lines over SSE, proxies MokuPilot's local stateless HTTP prompter MCP through an ephemeral
// node-loopback server over the same SSE/POST channel, stores uploaded post-call files in
// ~/.meeting-copilot/calls, and queues post-call reports on this node's schedule store.
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueueReport, reportHash, reportIdentity } from '../../adapters/call-receipts.ts'
import { type ClaudeHome, sessionCwd } from '../../adapters/claude-home.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { knobMs, pace } from '../../adapters/pacing.ts'
import { addEntry, listEntries, type NewEntry } from '../../adapters/schedule-store.ts'
import { itemProfile } from '../../core/item-profile.ts'
import { sameDir } from '../../core/launch/names.ts'
import {
  claudePilotArgs,
  claudePilotEnv,
  isPilotCallId,
  MAX_MCP_BODY_BYTES,
  type PilotMcpSpec,
  parseCallFilesRequest,
  parseCheckRequest,
  parseMcpReply,
  parseReportRequest,
  parseStartRequest,
  parseStdinRequest,
} from '../../core/pilot-call.ts'
import { absoluteProfileDir, defaultProfileDir, type ProfileSet, resolveProfileDir } from '../../core/profiles.ts'
import { MAX_REPORT } from '../../core/schedule-rules.ts'
import type { Item } from '../../core/types.ts'
import type { Answer } from './bundle.ts'

export interface NodePilotCall {
  check(body: unknown): Promise<Answer>
  start(body: unknown): Promise<Answer>
  events(runId: string, req: Request): Response
  stdin(runId: string, body: unknown): Answer
  mcpReply(runId: string, body: unknown): Answer
  close(runId: string, body: unknown): Answer
  uploadFiles(body: unknown): Answer
  deliverReport(body: unknown): Promise<Answer>
  closeAll(): void
}

export interface NodePilotCallDeps {
  profiles(): ProfileSet
  homes: {
    forDir(dir: string): Pick<ClaudeHome, 'transcriptPath'>
    liveSessions(dirs: readonly string[]): Map<string, { session: { name?: string } }>
  }
  items(): Item[]
  refresh?(): void
  log(text: string): void
  claudeBin?(): string | null
  callsDir?(): string
  home?: string
  platform?: string
  env?: Record<string, string | undefined>
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess
  /** How long a run stays alive after its SSE client disconnects without reconnecting. */
  idleCloseMs?: number
  /** Maximum lifetime of one call process (default 4 hours). */
  maxLifeMs?: number
  /** Timeout for one proxied MCP HTTP request (default 60 s). */
  mcpTimeoutMs?: number
  /** How long an exited run stays readable for late SSE connections. */
  exitedRetentionMs?: number
}

interface SseEvent {
  name: 'line' | 'stderr' | 'mcp' | 'exit'
  data: string
}

interface PendingMcp {
  resolve(reply: { status: number; contentType: string; body: string }): void
  timer: ReturnType<typeof setTimeout>
}

interface RunState {
  id: string
  child: ChildProcess
  backlog: SseEvent[]
  backlogBytes: number
  listeners: Set<(ev: SseEvent) => void>
  detachers: Set<() => void>
  stderrTail: string[]
  exited: { code: number | null; stderr: string } | null
  mcpServer: ReturnType<typeof Bun.serve> | null
  mcpDir: string | null
  mcpConfigPath: string | null
  pendingMcp: Map<string, PendingMcp>
  idleTimer: ReturnType<typeof setTimeout> | null
  lifeTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  retainTimer: ReturnType<typeof setTimeout> | null
  closing: boolean
}

const MAX_BACKLOG_EVENTS = 2000
const MAX_BACKLOG_BYTES = 16 * 1024 * 1024
const STDERR_TAIL_MAX = 40
const SSE_PING_MS = 20_000
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-content-type-options': 'nosniff',
}

async function readTextBounded(req: Request, max: number): Promise<string | null> {
  const told = Number(req.headers.get('content-length'))
  if (Number.isFinite(told) && told > max) return null
  if (!req.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req.body) {
    size += chunk.byteLength
    if (size > max) return null
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const isDir = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

const newId = (): string => randomBytes(12).toString('base64url')

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Find the Claude Code CLI binary on this node. */
export function findClaudeBin(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  const explicit = env.CLAUDE_BIN?.trim()
  if (explicit && isFile(explicit)) return explicit
  const which = Bun.which('claude')
  if (which) return which
  for (const candidate of [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.local', 'share', 'mise', 'installs', 'claude', 'latest', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]) {
    if (isFile(candidate)) return candidate
  }
  return null
}

/** Resolve the session's transcript, Claude profile directory, and working directory on this node. */
async function resolveSessionTarget(
  deps: NodePilotCallDeps,
  {
    session,
    cwd: givenCwd,
    profile: givenProfile,
    profileFolder: givenFolder,
  }: { session: string; cwd: string; profile: string; profileFolder: string },
): Promise<{
  transcript: string | null
  cwd: string
  profileId: string
  profileEnvDir: string | null | undefined
}> {
  const home = deps.home ?? homedir()
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const set = deps.profiles()
  const item = deps.items().find(i => i.session?.toLowerCase() === session.toLowerCase())

  const preferredDirs: { id: string; dir: string }[] = []
  const seen = new Set<string>()
  const pushDir = (id: string, dir: string | null | undefined): void => {
    if (!dir) return
    const key = platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) return
    seen.add(key)
    preferredDirs.push({ id, dir })
  }

  if (item) {
    const p = itemProfile(item, set.list)
    pushDir(p?.id ?? item.profile ?? '', p?.dir ?? absoluteProfileDir(item.profileFolder, home, platform))
  }
  if (givenProfile) {
    const p = set.list.find(x => x.id === givenProfile)
    pushDir(p?.id ?? givenProfile, p?.dir)
  }
  if (givenFolder) {
    pushDir(givenProfile, absoluteProfileDir(givenFolder, home, platform))
  }
  for (const p of set.list) pushDir(p.id, p.dir)
  pushDir('', resolveProfileDir(env.CLAUDE_CONFIG_DIR, home, platform))

  let transcript: string | null = null
  let foundDir: string | null = null
  let foundId = givenProfile || item?.profile || ''
  const cwdHint = (givenCwd && isDir(givenCwd) ? givenCwd : '') || item?.cwd || givenCwd || ''

  for (const candidate of preferredDirs) {
    const t = deps.homes.forDir(candidate.dir).transcriptPath(session, cwdHint)
    if (t) {
      transcript = t
      foundDir = candidate.dir
      foundId = candidate.id || foundId
      break
    }
  }
  if (!foundDir && preferredDirs[0]) {
    foundDir = preferredDirs[0].dir
    foundId = preferredDirs[0].id || foundId
  }

  // Take the first existing folder: given cwd, card cwd, transcript's last cwd, then its first cwd (#657).
  const cwd = await sessionCwd(transcript, [givenCwd, item?.cwd], isDir)

  let profileEnvDir: string | null | undefined
  if (foundDir) {
    const inherited = resolveProfileDir(env.CLAUDE_CONFIG_DIR, home, platform)
    if (!sameDir(inherited, foundDir)) {
      profileEnvDir = sameDir(foundDir, defaultProfileDir(home, platform)) ? null : foundDir
    }
  }
  return { transcript, cwd, profileId: foundId, profileEnvDir }
}

/** Read a chunked stream into complete lines, calling `onLine` for each non-empty line. */
function readLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  let rest = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    const parts = (rest + chunk).split('\n')
    rest = parts.pop() ?? ''
    for (const raw of parts) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line) onLine(line)
    }
  })
  stream.on('end', () => {
    const line = rest.endsWith('\r') ? rest.slice(0, -1) : rest
    rest = ''
    if (line) onLine(line)
  })
}

export function createNodePilotCall(deps: NodePilotCallDeps): NodePilotCall {
  const runs = new Map<string, RunState>()
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const runSpawn = deps.spawn ?? spawn
  const idleCloseMs = deps.idleCloseMs ?? knobMs('BOARD_PILOT_CALL_IDLE_MS', 60_000)
  const maxLifeMs = deps.maxLifeMs ?? knobMs('BOARD_PILOT_CALL_MAX_MS', 4 * 3600 * 1000)
  const mcpTimeoutMs = deps.mcpTimeoutMs ?? knobMs('BOARD_PILOT_MCP_TIMEOUT_MS', 60_000)
  const exitedRetentionMs = deps.exitedRetentionMs ?? knobMs('BOARD_PILOT_CALL_RETAIN_MS', 60_000)

  function emit(run: RunState, ev: SseEvent): void {
    if (run.listeners.size > 0) {
      for (const fn of [...run.listeners]) fn(ev)
      return
    }
    const bytes = ev.data.length
    if (run.backlog.length < MAX_BACKLOG_EVENTS && run.backlogBytes + bytes <= MAX_BACKLOG_BYTES) {
      run.backlog.push(ev)
      run.backlogBytes += bytes
    }
  }

  function cleanupMcp(run: RunState): void {
    for (const [, pending] of run.pendingMcp) {
      clearTimeout(pending.timer)
      pending.resolve({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'call closed' } }),
      })
    }
    run.pendingMcp.clear()
    if (run.mcpServer) {
      try {
        void run.mcpServer.stop(true)
      } catch {}
      run.mcpServer = null
    }
    if (run.mcpConfigPath) {
      try {
        rmSync(run.mcpConfigPath, { force: true })
      } catch {}
      run.mcpConfigPath = null
    }
    if (run.mcpDir) {
      try {
        rmSync(run.mcpDir, { recursive: true, force: true })
      } catch {}
      run.mcpDir = null
    }
  }

  function clearTimers(run: RunState): void {
    if (run.idleTimer) clearTimeout(run.idleTimer)
    if (run.lifeTimer) clearTimeout(run.lifeTimer)
    if (run.killTimer) clearTimeout(run.killTimer)
    run.idleTimer = run.lifeTimer = run.killTimer = null
  }

  function finishRun(run: RunState, code: number | null, extraStderr = ''): void {
    if (run.exited) return
    clearTimers(run)
    cleanupMcp(run)
    const tail = extraStderr ? [...run.stderrTail, extraStderr].slice(-STDERR_TAIL_MAX) : run.stderrTail
    const stderr = tail.join('\n')
    run.exited = { code, stderr }
    emit(run, { name: 'exit', data: JSON.stringify(run.exited) })
    run.retainTimer = setTimeout(
      () => {
        runs.delete(run.id)
      },
      Math.round(exitedRetentionMs * pace()),
    )
  }

  function stopRun(run: RunState, kill: boolean): void {
    if (run.exited) return
    run.closing = true
    if (kill) {
      try {
        run.child.kill('SIGKILL')
      } catch {}
      cleanupMcp(run)
      return
    }
    try {
      run.child.stdin?.end()
    } catch {}
    if (!run.killTimer) {
      run.killTimer = setTimeout(
        () => {
          if (run.exited) return
          try {
            run.child.kill('SIGTERM')
          } catch {}
          run.killTimer = setTimeout(
            () => {
              if (run.exited) return
              try {
                run.child.kill('SIGKILL')
              } catch {}
            },
            Math.round(2000 * pace()),
          )
        },
        Math.round(5000 * pace()),
      )
    }
  }

  function startMcpProxy(
    run: RunState,
    spec: PilotMcpSpec,
  ): { dir: string; configPath: string; server: ReturnType<typeof Bun.serve> } {
    const localToken = randomBytes(32).toString('base64url')
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      reusePort: false,
      async fetch(req) {
        const host = (req.headers.get('host') ?? '').trim().toLowerCase()
        const port = server.port
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
          return new Response('forbidden host', { status: 403 })
        if (req.headers.has('origin')) return new Response('forbidden origin', { status: 403 })
        const auth = req.headers.get('authorization') ?? ''
        const m = /^Bearer\s+(\S+)$/i.exec(auth.trim())
        if (!m || !safeEqual(m[1] ?? '', localToken)) return new Response('unauthorized', { status: 401 })
        const url = new URL(req.url)
        if (url.pathname !== '/mcp') return new Response('not found', { status: 404 })
        if (req.method !== 'POST')
          return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })

        const raw = await readTextBounded(req, MAX_MCP_BODY_BYTES)
        if (raw === null) return new Response('payload too large', { status: 413 })
        if (run.exited || run.closing)
          return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'call closed' } }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          })

        const reqId = newId()
        const reply = await new Promise<{ status: number; contentType: string; body: string }>(resolve => {
          const timer = setTimeout(() => {
            run.pendingMcp.delete(reqId)
            resolve({
              status: 504,
              contentType: 'application/json',
              body: JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'mcp proxy timeout' } }),
            })
          }, mcpTimeoutMs)
          run.pendingMcp.set(reqId, { resolve, timer })
          emit(run, { name: 'mcp', data: JSON.stringify({ id: reqId, method: 'POST', body: raw }) })
        })
        if (reply.status === 202 && !reply.body) return new Response(null, { status: 202 })
        return new Response(reply.body, {
          status: reply.status,
          headers: { 'content-type': reply.contentType },
        })
      },
    })

    const runtimeBase = env.XDG_RUNTIME_DIR && isDir(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : tmpdir()
    const dir = mkdtempSync(join(runtimeBase, 'agent-board-pilot-mcp-'))
    try {
      chmodSync(dir, 0o700)
    } catch {}
    const configPath = join(dir, 'mcp.json')
    const payload = {
      mcpServers: {
        [spec.name]: {
          type: 'http',
          url: `http://127.0.0.1:${server.port}/mcp`,
          headers: { Authorization: `Bearer ${localToken}` },
          alwaysLoad: true,
        },
      },
    }
    writeFileSync(configPath, JSON.stringify(payload), { mode: 0o600, flag: 'wx' })
    try {
      chmodSync(configPath, 0o600)
    } catch {}
    return { dir, configPath, server }
  }

  return {
    async check(rawBody) {
      const parsed = parseCheckRequest(rawBody)
      if ('error' in parsed) return { status: 400, body: { ok: false, error: parsed.error } }
      const bin = deps.claudeBin ? deps.claudeBin() : findClaudeBin(env, home)
      if (!bin)
        return { status: 409, body: { ok: false, code: 'no-claude', error: 'Claude Code CLI not found on node' } }
      const target = await resolveSessionTarget(deps, parsed)
      if (!target.transcript)
        return {
          status: 404,
          body: { ok: false, code: 'no-session', error: `session ${parsed.session} transcript not found on node` },
        }
      if (!target.cwd)
        return { status: 409, body: { ok: false, code: 'no-cwd', error: 'session folder not found on node' } }
      return { status: 200, body: { ok: true, cwd: target.cwd, profile: target.profileId } }
    },

    async start(rawBody) {
      const parsed = parseStartRequest(rawBody)
      if ('error' in parsed) return { status: 400, body: { ok: false, error: parsed.error } }
      const bin = deps.claudeBin ? deps.claudeBin() : findClaudeBin(env, home)
      if (!bin)
        return { status: 409, body: { ok: false, code: 'no-claude', error: 'Claude Code CLI not found on node' } }
      const target = await resolveSessionTarget(deps, parsed)
      if (parsed.fork && !target.transcript)
        return {
          status: 404,
          body: { ok: false, code: 'no-session', error: `session ${parsed.session} transcript not found on node` },
        }
      if (!target.cwd)
        return { status: 409, body: { ok: false, code: 'no-cwd', error: 'session folder not found on node' } }

      const runId = newId()
      const run: RunState = {
        id: runId,
        child: null as unknown as ChildProcess,
        backlog: [],
        backlogBytes: 0,
        listeners: new Set(),
        detachers: new Set(),
        stderrTail: [],
        exited: null,
        mcpServer: null,
        mcpDir: null,
        mcpConfigPath: null,
        pendingMcp: new Map(),
        idleTimer: null,
        lifeTimer: null,
        killTimer: null,
        retainTimer: null,
        closing: false,
      }

      if (parsed.mcp) {
        try {
          const proxy = startMcpProxy(run, parsed.mcp)
          run.mcpServer = proxy.server
          run.mcpDir = proxy.dir
          run.mcpConfigPath = proxy.configPath
        } catch (err) {
          cleanupMcp(run)
          return {
            status: 500,
            body: { ok: false, error: `mcp proxy failed: ${err instanceof Error ? err.message : String(err)}` },
          }
        }
      }

      const args = claudePilotArgs({
        session: parsed.session,
        fork: parsed.fork,
        model: parsed.model,
        effort: parsed.effort,
        fullAccess: parsed.fullAccess,
        ...(run.mcpConfigPath && parsed.mcp
          ? { mcpConfigPath: run.mcpConfigPath, mcpName: parsed.mcp.name, mcpTools: parsed.mcp.tools }
          : {}),
      })
      const childEnv = claudePilotEnv(env, target.profileEnvDir)

      let child: ChildProcess
      try {
        child = runSpawn(bin, args, {
          cwd: target.cwd,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        cleanupMcp(run)
        return {
          status: 500,
          body: { ok: false, error: `claude failed to start: ${err instanceof Error ? err.message : String(err)}` },
        }
      }
      run.child = child
      // Absorb async EPIPE if claude exits while stdin is being written.
      child.stdin?.on('error', () => {})
      runs.set(runId, run)
      deps.log(
        `pilot-call ${runId}: started ${parsed.fork ? 'fork of ' : ''}${parsed.session.slice(0, 8)} in ${target.cwd}`,
      )

      readLines(child.stdout, line => emit(run, { name: 'line', data: JSON.stringify({ line }) }))
      readLines(child.stderr, line => {
        run.stderrTail.push(line)
        if (run.stderrTail.length > STDERR_TAIL_MAX) run.stderrTail.shift()
        emit(run, { name: 'stderr', data: JSON.stringify({ line }) })
      })
      child.once('error', err => {
        deps.log(`pilot-call ${runId}: process error: ${err.message}`)
        finishRun(run, -1, err.message)
      })
      child.once('close', code => {
        deps.log(`pilot-call ${runId}: exited (${String(code)})`)
        finishRun(run, code)
      })

      // If no SSE client attaches within idleCloseMs, reap the orphaned process.
      run.idleTimer = setTimeout(
        () => {
          if (run.listeners.size === 0 && !run.exited) {
            deps.log(`pilot-call ${runId}: no client connected in time, closing`)
            stopRun(run, true)
          }
        },
        Math.round(idleCloseMs * pace()),
      )

      run.lifeTimer = setTimeout(() => {
        if (!run.exited) {
          deps.log(`pilot-call ${runId}: max lifetime reached, closing`)
          stopRun(run, true)
        }
      }, maxLifeMs)

      return { status: 200, body: { ok: true, id: runId, cwd: target.cwd } }
    },

    events(runId, req) {
      if (!isPilotCallId(runId)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      const run = runs.get(runId)
      if (!run) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })

      if (run.idleTimer) {
        clearTimeout(run.idleTimer)
        run.idleTimer = null
      }

      const encoder = new TextEncoder()
      let closed = false
      let ping: ReturnType<typeof setInterval> | null = null
      let listener: ((ev: SseEvent) => void) | null = null

      const detach = (): void => {
        if (closed) return
        closed = true
        run.detachers.delete(detach)
        if (ping) clearInterval(ping)
        ping = null
        if (listener) run.listeners.delete(listener)
        listener = null
        if (!run.exited && run.listeners.size === 0 && !run.idleTimer) {
          run.idleTimer = setTimeout(
            () => {
              if (run.listeners.size === 0 && !run.exited) {
                deps.log(`pilot-call ${run.id}: client disconnected too long, closing`)
                stopRun(run, true)
              }
            },
            Math.round(idleCloseMs * pace()),
          )
        }
      }
      run.detachers.add(detach)

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (chunk: string): boolean => {
            if (closed) return false
            try {
              controller.enqueue(encoder.encode(chunk))
              return true
            } catch {
              detach()
              return false
            }
          }
          const send = (ev: SseEvent): void => {
            if (!write(`event: ${ev.name}\ndata: ${ev.data}\n\n`)) return
            if (ev.name === 'exit') {
              detach()
              try {
                controller.close()
              } catch {}
            }
          }

          write(': connected\n\n')
          // Flush events buffered before the stream attached.
          const buffered = run.backlog.splice(0)
          run.backlogBytes = 0
          let sentExit = false
          for (const ev of buffered) {
            send(ev)
            if (ev.name === 'exit') sentExit = true
          }
          if (run.exited) {
            if (!sentExit) send({ name: 'exit', data: JSON.stringify(run.exited) })
            return
          }
          listener = send
          run.listeners.add(send)
          ping = setInterval(
            () => {
              write(': ping\n\n')
            },
            Math.max(50, Math.round(SSE_PING_MS * pace())),
          )
        },
        cancel: detach,
      })

      req.signal.addEventListener('abort', detach, { once: true })
      return new Response(stream, { headers: SSE_HEADERS })
    },

    stdin(runId, rawBody) {
      if (!isPilotCallId(runId)) return { status: 404, body: { ok: false, error: 'not found' } }
      const run = runs.get(runId)
      if (!run) return { status: 404, body: { ok: false, error: 'not found' } }
      if (run.exited || !run.child.stdin || run.child.stdin.destroyed || !run.child.stdin.writable)
        return { status: 409, body: { ok: false, error: 'process is not running' } }
      const parsed = parseStdinRequest(rawBody)
      if ('error' in parsed) return { status: 400, body: { ok: false, error: parsed.error } }
      try {
        run.child.stdin.write(`${parsed.line}\n`)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return {
          status: 409,
          body: { ok: false, error: `stdin write failed: ${err instanceof Error ? err.message : String(err)}` },
        }
      }
    },

    mcpReply(runId, rawBody) {
      if (!isPilotCallId(runId)) return { status: 404, body: { ok: false, error: 'not found' } }
      const run = runs.get(runId)
      if (!run) return { status: 404, body: { ok: false, error: 'not found' } }
      const parsed = parseMcpReply(rawBody)
      if ('error' in parsed) return { status: 400, body: { ok: false, error: parsed.error } }
      const pending = run.pendingMcp.get(parsed.id)
      if (!pending) return { status: 404, body: { ok: false, error: 'mcp request expired or unknown' } }
      run.pendingMcp.delete(parsed.id)
      clearTimeout(pending.timer)
      pending.resolve({ status: parsed.status, contentType: parsed.contentType, body: parsed.body })
      return { status: 200, body: { ok: true } }
    },

    close(runId, rawBody) {
      if (!isPilotCallId(runId)) return { status: 404, body: { ok: false, error: 'not found' } }
      const run = runs.get(runId)
      if (!run) return { status: 404, body: { ok: false, error: 'not found' } }
      const kill = isRecord(rawBody) && rawBody.kill === true
      stopRun(run, kill)
      return { status: 200, body: { ok: true } }
    },

    uploadFiles(rawBody) {
      const parsed = parseCallFilesRequest(rawBody)
      if ('error' in parsed) return { status: 400, body: { ok: false, error: parsed.error } }
      const dir = deps.callsDir ? deps.callsDir() : join(home, '.meeting-copilot', 'calls')
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        try {
          chmodSync(dir, 0o700)
        } catch {}
        const paths: Partial<Record<'protocol' | 'transcript' | 'utterances', string>> = {}
        for (const f of parsed.files) {
          const dest = join(dir, f.name)
          const tmp = join(dir, `.upload-${newId()}.tmp`)
          try {
            writeFileSync(tmp, f.bytes, { mode: 0o600 })
            try {
              chmodSync(tmp, 0o600)
            } catch {}
            renameSync(tmp, dest)
          } catch (err) {
            try {
              rmSync(tmp, { force: true })
            } catch {}
            throw err
          }
          paths[f.kind] = dest
        }
        return { status: 200, body: { ok: true, paths } }
      } catch (err) {
        return {
          status: 500,
          body: { ok: false, error: `call files write failed: ${err instanceof Error ? err.message : String(err)}` },
        }
      }
    },

    async deliverReport(rawBody) {
      const parsed = parseReportRequest(rawBody)
      if ('error' in parsed) return { status: 400, body: { ok: false, error: parsed.error } }
      const session = parsed.session
      let report = parsed.report
      const contentHash = reportHash(report)
      if (report.length > MAX_REPORT) {
        const note = '\n\n[the report was truncated to fit the board limit]'
        report = `${report.slice(0, MAX_REPORT - note.length).trimEnd()}${note}`
      }
      const lower = session.toLowerCase()
      const item = deps.items().find(i => i.key.toLowerCase() === lower || i.session?.toLowerCase() === lower) ?? null
      const name =
        item?.name ?? deps.homes.liveSessions(deps.profiles().list.map(p => p.dir)).get(session)?.session.name ?? ''
      const now = Date.now()
      const fields: NewEntry = {
        key: parsed.reportId ? session.toLowerCase() : (item?.key ?? session),
        name,
        ...(item?.pane && { pane: item.pane }),
        ...(item?.cwd && { cwd: item.cwd }),
        kind: 'call',
        idle: true,
        text: report,
        at: now,
        next: now,
        by: 'mokupilot',
      }
      try {
        if (parsed.reportId) {
          const identity = reportIdentity(session, parsed.reportId, contentHash)
          const receipt = enqueueReport(identity, {
            findEntry: key => listEntries().find(e => isRecord(e.receipt) && e.receipt.key === key),
            createEntry: r => addEntry({ ...fields, receipt: r }),
          })
          deps.refresh?.()
          return {
            status: 200,
            body: {
              ok: true,
              id: receipt.entryId,
              text: `ok · call report ${receipt.entryId} for ${name || session.slice(0, 8)} (${receipt.state})`,
            },
          }
        }
        const entry = addEntry(fields)
        deps.refresh?.()
        return {
          status: 200,
          body: {
            ok: true,
            id: entry.id,
            text: `ok · call report ${entry.id} for ${name || session.slice(0, 8)}, typed in once the session is free`,
          },
        }
      } catch (err) {
        return {
          status: 500,
          body: { ok: false, error: err instanceof Error ? err.message : String(err) },
        }
      }
    },

    closeAll() {
      for (const run of [...runs.values()]) {
        clearTimers(run)
        if (run.retainTimer) clearTimeout(run.retainTimer)
        for (const detach of [...run.detachers]) detach()
        cleanupMcp(run)
        if (!run.exited) {
          try {
            run.child.kill('SIGKILL')
          } catch {}
        }
      }
      runs.clear()
    },
  }
}
