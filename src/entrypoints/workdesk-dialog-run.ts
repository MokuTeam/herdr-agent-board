// Run from the assigned Codex pane's shell during a coordinated cutover.
// FD 3 supplies the sealing key. Neither that key nor the two
// transient transport capabilities go into configuration, arguments or logs.
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../adapters/config-file.ts'
import { snapshot } from '../adapters/herdr.ts'
import { ROOT } from '../adapters/paths.ts'
import { object } from '../core/workdesk.ts'
import { workdeskDialogConfig } from '../core/workdesk-dialog.ts'
import { WORKDESK_DIALOG_TOOL } from '../services/workdesk-dialog-session.ts'

type Result = Record<string, unknown> | null
type Pending = (result: unknown) => void
const randomKey = () => randomBytes(32).toString('base64url')
const sleep = (ms: number) => Bun.sleep(ms)
class LaunchError extends Error {}
const PrivateSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: { headers: Record<string, string> }): WebSocket
}

function check(test: unknown, message: string): asserts test {
  if (!test) throw new LaunchError(message)
}

async function freePort(port = 0): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response(null, { status: 503 }) })
  const available = probe.port
  await probe.stop(true)
  check(available, 'Loopback port unavailable')
  return available
}

async function connect(address: string, key: string): Promise<WebSocket> {
  for (let i = 0; i < 80; i++) {
    const socket = new PrivateSocket(address, { headers: { Authorization: `Bearer ${key}` } })
    if (
      await new Promise<boolean>(resolve => {
        socket.addEventListener('open', () => resolve(true), { once: true })
        socket.addEventListener('error', () => resolve(false), { once: true })
      })
    )
      return socket
    await sleep(100)
  }
  throw new LaunchError('Private App Server startup timeout')
}

function deadline(map: Map<number, Pending>, id: number, send: () => void, ms = 5000): Promise<unknown> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      map.delete(id)
      resolve(null)
    }, ms)
    map.set(id, result => {
      clearTimeout(timeout)
      resolve(result)
    })
    try {
      send()
    } catch {
      map.get(id)?.(null)
      map.delete(id)
    }
  })
}

const unavailable = { content: [{ type: 'text', text: 'Workdesk dialogue unavailable' }], isError: true }

