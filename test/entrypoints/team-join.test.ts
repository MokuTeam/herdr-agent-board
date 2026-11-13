// `board team join` on a bad way to the hub, and `board team roster` against an old board server
// on the board's port (#356). The hub is the one in this process (test/hub/harness.ts), behind a
// TCP proxy that stalls a connection (accepts it and never answers, as the first join did) or cuts
// it when the hub's welcome passes (the join reached the hub, the answer did not reach the board).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { type Harness, startHarness } from '../hub/harness.ts'
import { serveBoard } from '../support/board-server.ts'
import { type OldBoard, startOldBoard } from '../support/old-board.ts'
import { type ChildResult, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(40_000)

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const teamFiles = (box: Sandbox): string[] =>
  existsSync(stateOf(box)) ? readdirSync(stateOf(box)).filter(f => f.startsWith('team-')) : []
const writeConfig = (box: Sandbox, value: Record<string, unknown>): void => {
  mkdirSync(dirname(configPath(box)), { recursive: true })
  writeFileSync(configPath(box), JSON.stringify({ language: 'en', wakeUrl: '', port: 9, ...value }, null, 2))
}
const configOf = (box: Sandbox): Record<string, unknown> => JSON.parse(readFileSync(configPath(box), 'utf8'))
/** One try waits 1.5 s here, not 10; the pause between tries a fiftieth of its 1 s, 2 s (adapters/pacing.ts). */
const board = (box: Sandbox, args: string[], env: Record<string, string> = {}): Promise<ChildResult> =>
  box.run('cli', { args, env: { BOARD_TEAM_JOIN_MS: '1500', BOARD_TEST_PACE: '0.02', ...env } }).exited
const keyOf = (box: Sandbox): { pkcs8: string; pub: string } =>
  JSON.parse(readFileSync(join(stateOf(box), 'team-key.json'), 'utf8'))

type Mode = 'pass' | 'stall' | 'cut-welcome'

/** A TCP proxy to `target`; the n-th connection (from 0) gets `plan(n)`. */
function proxy(target: number, plan: (n: number) => Mode): Promise<{ url: string; close(): void }> {
  const sockets = new Set<Socket>()
  let n = 0
  const server: Server = createServer(client => {
    sockets.add(client)
    client.on('error', () => {})
    const mode = plan(n++)
    if (mode === 'stall') return void client.resume()
    const up = connect({ host: '127.0.0.1', port: target })
    sockets.add(up)
    up.on('error', () => client.destroy())
    client.on('close', () => up.destroy())
    client.pipe(up)
    up.on('data', chunk => {
      if (mode === 'cut-welcome' && chunk.includes('"t":"welcome"')) {
        up.destroy()
        client.destroy()
        return
      }
      client.write(chunk)
    })
    up.on('close', () => client.destroy())
  })
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close() {
          for (const s of sockets) s.destroy()
          server.close()
        },
      })
    }),
  )
}

