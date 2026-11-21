// `board node [token [--name <master>] | forget <id>]` (entrypoints/cli.ts, #498), run as an agent
// runs it, in a sandbox whose own config.json says whether this board is a node. The door's port
// is one of the test's own; a board started to answer it runs in the same sandbox.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logged, serveBoard, unusedPort } from '../support/board-server.ts'
import { type ChildResult, type Sandbox, sandbox, until } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const mastersPath = (box: Sandbox): string => join(stateFolder(box), 'node', 'masters.json')

/** The sandbox's own config.json: English, no herdr-wake, the web port 9 (no board) unless given. */
function writeConfig(box: Sandbox, value: Record<string, unknown>): void {
  const path = configPath(box)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ language: 'en', wakeUrl: '', port: 9, ...value }, null, 2))
}

const board = (box: Sandbox, args: string[]): Promise<ChildResult> => box.run('cli', { args, env: {} }).exited
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

describe('board node on a board that is not a node', () => {
  test('one line says so, whatever is asked, and nothing is written', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    for (const args of [['node'], ['node', 'token', '--name', 'laptop'], ['node', 'forget', 'abc']]) {
      const r = await board(box, args)
      expect([args, r.code, r.stdout, r.stderr]).toEqual([
        args,
        0,
        'this board is not a node: config.json has no `node`\n',
        '',
      ])
    }
    expect(existsSync(join(stateFolder(box), 'node'))).toBe(false)
  }, 30_000)

  test('a node key that does not check out is named, and is no node', async () => {
    const box = await sandbox()
    writeConfig(box, { node: { id: 'local', port: 0 } })
    const r = await board(box, ['node'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      "this board is not a node: config.json's `node` does not check out (id: reserved, port: port)\n",
    )
  }, 30_000)
})

describe('board node on a node', () => {
  test('token adds a master and prints its token once; the list shows it; forget takes it back', async () => {
    const box = await sandbox()
    const port = await unusedPort()
    writeConfig(box, { node: { id: 'server-1', port } })

    const empty = await board(box, ['node'])
    expect(empty.code).toBe(0)
    expect(empty.stdout).toBe(
      `node server-1 · door off: nothing of this board answers on 127.0.0.1:${port} (does the board run?)\nno master yet · \`board node token --name <master>\` adds one\n`,
    )

    const added = await board(box, ['node', 'token', '--name', 'Ноутбук дома'])
    expect(added.stderr).toBe('')
    expect(added.code).toBe(0)
    const [line, token, end] = added.stdout.split('\n')
    expect(line).toMatch(/^ok · master [0-9a-f]{12} "Ноутбук дома" added; its token, shown this once:$/)
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(end).toBe('')
    const id = /master ([0-9a-f]{12})/.exec(line ?? '')?.[1] ?? ''
    const saved = JSON.parse(readFileSync(mastersPath(box), 'utf8')) as Record<string, unknown>[]
    expect(saved).toEqual([
      {
        id,
        name: 'Ноутбук дома',
        tokenHash: sha(token ?? ''),
        pairedAt: expect.any(Number),
        seenAt: null,
        via: 'hand',
      },
    ])
    expect(readFileSync(mastersPath(box), 'utf8')).not.toContain(token ?? '')

    // A second one, named by default.
    const second = await board(box, ['node', 'token'])
    expect(second.stdout).toMatch(/^ok · master [0-9a-f]{12} "master" added/)

    const listed = await board(box, ['node'])
    const lines = listed.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe(
      `node server-1 · door off: nothing of this board answers on 127.0.0.1:${port} (does the board run?)`,
    )
    expect(lines[1]).toMatch(new RegExp(`^master ${id} "Ноутбук дома" · paired .+ · not seen yet$`))
    expect(lines[2]).toMatch(/^master [0-9a-f]{12} "master" · paired .+ · not seen yet$/)

    const forgot = await board(box, ['node', 'forget', id])
    expect([forgot.code, forgot.stdout]).toEqual([0, `ok · forgot master ${id}: its token no longer opens the door\n`])
    const again = await board(box, ['node', 'forget', id])
    expect([again.code, again.stderr]).toEqual([1, `board: no master ${id}: \`board node\` lists them\n`])
    expect((JSON.parse(readFileSync(mastersPath(box), 'utf8')) as unknown[]).length).toBe(1)

    const wrong = await board(box, ['node', 'forget'])
    expect([wrong.code, wrong.stderr]).toEqual([
      1,
      'board: usage: board node [token [--name <master>] | forget <id> | leave [<master id>]]\n',
    ])
    const bad = await board(box, ['node', 'token', '--name', ' '])
    expect([bad.code, bad.stderr]).toEqual([1, "board: a master's name: up to 64 printable characters\n"])
  }, 60_000)

  test('with the board running: the door is on, and a master that used it shows when', async () => {
    const box = await sandbox()
    const port = await unusedPort()
    const node = { id: 'server-1', port }
    writeConfig(box, { node })
    const added = await board(box, ['node', 'token', '--name', 'laptop'])
    const token = added.stdout.split('\n')[1] ?? ''
    const { proc } = await serveBoard(box, { language: 'en', node })
    await until(() => logged(proc, `node door: listening on 127.0.0.1:${port} as server-1`))
    const res = await fetch(`http://127.0.0.1:${port}/api/board`, {
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    await res.body?.cancel()
    const r = await board(box, ['node'])
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe(`node server-1 · door on 127.0.0.1:${port}`)
    expect(lines[1]).toMatch(/^master [0-9a-f]{12} "laptop" · paired .+ · seen .+$/)
  }, 60_000)
})