async function run(): Promise<number> {
  const sid = process.argv[2]
  const pane = process.env.HERDR_PANE_ID
  const cfg = loadConfig()
  const dialogue = workdeskDialogConfig(cfg.workdeskDialog, cfg.workdesk)
  const pin = dialogue?.onlyTaskId && dialogue.legacyBindings.get(dialogue.onlyTaskId)
  check(
    process.argv.length === 3 && process.stdin.isTTY && process.stdout.isTTY && pane,
    'Use the existing Herdr pane and supply its pinned SID',
  )
  check(
    dialogue?.receiver === 'launcher' && pin && pin.sessionId === sid,
    'Workdesk dialogue pin does not match the requested SID',
  )
  const readOnly = object(cfg.workdeskDialog)?.deliver !== true
  const seen = await snapshot()
  check(
    seen.panes.some(p => p.pane_id === pane),
    'The current Herdr pane was not observed',
  )
  check(
    !seen.panes.some(p => p.agent === 'codex' && p.agent_session?.value === sid),
    'The pinned Codex session is still present in Herdr',
  )
  await freePort(Number(cfg.port ?? 12422))
  let sealingKey: string
  try {
    sealingKey = readFileSync(3, 'ascii').trim()
  } catch {
    throw new LaunchError('The retained 32-byte sealing key is required on FD 3')
  } finally {
    try {
      closeSync(3)
    } catch {}
  }
  check(/^[A-Za-z0-9_-]{43}$/.test(sealingKey), 'The retained 32-byte sealing key is required on FD 3')
  const codex = Bun.which('codex')
  check(codex, 'Codex CLI unavailable')

  const appToken = randomKey()
  const mcpToken = randomKey()
  const appAddress = `ws://127.0.0.1:${await freePort()}`
  const command = (entry: string) => [process.execPath, join(ROOT, 'src', 'entrypoints', entry)]
  const boardReplies = new Map<number, Pending>()
  let rpcId = 0
  let board: Bun.Subprocess | undefined
  let native: Result
  let ready = false
  let closing = false
  let tui: Bun.Subprocess | undefined
  let socket: WebSocket | undefined
  const askBoard = (op: string, args: Record<string, unknown>) => {
    const id = ++rpcId
    const child = board
    return deadline(boardReplies, id, () => child?.send({ kind: 'workdesk-dialog', id, op, ...args }))
  }
  const mcp = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 64 * 1024,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/mcp' || req.headers.get('authorization') !== `Bearer ${mcpToken}`)
        return new Response(null, { status: 401 })
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      let msg: Result
      try {
        msg = object(await req.json())
      } catch {
        return new Response(null, { status: 400 })
      }
      if (msg?.jsonrpc !== '2.0') return new Response(null, { status: 400 })
      const id = msg.id
      if (id === undefined) return new Response(null, { status: 202 })
      const args = object(msg.params)
      const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id, result })
      if (msg.method === 'initialize')
        return reply({
          protocolVersion: args?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'board-workdesk-dialogue', version: '1' },
        })
      if (msg.method === 'ping') return reply({})
      if (msg.method === 'tools/list')
        return reply({
          tools: [
            {
              name: WORKDESK_DIALOG_TOOL.name,
              description: WORKDESK_DIALOG_TOOL.description,
              inputSchema: WORKDESK_DIALOG_TOOL.inputSchema,
            },
          ],
        })
      if (msg.method !== 'tools/call' || args?.name !== WORKDESK_DIALOG_TOOL.name || !ready || closing)
        return reply(unavailable)
      const response = object(
        await askBoard('tool', {
          request: {
            id,
            method: 'item/tool/call',
            params: { threadId: sid, tool: WORKDESK_DIALOG_TOOL.name, arguments: args.arguments ?? {} },
          },
        }),
      )
      const result = object(response?.result)
      if (result?.success !== true || !Array.isArray(result.contentItems)) return reply(unavailable)
      return reply({ content: result.contentItems.map(item => ({ type: 'text', text: object(item)?.text })) })
    },
  })
  const app = Bun.spawn(
    [
      codex,
      'app-server',
      '--listen',
      appAddress,
      '--ws-auth',
      'capability-token',
      '--ws-token-sha256',
      createHash('sha256').update(appToken).digest('hex'),
      '-c',
      'approvals_reviewer="auto_review"',
      '-c',
      'approval_policy="on-request"',
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
  )

  async function bootBoard(): Promise<void> {
    ready = false
    const child = Bun.spawn(command('server.ts'), {
      cwd: ROOT,
      stdout: 'ignore',
      stderr: 'ignore',
      ipc(value) {
        const message = object(value)
        if (message?.kind !== 'workdesk-dialog' || typeof message.id !== 'number') return
        boardReplies.get(message.id)?.(message.result)
        boardReplies.delete(message.id)
      },
    })
    board = child
    // Both readiness and attach are tied to this child, without using the shared HTTP port.
    for (let retry = 0; retry < 8 && !closing && child.exitCode === null; retry++) {
      if ((await askBoard('attach', { session: native, sealingKey, readOnly })) === true) {
        ready = true
        return
      }
    }
    throw new LaunchError('Board could not attach the pinned native session')
  }

  let restarting = false
  const restartBoard = () => {
    if (!ready || restarting || closing) return
    restarting = true
    ready = false
    const old = board
    old?.kill()
    void (async () => {
      await old?.exited
      if (!closing) await bootBoard()
    })()
      .catch(() => {
        console.error('Protected Board child restart failed')
        tui?.kill()
      })
      .finally(() => {
        restarting = false
      })
  }

  const stop = () => {
    closing = true
    tui?.kill()
    app.kill()
  }

  process.on('SIGUSR1', restartBoard)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
  try {
    socket = await connect(appAddress, appToken)
    const client = socket
    const replies = new Map<number, Pending>()
    client.addEventListener('message', event => {
      try {
        const message = object(JSON.parse(String(event.data)))
        if (typeof message?.id !== 'number') return
        replies.get(message.id)?.(message.error ? null : message.result)
        replies.delete(message.id)
      } catch {
        // Native errors are not printed.
      }
    })
    const call = (method: string, params: unknown) => {
      const id = ++rpcId
      return deadline(replies, id, () => client.send(JSON.stringify({ id, method, params })))
    }
    check(
      await call('initialize', { clientInfo: { name: 'agent-board-workdesk', version: '1' } }),
      'Private App Server initialization failed',
    )
    client.send(JSON.stringify({ method: 'initialized' }))
    native = object(
      await call('thread/resume', {
        threadId: sid,
        cwd: process.cwd(),
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
        config: {
          mcp_servers: {
            board_workdesk_dialogue: {
              url: new URL('/mcp', mcp.url).href,
              http_headers: { Authorization: `Bearer ${mcpToken}` },
            },
          },
        },
      }),
    )
    check(object(native?.thread)?.id === sid, 'Native resume did not return the pinned SID')
    // The child IPC needs the verified identity, never the content of the resumed history.
    const observed = object(await call('thread/read', { threadId: sid, includeTurns: false }))
    check(object(observed?.thread)?.id === sid, 'Private App Server did not retain the pinned SID')
    native = { thread: { id: sid } }
    await bootBoard()
    const status = object(await call('mcpServerStatus/list', { threadId: sid, serverName: 'board_workdesk_dialogue' }))
    check(JSON.stringify(status).includes(WORKDESK_DIALOG_TOOL.name), 'Pinned dialogue tool is unavailable')
    console.error(`Workdesk recipient attached to ${sid}`)
    tui = Bun.spawn(
      [codex, 'resume', sid, '--remote', appAddress, '--remote-auth-token-env', 'BOARD_PRIVATE_TUI_CAPABILITY'],
      {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, BOARD_PRIVATE_TUI_CAPABILITY: appToken },
      },
    )
    return await Promise.race([tui.exited, app.exited.then(() => 1)])
  } finally {
    closing = true
    process.off('SIGUSR1', restartBoard)
    process.off('SIGTERM', stop)
    process.off('SIGHUP', stop)
    socket?.close()
    tui?.kill()
    board?.kill()
    app.kill()
    await Promise.all([tui?.exited, board?.exited, app.exited, mcp.stop(true)])
  }
}

run()
  .then(code => {
    process.exitCode = code
  })
  .catch(error => {
    console.error(error instanceof LaunchError ? error.message : 'Private Board launch failed')
    process.exitCode = 1
  })