describe('board team join on a bad way to the hub', () => {
  let hub: Harness
  let hubPort = 0
  beforeAll(async () => {
    hub = await startHarness()
    hubPort = Number(new URL(hub.url).port)
  })
  afterAll(() => hub.stop())

  test('the first connection hangs, as the reported one did: the next try joins, and it says what it saw', async () => {
    const p = await proxy(hubPort, n => (n === 0 ? 'stall' : 'pass'))
    try {
      const box = await sandbox()
      writeConfig(box, {})
      const r = await board(box, ['team', 'join', hub.invite(), '--hub', p.url, '--name', 'slowfirst'])
      expect(r.code).toBe(0)
      expect(r.stderr).toMatch(
        /^board: try 1 of 3: the connection did not open in 1\.5 s · TCP 127\.0\.0\.1:\d+ ok in \d+ ms; trying again\n/,
      )
      expect(r.stdout).toMatch(/^ok · joined ws:\/\/127\.0\.0\.1:\d+ as slowfirst · your key /)
      expect(configOf(box)).toMatchObject({ team: { hub: p.url, name: 'slowfirst' } })
      await hub.login(keyOf(box))
    } finally {
      p.close()
    }
  })

  test('the join reached the hub but its welcome was lost: the next try logs in with the same key and keeps it', async () => {
    const p = await proxy(hubPort, n => (n === 0 ? 'cut-welcome' : 'pass'))
    try {
      const box = await sandbox()
      writeConfig(box, {})
      const r = await board(box, ['team', 'join', hub.invite(), '--hub', p.url, '--name', 'lostwelcome'])
      expect(r.stderr).toMatch(/^board: try 1 of 3: the connection closed after the join went out, with no answer/)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('as lostwelcome (the hub knew this key already) · your key ')
      await hub.login(keyOf(box))
    } finally {
      p.close()
    }
  })

  test('no welcome ever comes back: the key is kept, config.json is not written, and the next join finds out', async () => {
    const p = await proxy(hubPort, () => 'cut-welcome')
    const invite = hub.invite()
    try {
      const box = await sandbox()
      writeConfig(box, {})
      const first = await board(box, ['team', 'join', invite, '--hub', p.url, '--name', 'nowelcome'])
      expect(first.code).toBe(1)
      expect(first.stderr).toContain('invite_invalid')
      expect(first.stderr).toContain('The join went out and may have reached the hub: this board keeps its key')
      expect(configOf(box)).not.toHaveProperty('team')
      expect(teamFiles(box)).toEqual(['team-key.json'])
      const kept = keyOf(box)
      const direct = hub.url.replace(/\/v1$/, '')
      const again = await board(box, ['team', 'join', invite, '--hub', direct, '--name', 'nowelcome'])
      expect(again.stderr).toBe('')
      expect(again.code).toBe(0)
      expect(again.stdout).toContain('(the hub knew this key already)')
      expect(keyOf(box)).toEqual(kept)
      expect(configOf(box)).toMatchObject({ team: { hub: direct, name: 'nowelcome' } })
      await hub.login(kept)
    } finally {
      p.close()
    }
  })

  test('a hub that never answers: three tries, what got through, nothing written', async () => {
    const p = await proxy(hubPort, () => 'stall')
    try {
      const box = await sandbox()
      writeConfig(box, {})
      const r = await board(box, ['team', 'join', hub.invite(), '--hub', p.url, '--name', 'nobody'])
      expect(r.code).toBe(1)
      const lines = r.stderr.trim().split('\n')
      expect(lines.slice(0, 2).map(l => l.slice(0, 18))).toEqual(['board: try 1 of 3:', 'board: try 2 of 3:'])
      expect(lines[2]).toMatch(
        /^board: the hub at ws:\/\/127\.0\.0\.1:\d+ did not answer in 3 tries: the connection did not open in 1\.5 s · TCP 127\.0\.0\.1:\d+ ok in \d+ ms$/,
      )
      expect(teamFiles(box)).toEqual([])
      expect(configOf(box)).not.toHaveProperty('team')
    } finally {
      p.close()
    }
  })

  test('nothing listens at the address: one try, TCP refused, nothing written', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, ['team', 'join', 'hab-x', '--hub', 'ws://127.0.0.1:9', '--name', 'anna'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(
      /^board: cannot reach the hub at ws:\/\/127\.0\.0\.1:9: .* · TCP 127\.0\.0\.1:9 refused\n$/,
    )
    expect(teamFiles(box)).toEqual([])
  })

  test('a name that does not resolve: the DNS step says so, one try', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, ['team', 'join', 'hab-x', '--hub', 'ws://nohub.invalid:7443', '--name', 'anna'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(
      /^board: cannot reach the hub at ws:\/\/nohub\.invalid:7443: .* · DNS nohub\.invalid: \S+\n$/,
    )
    expect(teamFiles(box)).toEqual([])
  })
})

describe('board team roster with an old board server on the port', () => {
  let old: OldBoard
  beforeAll(async () => {
    old = await startOldBoard()
  })
  afterAll(() => old.stop())

  // The system's tools: PowerShell (Windows) or lsof and ps (macOS, Linux), which the sandbox hides.
  const system =
    process.platform === 'win32'
      ? {
          BOARD_POWERSHELL_BIN_PATH: join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
        }
      : { PATH: process.env.PATH ?? '' }

  test('names the process that answers: its pid, its folder, an old board; no team file is written', async () => {
    const box = await sandbox()
    writeConfig(box, { port: old.port, team: { hub: 'ws://127.0.0.1:9', name: 'anna' } })
    const r = await board(box, ['team', 'roster'], system)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`port ${old.port} is held by a process that is not this install's board (`)
    expect(r.stderr).toContain(`pid ${old.pid} · folder `)
    expect(r.stderr.toLowerCase()).toContain(old.checkout.toLowerCase())
    expect(r.stderr).toContain('a board server older than this install (it does not answer /api/process)')
    expect(r.stderr).toContain('Stop it (often an old board server from another checkout) and open the board again')
    expect(teamFiles(box)).toEqual([])
  })

  test("this install's own board without the team running: the old message, and it says its folder on /api/process", async () => {
    const box = await sandbox()
    const { url } = await serveBoard(box, { language: 'en' })
    const port = Number(new URL(url).port)
    writeConfig(box, { port, team: { hub: 'ws://127.0.0.1:9', name: 'anna' } })
    const said = (await (await fetch(`${url}/api/process`)).json()) as { board: string; pid: number; root: string }
    expect(said.board).toBe('agent-board')
    expect(Number.isInteger(said.pid) && said.pid > 0).toBe(true)
    expect(existsSync(join(said.root, 'src', 'entrypoints', 'cli.ts'))).toBe(true)
    const r = await board(box, ['team', 'roster'], system)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('board: the board does not run the team: restart it\n')
  })
})
