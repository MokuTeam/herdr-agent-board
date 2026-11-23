// End-to-end tests of MokuPilot calls with sessions running on a remote node (#618):
// real master + node boards linked over the node door, fake claude CLI on the node, fake MokuPilot
// launcher on the master, verifying call start, SSE stream-json turns, bidirectional prompter MCP
// proxy over the node link, restart of the fork, file uploads, report delivery to the node's
// scheduler, and clear refusal messages when the node is offline, outdated, or in link mode.
import { describe, expect, onTestFinished, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import { nodePair } from '../support/node-pair.ts'
import { until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const ORIGIN_SID = '11111111-2222-3333-4444-555555555555'
const LOCAL_SID = '22222222-3333-4444-5555-666666666666'
const FORK_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER_SID = '99999999-8888-7777-6666-555555555555'

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-call-test-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeTranscript(homeDir: string, cwd: string, sessionId: string): void {
  const projDir = join(homeDir, '.claude', 'projects', projectFolderName(cwd))
  mkdirSync(projDir, { recursive: true })
  writeFileSync(
    join(projDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'hello' } })}\n`,
  )
}

function makeFakeClaude(dir: string): string {
  const script = join(dir, 'fake-claude.mjs')
  writeFileSync(
    script,
    `#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const mcpIdx = args.indexOf('--mcp-config')
const mcpFile = mcpIdx >= 0 ? args[mcpIdx + 1] : ''
const fork = args.includes('--fork-session')
const resumeIdx = args.indexOf('--resume')
const resume = resumeIdx >= 0 ? args[resumeIdx + 1] : ''

const sid = fork ? ${JSON.stringify(FORK_SID)} : resume
console.log(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: sid,
  cwd: process.cwd(),
  args,
  hasHerdr: Boolean(process.env.HERDR_PANE_ID),
}))

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async chunk => {
  buf += chunk
  const lines = buf.split('\\n')
  buf = lines.pop() ?? ''
  for (const raw of lines) {
    if (!raw.trim()) continue
    const msg = JSON.parse(raw)
    const text = msg?.message?.content ?? ''
    if (text === 'CALL_MCP' && mcpFile) {
      const cfg = JSON.parse(readFileSync(mcpFile, 'utf8'))
      const srv = Object.values(cfg.mcpServers)[0]
      const res = await fetch(srv.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...srv.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'say', arguments: { text: 'hi' } } }),
      })
      const body = await res.json()
      console.log(JSON.stringify({ type: 'result', is_error: false, result: 'mcp:' + JSON.stringify(body), session_id: sid }))
    } else {
      console.log(JSON.stringify({ type: 'result', is_error: false, result: 'echo:' + text, session_id: sid }))
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`,
  )
  chmodSync(script, 0o755)
  return script
}

function makeFakeMokupilot(dir: string): { bin: string; capture: string } {
  const capture = join(dir, 'captured-call.json')
  const bin = join(dir, 'fake-mokupilot.mjs')
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  url: process.env.MOKUPILOT_NODE_CALL_URL || '',
  token: process.env.MOKUPILOT_NODE_CALL_TOKEN || '',
  device: process.env.MOKUPILOT_NODE_CALL_DEVICE || '',
  parent: process.env.MOKUPILOT_NODE_CALL_PARENT || '',
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || '',
}))
`,
  )
  chmodSync(bin, 0o755)
  return { bin, capture }
}

interface CapturedCall {
  argv: string[]
  cwd: string
  url: string
  token: string
  device: string
  parent: string
  claudeConfigDir: string
}

