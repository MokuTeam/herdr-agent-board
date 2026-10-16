import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { quote } from '../../src/core/install-plan.ts'
import { root, sandbox } from '../support/sandbox.ts'

// The install action end to end, only ever against a sandbox's home (HOME and USERPROFILE).
test('install: settings.json backed up and rewritten with the Bun path, shims in ~/.local/bin', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  for (const dir of [box.env.HOME, box.env.USERPROFILE] as string[]) {
    assert.ok(dir.startsWith(box.dir + sep), `${dir} is outside the sandbox`)
  }
  const claude = join(home, '.claude')
  const bin = join(home, '.local', 'bin')
  mkdirSync(claude, { recursive: true })
  mkdirSync(bin, { recursive: true })
  const own = { hooks: [{ type: 'command', command: 'echo hi' }] }
  const before = {
    model: 'opus',
    hooks: {
      SessionStart: [own, { hooks: [{ type: 'command', command: 'node "C:\\x\\agent-board\\src\\hook.mjs"' }] }],
    },
    statusLine: { type: 'command', command: 'node "C:/x/agent-board/src/statusline.mjs"' },
  }
  const original = `${JSON.stringify(before, null, 2)}\n`
  writeFileSync(join(claude, 'settings.json'), original)
  writeFileSync(join(bin, 'board.cmd'), '@echo someone else\r\n')

  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'install.ts')], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  assert.equal(await proc.exited, 0, stderr)

  const entry = (name: string): string => join(root, 'src', 'entrypoints', name)
  const command = (name: string): string => `${quote(process.execPath)} ${quote(entry(name))}`
  const ours = { hooks: [{ type: 'command', command: command('hook.ts'), timeout: 10 }] }
  assert.equal(readFileSync(join(claude, 'settings.json.bak-agent-board'), 'utf8'), original)
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')), {
    model: 'opus',
    hooks: { SessionStart: [own, ours], UserPromptSubmit: [ours] },
    statusLine: { type: 'command', command: command('statusline.ts') },
  })
  assert.ok(readFileSync(join(bin, 'board'), 'utf8').includes(`\nexec ${command('cli.ts')} "$@"\n`))
  // A board.cmd that is not ours stays.
  assert.equal(readFileSync(join(bin, 'board.cmd'), 'utf8'), '@echo someone else\r\n')
  assert.match(stdout, /skipped .*board\.cmd: exists and is not ours/)
  assert.ok(stdout.includes(`status line: ${entry('statusline.ts')}`), stdout)
})

test('install: a settings.json that is not an object is left as it was', async () => {
  const box = await sandbox()
  const claude = join(box.env.USERPROFILE as string, '.claude')
  assert.ok(claude.startsWith(box.dir + sep), `${claude} is outside the sandbox`)
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(claude, 'settings.json'), '[]\n')
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'install.ts')], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(proc.stderr).text()
  assert.equal(await proc.exited, 1)
  assert.match(stderr, /not a JSON object/)
  assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), '[]\n')
  assert.ok(!existsSync(join(claude, 'settings.json.bak-agent-board')))
})
