// The web-open command (a notification clicked runs it with --pane): it says why when the board
// cannot show that session, with exit code 3 for a caller that then goes to herdr.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unusedPort } from '../support/board-server.ts'
import { root, sandbox } from '../support/sandbox.ts'

test('the command: --pane with no board running exits with code 3 and says why', async () => {
  const box = await sandbox()
  const port = await unusedPort()
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port }))
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'web-open.ts'), '--pane', 'w1:p9'], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited).toBe(3)
  expect(stderr).toBe('')
  expect(stdout.trim()).toBe('The board is not running: open it once with Ctrl+B, A')
}, 15_000)