async function readSseUntil(
  res: Response,
  onEvent: (name: string, data: string) => boolean | Promise<boolean>,
): Promise<void> {
  if (!res.body) throw new Error('missing response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      buf += decoder.decode(next.value, { stream: true })
      for (;;) {
        const sep = buf.indexOf('\n\n')
        if (sep < 0) break
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        let name = 'message'
        const dataLines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        if (dataLines.length > 0) {
          const stop = await onEvent(name, dataLines.join('\n'))
          if (stop) return
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe('MokuPilot calls with node sessions (#618)', () => {
  test('starts MokuPilot with node bridge env, streams fork turns + MCP proxy, uploads files and queues report on node', async () => {
    const tmp = scratchDir()
    const fakeClaude = makeFakeClaude(tmp)
    const fakePilot = makeFakeMokupilot(tmp)
    let nodeCwd = ''
    let localCwd = ''

    const pair = await nodePair({
      panes: (_id, box) => {
        nodeCwd = join(box.dir, 'project')
        mkdirSync(nodeCwd, { recursive: true })
        writeTranscript(box.env.HOME ?? box.dir, nodeCwd, ORIGIN_SID)
        return [
          {
            pane_id: 'p1',
            agent: 'claude',
            agent_session: { value: ORIGIN_SID },
            agent_status: 'idle',
            cwd: nodeCwd,
          },
        ]
      },
      masterPanes: box => {
        localCwd = join(box.dir, 'local-proj')
        mkdirSync(localCwd, { recursive: true })
        writeTranscript(box.env.HOME ?? box.dir, localCwd, LOCAL_SID)
        return [
          {
            pane_id: 'p2',
            agent: 'claude',
            agent_session: { value: LOCAL_SID },
            agent_status: 'idle',
            cwd: localCwd,
          },
        ]
      },
      nodeEnv: () => ({ CLAUDE_BIN: fakeClaude }),
      masterCfg: {
        mokupilot: { mode: 'local', command: [process.execPath, fakePilot.bin] },
      },
    })

    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    await until(async () => {
      const b = (await (await fetch(`${pair.master.url}/api/board`)).json()) as { items: { key: string }[] }
      return b.items.some(i => i.key === `@server-1:${ORIGIN_SID}`)
    }, 5000)

    // 1. Trigger Call on the node card.
    const startRes = await fetch(
      `${pair.master.url}/api/session/${encodeURIComponent(`@server-1:${ORIGIN_SID}`)}/mokupilot`,
      {
        method: 'POST',
        headers: { 'x-board': '1', 'content-type': 'application/json' },
        body: '{}',
      },
    )
    expect(startRes.status).toBe(200)
    const startBody = (await startRes.json()) as { ok: boolean; state?: string }
    expect(startBody.ok).toBe(true)
    expect(startBody.state).toBe('launched')

    await until(() => existsSync(fakePilot.capture), 5000)
    const cap = JSON.parse(readFileSync(fakePilot.capture, 'utf8')) as CapturedCall
    expect(cap.argv).toEqual(['call', '--claude-session', ORIGIN_SID, '--cwd', nodeCwd])
    // Token is never in argv; it arrives strictly via environment.
    expect(cap.argv.join(' ')).not.toContain(cap.token)
    expect(cap.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/mokupilot\/node-call\/[A-Za-z0-9_-]+$/)
    expect(cap.token.length).toBeGreaterThanOrEqual(20)
    expect(cap.device).toBe('server-1')
    expect(cap.parent).toBe(`@server-1:${ORIGIN_SID}`)

    const auth = { authorization: `Bearer ${cap.token}`, 'content-type': 'application/json' }

    // 2. Security checks on the master bridge: missing auth -> 401, Origin header -> 403.
    expect((await fetch(`${cap.url}/start`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect(
      (
        await fetch(`${cap.url}/start`, {
          method: 'POST',
          headers: { ...auth, origin: pair.master.url },
          body: '{}',
        })
      ).status,
    ).toBe(403)

    // 3. Start the forked call agent on the node through the master bridge (with prompter MCP spec).
    const runRes = await fetch(`${cap.url}/start`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        fork: true,
        model: 'sonnet',
        effort: 'medium',
        fullAccess: false,
        mcp: { name: 'mokupilot', tools: ['say', 'clear'] },
      }),
    })
    expect(runRes.status).toBe(200)
    const runData = (await runRes.json()) as { ok: boolean; id: string; cwd: string }
    expect(runData.ok).toBe(true)
    expect(runData.cwd).toBe(nodeCwd)

    // 4. Attach SSE stream, verify system.init, send normal turn + MCP-calling turn, verify reply.
    const sseRes = await fetch(`${cap.url}/runs/${runData.id}/events`, {
      headers: { authorization: `Bearer ${cap.token}` },
    })
    expect(sseRes.status).toBe(200)

    const results: string[] = []
    let initPayload: Record<string, unknown> | null = null
    let mcpSeen = false

    await readSseUntil(sseRes, async (name, data) => {
      if (name === 'line') {
        const inner = JSON.parse((JSON.parse(data) as { line: string }).line) as Record<string, unknown>
        if (inner.type === 'system' && inner.subtype === 'init') {
          initPayload = inner
          // Send turn 1 (UTF-8 / Cyrillic echo)
          const r1 = await fetch(`${cap.url}/runs/${runData.id}/stdin`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              line: JSON.stringify({ type: 'user', message: { role: 'user', content: 'Привет, нода!' } }),
            }),
          })
          expect(r1.status).toBe(200)
        } else if (inner.type === 'result') {
          const text = String(inner.result ?? '')
          results.push(text)
          if (results.length === 1) {
            // Send turn 2 triggering MCP call from fake claude on the node!
            const r2 = await fetch(`${cap.url}/runs/${runData.id}/stdin`, {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({
                line: JSON.stringify({ type: 'user', message: { role: 'user', content: 'CALL_MCP' } }),
              }),
            })
            expect(r2.status).toBe(200)
          } else if (results.length === 2) {
            return true
          }
        }
      } else if (name === 'mcp') {
        mcpSeen = true
        const req = JSON.parse(data) as { id: string; method: string; body: string }
        const rpc = JSON.parse(req.body) as { id: number; method: string; params: { name: string } }
        expect(rpc.method).toBe('tools/call')
        expect(rpc.params.name).toBe('say')
        const replyRes = await fetch(`${cap.url}/runs/${runData.id}/mcp-reply`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            id: req.id,
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { content: [{ type: 'text', text: 'shown' }] },
            }),
          }),
        })
        expect(replyRes.status).toBe(200)
      }
      return false
    })

    expect(initPayload).not.toBeNull()
    const init = initPayload as unknown as Record<string, unknown>
    expect(init.session_id).toBe(FORK_SID)
    expect(init.cwd).toBe(nodeCwd)
    expect(init.hasHerdr).toBe(false)
    expect(init.args).toContain('--fork-session')
    expect(init.args).toContain('--allowedTools')
    expect(mcpSeen).toBe(true)
    expect(results[0]).toBe('echo:Привет, нода!')
    expect(results[1]).toContain('"shown"')

    // Close run 1 cleanly.
    expect(
      (
        await fetch(`${cap.url}/runs/${runData.id}/close`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ kill: false }),
        })
      ).status,
    ).toBe(200)

    // 5. Grant allows resuming the fork UUID it created (fork: false), but refuses both unrelated
    //    UUIDs and resuming the live origin session in-place (403).
    const forbidden = await fetch(`${cap.url}/start`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ fork: false, session: OTHER_SID }),
    })
    expect(forbidden.status).toBe(403)

    const forbiddenOrigin = await fetch(`${cap.url}/start`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ fork: false, session: ORIGIN_SID }),
    })
    expect(forbiddenOrigin.status).toBe(403)

    const resumeFork = await fetch(`${cap.url}/start`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ fork: false, session: FORK_SID }),
    })
    expect(resumeFork.status).toBe(200)
    const resumeData = (await resumeFork.json()) as { ok: boolean; id: string }
    expect(resumeData.ok).toBe(true)
    await fetch(`${cap.url}/runs/${resumeData.id}/close`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kill: true }),
    })

    // 6. Upload call files to the node and deliver call report to the node's schedule store.
    const upRes = await fetch(`${cap.url}/files`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        files: [
          {
            kind: 'protocol',
            name: 'meeting_1.md',
            contentBase64: Buffer.from('# Meeting Notes\nDone.').toString('base64'),
          },
        ],
      }),
    })
    expect(upRes.status).toBe(200)
    const upBody = (await upRes.json()) as { ok: boolean; paths: { protocol: string } }
    expect(upBody.ok).toBe(true)
    expect(readFileSync(upBody.paths.protocol, 'utf8')).toBe('# Meeting Notes\nDone.')

    const repRes = await fetch(`${cap.url}/report`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ report: '# Call Report\nSummary from call.' }),
    })
    expect(repRes.status).toBe(200)
    const repBody = (await repRes.json()) as { ok: boolean; id: string }
    expect(repBody.ok).toBe(true)

    const firstNode = pair.nodes[0]
    if (!firstNode) throw new Error('missing node')
    const nodeSchedDir = join(stateFolder(firstNode.box), 'schedule')
    const schedFiles = readdirSync(nodeSchedDir).filter(f => f.endsWith('.json'))
    expect(schedFiles.length).toBeGreaterThanOrEqual(1)
    const entry = JSON.parse(readFileSync(join(nodeSchedDir, `${repBody.id}.json`), 'utf8')) as {
      key: string
      kind: string
      text: string
      by: string
    }
    expect(entry.key).toBe(ORIGIN_SID)
    expect(entry.kind).toBe('call')
    expect(entry.by).toBe('mokupilot')
    expect(entry.text).toContain('Summary from call.')

    // 7. End grant: subsequent calls with its token return 401.
    expect((await fetch(`${cap.url}/end`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(200)
    expect((await fetch(`${cap.url}/start`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(401)

    // 8. Local (non-node) session still takes the exact original local path with no node env vars.
    rmSync(fakePilot.capture, { force: true })
    const localRes = await fetch(`${pair.master.url}/api/session/${encodeURIComponent(LOCAL_SID)}/mokupilot`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(localRes.status).toBe(200)
    await until(() => existsSync(fakePilot.capture), 5000)
    const localCap = JSON.parse(readFileSync(fakePilot.capture, 'utf8')) as CapturedCall
    expect(localCap.argv).toEqual(['call', '--claude-session', LOCAL_SID, '--cwd', localCwd])
    expect(localCap.url).toBe('')
    expect(localCap.token).toBe('')
    expect(localCap.device).toBe('')
  })

  test('refuses with a clear reason when node is outdated, offline, or in link mode', async () => {
    const tmp = scratchDir()
    const fakeClaude = makeFakeClaude(tmp)
    const fakePilot = makeFakeMokupilot(tmp)

    const pair = await nodePair({
      panes: (_id, box) => {
        const cwd = join(box.dir, 'project')
        mkdirSync(cwd, { recursive: true })
        writeTranscript(box.env.HOME ?? box.dir, cwd, ORIGIN_SID)
        return [{ pane_id: 'p1', agent: 'claude', agent_session: { value: ORIGIN_SID }, agent_status: 'idle', cwd }]
      },
      nodeEnv: () => ({ CLAUDE_BIN: fakeClaude }),
      masterCfg: {
        mokupilot: { mode: 'local', command: [process.execPath, fakePilot.bin] },
      },
    })

    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    await until(async () => {
      const b = (await (await fetch(`${pair.master.url}/api/board`)).json()) as { items: { key: string }[] }
      return b.items.some(i => i.key === `@server-1:${ORIGIN_SID}`)
    }, 5000)

    const callUrl = `${pair.master.url}/api/session/${encodeURIComponent(`@server-1:${ORIGIN_SID}`)}/mokupilot`

    const firstNode = pair.nodes[0]
    if (!firstNode) throw new Error('missing node')
    // Outdated node: door returns 404 for /api/node/pilot-call/check.
    firstNode.proxy.intercept = async (_method, path) =>
      path === '/api/node/pilot-call/check'
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : null
    const oldRes = await fetch(callUrl, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(oldRes.status).toBe(409)
    const oldBody = (await oldRes.json()) as { ok: boolean; error: string }
    expect(oldBody.ok).toBe(false)
    expect(oldBody.error).toContain('server-1')
    expect(oldBody.error.toLowerCase()).toContain('update')
    firstNode.proxy.intercept = null

    // Offline node: link dropped -> clear offline message.
    await firstNode.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline')
    const offRes = await fetch(callUrl, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(offRes.status).toBe(409)
    const offBody = (await offRes.json()) as { ok: boolean; error: string }
    expect(offBody.ok).toBe(false)
    expect(offBody.error.toLowerCase()).toContain('offline')
    firstNode.proxy.restore()
  })

  test('starts MokuPilot call in the node folder for a moved session whose transcript starts with a foreign Windows cwd (#657)', async () => {
    const tmp = scratchDir()
    const fakeClaude = makeFakeClaude(tmp)
    const fakePilot = makeFakeMokupilot(tmp)
    let nodeCwd = ''

    const pair = await nodePair({
      panes: (_id, box) => {
        nodeCwd = join(box.dir, 'atlas work 100%')
        mkdirSync(nodeCwd, { recursive: true })
        const projDir = join(box.env.HOME ?? box.dir, '.claude', 'projects', projectFolderName(nodeCwd))
        mkdirSync(projDir, { recursive: true })
        writeFileSync(
          join(projDir, `${ORIGIN_SID}.jsonl`),
          [
            JSON.stringify({
              type: 'user',
              cwd: 'C:\\Work\\atlas',
              sessionId: ORIGIN_SID,
              message: { role: 'user', content: 'from laptop' },
            }),
            JSON.stringify({
              type: 'user',
              cwd: nodeCwd,
              sessionId: ORIGIN_SID,
              message: { role: 'user', content: 'resumed on node' },
            }),
          ].join('\n'),
        )
        return [
          {
            pane_id: 'p1',
            agent: 'claude',
            agent_session: { value: ORIGIN_SID },
            agent_status: 'idle',
            cwd: nodeCwd,
          },
        ]
      },
      nodeEnv: () => ({ CLAUDE_BIN: fakeClaude }),
      masterCfg: {
        mokupilot: { mode: 'local', command: [process.execPath, fakePilot.bin] },
      },
    })

    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    await until(async () => {
      const b = (await (await fetch(`${pair.master.url}/api/board`)).json()) as { items: { key: string }[] }
      return b.items.some(i => i.key === `@server-1:${ORIGIN_SID}`)
    }, 5000)

    const startRes = await fetch(
      `${pair.master.url}/api/session/${encodeURIComponent(`@server-1:${ORIGIN_SID}`)}/mokupilot`,
      {
        method: 'POST',
        headers: { 'x-board': '1', 'content-type': 'application/json' },
        body: '{}',
      },
    )
    expect(startRes.status).toBe(200)
    const startBody = (await startRes.json()) as { ok: boolean; state?: string }
    expect(startBody.ok).toBe(true)
    expect(startBody.state).toBe('launched')

    await until(() => existsSync(fakePilot.capture), 5000)
    const cap = JSON.parse(readFileSync(fakePilot.capture, 'utf8')) as CapturedCall
    expect(cap.argv).toEqual(['call', '--claude-session', ORIGIN_SID, '--cwd', nodeCwd])

    const auth = { authorization: `Bearer ${cap.token}`, 'content-type': 'application/json' }
    const runRes = await fetch(`${cap.url}/start`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ fork: true }),
    })
    expect(runRes.status).toBe(200)
    const runData = (await runRes.json()) as { ok: boolean; id: string; cwd: string }
    expect(runData.ok).toBe(true)
    expect(runData.cwd).toBe(nodeCwd)

    const sseRes = await fetch(`${cap.url}/runs/${runData.id}/events`, {
      headers: { authorization: `Bearer ${cap.token}` },
    })
    expect(sseRes.status).toBe(200)
    let initCwd = ''
    await readSseUntil(sseRes, (name, data) => {
      if (name !== 'line') return false
      const inner = JSON.parse((JSON.parse(data) as { line: string }).line) as Record<string, unknown>
      if (inner.type === 'system' && inner.subtype === 'init') {
        initCwd = String(inner.cwd ?? '')
        return true
      }
      return false
    })
    expect(initCwd).toBe(nodeCwd)

    await fetch(`${cap.url}/runs/${runData.id}/close`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ kill: true }),
    })
    await fetch(`${cap.url}/end`, { method: 'POST', headers: auth, body: '{}' })
  })
})
