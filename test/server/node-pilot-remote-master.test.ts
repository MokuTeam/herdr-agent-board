// End-to-end tests for MokuPilot with a master on another device (#700):
// - Master in link mode (mokupilot://) serves calls for sessions on the node, the master, and a third node.
// - Node's MokuPilot calls via /api/mokupilot/node-call/open + /sessions:
//   (1) local session on the node directly (works even with master offline),
//   (2) session on the remote master through the node link (with secondary profile),
//   (3) session on a third node bridged node -> master -> third node (special path chars, >64 KiB upload).
// - Security guards, offline errors, cross-device call-agent card parenting, and untouched standalone board.
import { describe, expect, onTestFinished, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CALL_AGENT_FORMAT, CALL_AGENT_VERSION } from '../../src/core/call-agent.ts'
import { projectFolderName } from '../../src/core/resume.ts'
import { serveBoard } from '../support/board-server.ts'
import { nodePair } from '../support/node-pair.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const NODE_SID = '11111111-2222-3333-4444-555555555555'
const MASTER_SID = '22222222-3333-4444-5555-666666666666'
const THIRD_SID = '33333333-4444-5555-6666-777777777777'
const FORK_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER_SID = '99999999-8888-7777-6666-555555555555'
const CALL_MASTER_SID = 'bbbbbbbb-1111-2222-3333-444444444444'
const CALL_THIRD_SID = 'cccccccc-1111-2222-3333-444444444444'
const CALL_SPOOF_MASTER_SID = 'dddddddd-1111-2222-3333-444444444444'
const CALL_SPOOF_UNGRANTED_SID = 'eeeeeeee-1111-2222-3333-444444444444'

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-remote-master-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeTranscript(claudeDir: string, cwd: string, sessionId: string): void {
  const projDir = join(claudeDir, 'projects', projectFolderName(cwd))
  mkdirSync(projDir, { recursive: true })
  writeFileSync(
    join(projDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'hello atlas' } })}\n`,
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
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || '',
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

async function exerciseRemoteBridgeGrant(o: {
  url: string
  token: string
  originSession: string
  expectedCwd: string
  expectedConfigDir: string
  expectedGreeting: string
  scheduleDir: string
  bigBodyText: string
}): Promise<void> {
  const auth = { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' }

  // Browser Origin header and bad/missing auth are rejected.
  expect((await fetch(`${o.url}/start`, { method: 'POST', body: '{}' })).status).toBe(401)
  expect(
    (
      await fetch(`${o.url}/start`, {
        method: 'POST',
        headers: { ...auth, origin: 'http://127.0.0.1:12422' },
        body: '{}',
      })
    ).status,
  ).toBe(403)

  const runRes = await fetch(`${o.url}/start`, {
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
  expect(runData.cwd).toBe(o.expectedCwd)

  const sseRes = await fetch(`${o.url}/runs/${runData.id}/events`, {
    headers: { authorization: `Bearer ${o.token}` },
  })
  expect(sseRes.status).toBe(200)

  let initPayload: Record<string, unknown> | null = null
  let mcpSeen = false
  const results: string[] = []

  await readSseUntil(sseRes, async (name, data) => {
    if (name === 'line') {
      const inner = JSON.parse((JSON.parse(data) as { line: string }).line) as Record<string, unknown>
      if (inner.type === 'system' && inner.subtype === 'init') {
        initPayload = inner
        const r1 = await fetch(`${o.url}/runs/${runData.id}/stdin`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            line: JSON.stringify({ type: 'user', message: { role: 'user', content: o.expectedGreeting } }),
          }),
        })
        expect(r1.status).toBe(200)
      } else if (inner.type === 'result') {
        results.push(String(inner.result ?? ''))
        if (results.length === 1) {
          const r2 = await fetch(`${o.url}/runs/${runData.id}/stdin`, {
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
      const req = JSON.parse(data) as { id: string; body: string }
      const rpc = JSON.parse(req.body) as { id: number; method: string; params: { name: string } }
      expect(rpc.method).toBe('tools/call')
      expect(rpc.params.name).toBe('say')
      const replyRes = await fetch(`${o.url}/runs/${runData.id}/mcp-reply`, {
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
  expect(init.cwd).toBe(o.expectedCwd)
  expect(init.claudeConfigDir).toBe(o.expectedConfigDir)
  expect(init.hasHerdr).toBe(false)
  expect(mcpSeen).toBe(true)
  expect(results[0]).toBe(`echo:${o.expectedGreeting}`)
  expect(results[1]).toContain('"shown"')

  expect(
    (
      await fetch(`${o.url}/runs/${runData.id}/close`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ kill: false }),
      })
    ).status,
  ).toBe(200)

  // Grant allows resuming the fork UUID, while refusing unrelated UUIDs and the live origin session.
  expect(
    (
      await fetch(`${o.url}/start`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ fork: false, session: OTHER_SID }),
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await fetch(`${o.url}/start`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ fork: false, session: o.originSession }),
      })
    ).status,
  ).toBe(403)

  const resumeRes = await fetch(`${o.url}/start`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ fork: false, session: FORK_SID }),
  })
  expect(resumeRes.status).toBe(200)
  const resumeData = (await resumeRes.json()) as { id: string }
  await fetch(`${o.url}/runs/${resumeData.id}/close`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ kill: true }),
  })

  // Large (>64 KiB) upload exercises the out-of-band bridge body fetch path.
  const upRes = await fetch(`${o.url}/files`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      files: [
        {
          kind: 'protocol',
          name: 'meeting_atlas.md',
          contentBase64: Buffer.from(o.bigBodyText).toString('base64'),
        },
      ],
    }),
  })
  expect(upRes.status).toBe(200)
  const upBody = (await upRes.json()) as { ok: boolean; paths: { protocol: string } }
  expect(upBody.ok).toBe(true)
  expect(readFileSync(upBody.paths.protocol, 'utf8')).toBe(o.bigBodyText)

  // Post-call report is queued on the target device's schedule store.
  const repRes = await fetch(`${o.url}/report`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ report: '# Call Report\nDiscussed atlas.' }),
  })
  expect(repRes.status).toBe(200)
  const repBody = (await repRes.json()) as { ok: boolean; id: string }
  expect(repBody.ok).toBe(true)
  expect(readdirSync(o.scheduleDir).some(f => f === `${repBody.id}.json`)).toBe(true)
  const entry = JSON.parse(readFileSync(join(o.scheduleDir, `${repBody.id}.json`), 'utf8')) as {
    key: string
    kind: string
    by: string
    text: string
  }
  expect(entry.key).toBe(o.originSession)
  expect(entry.kind).toBe('call')
  expect(entry.by).toBe('mokupilot')
  expect(entry.text).toContain('Discussed atlas.')

  // End grant: subsequent calls return 401.
  expect((await fetch(`${o.url}/end`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(200)
  expect((await fetch(`${o.url}/start`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(401)
}

describe('MokuPilot with a master on another device (#700)', () => {
  test('link mode works for node, master, and third-device cards; node MokuPilot calls local, master, and third-device sessions', async () => {
    const tmp = scratchDir()
    const fakeClaude = makeFakeClaude(tmp)
    let nodeCwd = ''
    let masterCwd = ''
    let thirdCwd = ''
    let masterWorkDir = ''

    const pair = await nodePair({
      count: 2,
      panes: (id, box) => {
        const home = box.env.HOME ?? box.dir
        if (id === 'server-1') {
          nodeCwd = join(box.dir, 'anna-local')
          mkdirSync(nodeCwd, { recursive: true })
          writeTranscript(join(home, '.claude'), nodeCwd, NODE_SID)
          return [
            {
              pane_id: 'p1',
              agent: 'claude',
              agent_session: { value: NODE_SID },
              agent_status: 'idle',
              cwd: nodeCwd,
            },
          ]
        }
        thirdCwd = join(box.dir, 'atlas проект 100%')
        mkdirSync(thirdCwd, { recursive: true })
        writeTranscript(join(home, '.claude'), thirdCwd, THIRD_SID)
        return [
          {
            pane_id: 'p1',
            agent: 'claude',
            agent_session: { value: THIRD_SID },
            agent_status: 'idle',
            cwd: thirdCwd,
          },
        ]
      },
      masterPanes: box => {
        const home = box.env.HOME ?? box.dir
        masterCwd = join(box.dir, 'ben-master')
        mkdirSync(masterCwd, { recursive: true })
        masterWorkDir = join(home, '.claude-work')
        mkdirSync(masterWorkDir, { recursive: true })
        writeTranscript(masterWorkDir, masterCwd, MASTER_SID)
        return [
          {
            pane_id: 'p2',
            agent: 'claude',
            agent_session: { value: MASTER_SID },
            agent_status: 'idle',
            cwd: masterCwd,
          },
        ]
      },
      masterSetup: box => {
        const home = box.env.HOME ?? box.dir
        const work = join(home, '.claude-work')
        mkdirSync(work, { recursive: true })
        const def = join(home, '.claude')
        mkdirSync(def, { recursive: true })
        mkdirSync(box.cards, { recursive: true })
        writeFileSync(
          join(box.cards, `${MASTER_SID}.json`),
          JSON.stringify({ key: MASTER_SID, profile: 'work', profileDir: work }),
        )
      },
      masterCfg: {
        mokupilot: { mode: 'auto' },
      },
      nodeCfg: id => (id === 'server-1' ? { node: { pilotBridge: true } } : {}),
      deviceCfg: id => (id === 'server-1' ? { pilotBridge: true } : {}),
      masterEnv: { CLAUDE_BIN: fakeClaude },
      nodeEnv: () => ({ CLAUDE_BIN: fakeClaude }),
    })

    const server1 = pair.nodes[0]
    const server2 = pair.nodes[1]
    if (!server1 || !server2) throw new Error('expected two nodes')

    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    await pair.waitDevice('server-2', d => d.link?.state === 'online')
    await until(async () => {
      const b = (await (await fetch(`${pair.master.url}/api/board`)).json()) as { items: { key: string }[] }
      return (
        b.items.some(i => i.key === `@server-1:${NODE_SID}`) &&
        b.items.some(i => i.key === MASTER_SID) &&
        b.items.some(i => i.key === `@server-2:${THIRD_SID}`)
      )
    }, 5000)

    // 1. Web UI on master in link mode:
    //    - An unregistered remote viewer (phone at 100.64.0.99) is STILL refused with nodeLink
    //      on node cards and with the wrong-account guard on secondary-profile master cards.
    //    - A viewer sharing a self-reported private LAN IP (192.168.1.50) is ALSO refused (#730).
    //    - A registered opted-in node viewer (server-1 reporting 100.64.0.50 in its node status) gets
    //      mokupilot:// links for server-1, master (secondary work profile), and server-2.
    server1.proxy.intercept = async (method, path, forward) => {
      if (method !== 'GET' || path !== '/api/node/status') return null
      const res = await forward()
      if (!res.ok) return res
      const data = (await res.json()) as Record<string, unknown>
      data.addresses = ['192.168.1.50', '100.64.0.50']
      return new Response(JSON.stringify(data), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    await pair.waitDevice('server-1', d => d.status?.addresses?.includes('100.64.0.50') ?? false)
    server1.proxy.intercept = null

    const lanHeaders = { 'x-board': '1', 'content-type': 'application/json', 'x-forwarded-for': '192.168.1.50' }
    const refusedLan = await fetch(`${pair.master.url}/api/session/${encodeURIComponent(MASTER_SID)}/mokupilot`, {
      method: 'POST',
      headers: lanHeaders,
      body: '{}',
    })
    expect(refusedLan.status).toBe(409)
    expect(((await refusedLan.json()) as { error: string }).error).toContain('wrong account')

    const phoneHeaders = { 'x-board': '1', 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.99' }
    const refusedNode = await fetch(
      `${pair.master.url}/api/session/${encodeURIComponent(`@server-1:${NODE_SID}`)}/mokupilot`,
      { method: 'POST', headers: phoneHeaders, body: '{}' },
    )
    expect(refusedNode.status).toBe(409)
    expect(((await refusedNode.json()) as { error: string }).error).toContain('master computer')

    const refusedMasterProfile = await fetch(
      `${pair.master.url}/api/session/${encodeURIComponent(MASTER_SID)}/mokupilot`,
      { method: 'POST', headers: phoneHeaders, body: '{}' },
    )
    expect(refusedMasterProfile.status).toBe(409)
    expect(((await refusedMasterProfile.json()) as { error: string }).error).toContain('wrong account')

    const remoteHeaders = { 'x-board': '1', 'content-type': 'application/json', 'x-forwarded-for': '100.64.0.50' }
    for (const [key, expectedCwd] of [
      [`@server-1:${NODE_SID}`, nodeCwd],
      [MASTER_SID, masterCwd],
      [`@server-2:${THIRD_SID}`, thirdCwd],
    ] as const) {
      const res = await fetch(`${pair.master.url}/api/session/${encodeURIComponent(key)}/mokupilot`, {
        method: 'POST',
        headers: remoteHeaders,
        body: '{}',
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; state: string; url: string; resolved: string }
      expect(body.ok).toBe(true)
      expect(body.state).toBe('link')
      expect(body.resolved).toBe('link')
      const parsedUrl = new URL(body.url)
      expect(parsedUrl.protocol).toBe('mokupilot:')
      expect(parsedUrl.host).toBe('call')
      expect(parsedUrl.searchParams.get('claude-session')).toBe(
        key.includes(':') ? key.slice(key.indexOf(':') + 1) : key,
      )
      expect(parsedUrl.searchParams.get('cwd')).toBe(expectedCwd)
    }

    // Opt-in enforcement (#730): master local and non-opted-in server-2 refuse /open and /sessions with 403.
    expect(
      (
        await fetch(`${pair.master.url}/api/mokupilot/node-call/open`, {
          method: 'POST',
          headers: { 'x-board': '1', 'content-type': 'application/json' },
          body: JSON.stringify({ session: MASTER_SID }),
        })
      ).status,
    ).toBe(403)
    expect((await fetch(`${pair.master.url}/api/mokupilot/node-call/sessions`)).status).toBe(403)
    expect(
      (
        await fetch(`${server2.url}/api/mokupilot/node-call/open`, {
          method: 'POST',
          headers: { 'x-board': '1', 'content-type': 'application/json' },
          body: JSON.stringify({ session: THIRD_SID }),
        })
      ).status,
    ).toBe(403)
    expect((await fetch(`${server2.url}/api/mokupilot/node-call/sessions`)).status).toBe(403)

    // 2. Node server-1's MokuPilot lists callable sessions across all devices.
    const sessionsRes = await fetch(`${server1.url}/api/mokupilot/node-call/sessions`)
    expect(sessionsRes.status).toBe(200)
    const sessionsBody = (await sessionsRes.json()) as {
      ok: boolean
      masterOnline: boolean
      sessions: { key: string; session: string; device: string | null }[]
    }
    expect(sessionsBody.ok).toBe(true)
    expect(sessionsBody.masterOnline).toBe(true)
    expect(sessionsBody.sessions.some(s => s.session === NODE_SID && s.device === 'server-1')).toBe(true)
    expect(sessionsBody.sessions.some(s => s.session === MASTER_SID && s.device === null)).toBe(true)
    expect(sessionsBody.sessions.some(s => s.session === THIRD_SID && s.device === 'server-2')).toBe(true)

    // Security on /open and /sessions: missing x-board or Origin header is refused.
    expect(
      (
        await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: MASTER_SID }),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
          method: 'POST',
          headers: { 'x-board': '1', origin: server1.url, 'content-type': 'application/json' },
          body: JSON.stringify({ session: MASTER_SID }),
        })
      ).status,
    ).toBe(403)
    expect(
      (await fetch(`${server1.url}/api/mokupilot/node-call/sessions`, { headers: { origin: server1.url } })).status,
    ).toBe(403)

    // 3a. Call from node server-1's MokuPilot to its OWN local session -> locality: 'local'.
    const openLocal = await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ session: NODE_SID, cwd: nodeCwd }),
    })
    expect(openLocal.status).toBe(200)
    expect(await openLocal.json()).toEqual({
      ok: true,
      locality: 'local',
      session: NODE_SID,
      cwd: nodeCwd,
      profile: 'default',
    })

    // 3b. Call from node server-1's MokuPilot to MASTER session (in secondary work profile).
    const openMaster = await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ session: MASTER_SID, cwd: masterCwd }),
    })
    expect(openMaster.status).toBe(200)
    const masterGrant = (await openMaster.json()) as {
      ok: boolean
      locality: string
      url: string
      token: string
      device: string
      parent: string
      session: string
      cwd: string
    }
    expect(masterGrant.ok).toBe(true)
    expect(masterGrant.locality).toBe('remote')
    expect(masterGrant.device).toBe('laptop')
    expect(masterGrant.parent).toBe(MASTER_SID)
    expect(masterGrant.session).toBe(MASTER_SID)
    expect(masterGrant.cwd).toBe(masterCwd)
    expect(masterGrant.url).toStartWith(`${server1.url}/api/mokupilot/node-call/`)

    await exerciseRemoteBridgeGrant({
      url: masterGrant.url,
      token: masterGrant.token,
      originSession: MASTER_SID,
      expectedCwd: masterCwd,
      expectedConfigDir: masterWorkDir,
      expectedGreeting: 'Привет, мастер cleo!',
      scheduleDir: join(stateFolder(pair.master.box), 'schedule'),
      bigBodyText: `# Master Protocol\n${'A'.repeat(72 * 1024)}`,
    })

    // 3c. Call from node server-1's MokuPilot to THIRD device (server-2) session.
    const openThird = await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ session: THIRD_SID, cwd: thirdCwd }),
    })
    expect(openThird.status).toBe(200)
    const thirdGrant = (await openThird.json()) as {
      ok: boolean
      locality: string
      url: string
      token: string
      device: string
      parent: string
      session: string
      cwd: string
    }
    expect(thirdGrant.ok).toBe(true)
    expect(thirdGrant.locality).toBe('remote')
    expect(thirdGrant.device).toBe('server-2')
    expect(thirdGrant.parent).toBe(`@server-2:${THIRD_SID}`)
    expect(thirdGrant.session).toBe(THIRD_SID)
    expect(thirdGrant.cwd).toBe(thirdCwd)

    await exerciseRemoteBridgeGrant({
      url: thirdGrant.url,
      token: thirdGrant.token,
      originSession: THIRD_SID,
      expectedCwd: thirdCwd,
      expectedConfigDir: '',
      expectedGreeting: 'Привет, третья нода ben!',
      scheduleDir: join(stateFolder(server2.box), 'schedule'),
      bigBodyText: `# Third Node Protocol\n${'B'.repeat(72 * 1024)}`,
    })

    // 4. Cross-device call-agent card parenting: call agents on server-1 with granted parents on laptop and server-2
    //    appear right after their parent cards on the master's board with inherited metadata, while ungranted
    //    cross-device parent references from server-2 or server-1 are ignored (#730).
    const callAgentsDir = join(server1.box.env.HOME ?? server1.box.dir, '.meeting-copilot', 'call-agents')
    mkdirSync(callAgentsDir, { recursive: true })
    const s2CallAgentsDir = join(server2.box.env.HOME ?? server2.box.dir, '.meeting-copilot', 'call-agents')
    mkdirSync(s2CallAgentsDir, { recursive: true })
    const nowSec = Math.floor(Date.now() / 1000)
    writeFileSync(
      join(callAgentsDir, `${CALL_MASTER_SID}.json`),
      JSON.stringify({
        format: CALL_AGENT_FORMAT,
        version: CALL_AGENT_VERSION,
        pid: process.pid,
        session_id: CALL_MASTER_SID,
        harness: 'claude',
        parent_session_id: MASTER_SID,
        config_dir: '',
        cwd: masterCwd,
        started: nowSec,
        call: 'on',
        busy: false,
        helpers: 0,
        updated: nowSec,
      }),
    )
    writeFileSync(
      join(callAgentsDir, `${CALL_THIRD_SID}.json`),
      JSON.stringify({
        format: CALL_AGENT_FORMAT,
        version: CALL_AGENT_VERSION,
        pid: process.pid,
        session_id: CALL_THIRD_SID,
        harness: 'claude',
        parent_session_id: `@server-2:${THIRD_SID}`,
        config_dir: '',
        cwd: thirdCwd,
        started: nowSec,
        call: 'on',
        busy: false,
        helpers: 0,
        updated: nowSec,
      }),
    )
    writeFileSync(
      join(callAgentsDir, `${CALL_SPOOF_UNGRANTED_SID}.json`),
      JSON.stringify({
        format: CALL_AGENT_FORMAT,
        version: CALL_AGENT_VERSION,
        pid: process.pid,
        session_id: CALL_SPOOF_UNGRANTED_SID,
        harness: 'claude',
        parent_session_id: `@server-2:${OTHER_SID}`,
        config_dir: '',
        cwd: thirdCwd,
        started: nowSec,
        call: 'on',
        busy: false,
        helpers: 0,
        updated: nowSec,
      }),
    )
    writeFileSync(
      join(s2CallAgentsDir, `${CALL_SPOOF_MASTER_SID}.json`),
      JSON.stringify({
        format: CALL_AGENT_FORMAT,
        version: CALL_AGENT_VERSION,
        pid: process.pid,
        session_id: CALL_SPOOF_MASTER_SID,
        harness: 'claude',
        parent_session_id: MASTER_SID,
        config_dir: '',
        cwd: masterCwd,
        started: nowSec,
        call: 'on',
        busy: false,
        helpers: 0,
        updated: nowSec,
      }),
    )
    // Touch server-1 and server-2 so their boards refresh immediately.
    server1.proc.send('refresh')
    server2.proc.send('refresh')
    await until(async () => {
      const b = (await (await fetch(`${pair.master.url}/api/board`)).json()) as {
        items: { key: string; call?: { parent: string | null } }[]
      }
      const keys = b.items.map(i => i.key)
      const mIdx = keys.indexOf(MASTER_SID)
      const cmIdx = keys.indexOf(`@server-1:${CALL_MASTER_SID}`)
      const tIdx = keys.indexOf(`@server-2:${THIRD_SID}`)
      const ctIdx = keys.indexOf(`@server-1:${CALL_THIRD_SID}`)
      const spoof1 = b.items.find(i => i.key === `@server-1:${CALL_SPOOF_UNGRANTED_SID}`)
      const spoof2 = b.items.find(i => i.key === `@server-2:${CALL_SPOOF_MASTER_SID}`)
      return (
        mIdx >= 0 &&
        cmIdx === mIdx + 1 &&
        tIdx >= 0 &&
        ctIdx === tIdx + 1 &&
        !!spoof1 &&
        spoof1.call?.parent === null &&
        !!spoof2 &&
        spoof2.call?.parent !== MASTER_SID
      )
    }, 8000)

    // 5. Offline resilience:
    //    (a) Cut server-2: master link-mode returns 409 offline, and server-1 /open for THIRD_SID returns 503.
    await server2.proxy.cut('drop')
    await pair.waitDevice('server-2', d => d.link?.state === 'offline')
    const linkOff = await fetch(
      `${pair.master.url}/api/session/${encodeURIComponent(`@server-2:${THIRD_SID}`)}/mokupilot`,
      {
        method: 'POST',
        headers: remoteHeaders,
        body: '{}',
      },
    )
    expect(linkOff.status).toBe(409)
    expect(((await linkOff.json()) as { error: string }).error.toLowerCase()).toContain('offline')

    const bridgeOff = await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ key: `@server-2:${THIRD_SID}` }),
    })
    expect(bridgeOff.status).toBe(503)
    expect(((await bridgeOff.json()) as { error: string }).error).toContain('server-2')
    server2.proxy.restore()
    await pair.waitDevice('server-2', d => d.link?.state === 'online')

    //    (b) Cut server-1: local session on server-1 STILL opens locally while remote session returns 503.
    await server1.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state === 'offline')
    const localWhileOffline = await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ session: NODE_SID, cwd: nodeCwd }),
    })
    expect(localWhileOffline.status).toBe(200)
    expect(((await localWhileOffline.json()) as { locality: string }).locality).toBe('local')

    const remoteWhileOffline = await fetch(`${server1.url}/api/mokupilot/node-call/open`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ session: MASTER_SID }),
    })
    expect(remoteWhileOffline.status).toBe(503)

    const offlineSessions = await fetch(`${server1.url}/api/mokupilot/node-call/sessions`)
    expect(offlineSessions.status).toBe(200)
    const offSessBody = (await offlineSessions.json()) as { masterOnline: boolean; sessions: { session: string }[] }
    expect(offSessBody.masterOnline).toBe(false)
    expect(offSessBody.sessions.some(s => s.session === NODE_SID)).toBe(true)

    server1.proxy.restore()
  }, 45_000)

  test('standalone board without node or nodes leaves /api/mokupilot/node-call/open unmounted', async () => {
    const box = await sandbox()
    const proj = join(box.dir, 'anna-standalone')
    mkdirSync(proj, { recursive: true })
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              { pane_id: 'p1', agent: 'claude', agent_session: { value: NODE_SID }, agent_status: 'idle', cwd: proj },
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    const { url } = await serveBoard(box, { language: 'en', mokupilot: { mode: 'link' } })
    const openRes = await fetch(`${url}/api/mokupilot/node-call/open`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ session: NODE_SID }),
    })
    expect(openRes.status).toBe(405)

    const linkRes = await fetch(`${url}/api/session/${NODE_SID}/mokupilot`, {
      method: 'POST',
      headers: { 'x-board': '1', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(linkRes.status).toBe(200)
    expect(await linkRes.json()).toEqual({
      ok: true,
      state: 'link',
      url: `mokupilot://call?claude-session=${NODE_SID}&cwd=${encodeURIComponent(proj)}`,
      resolved: 'link',
      why: 'mode-link',
    })
  })
})
