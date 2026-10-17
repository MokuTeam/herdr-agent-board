import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// `board doctor` in a sandbox's fresh home: nothing installed, no herdr-wake asked.
async function doctor(box: Sandbox, language: string) {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language, wakeUrl: '', port: 9 }))
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'cli.ts'), 'doctor'], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('board doctor: what is missing, what it costs and how to fix it, in the board’s language', async () => {
  const box = await sandbox()
  const en = await doctor(box, 'en')
  assert.equal(en.code, 0, en.stderr)
  // The sandbox's PATH has Bun's folder only, not ~/.local/bin.
  assert.match(en.stdout, /^!! board command is not on PATH$/m)
  assert.match(en.stdout, /^!! Claude Code hooks are missing: SessionStart, UserPromptSubmit$/m)
  assert.match(en.stdout, /^ {5}herdr plugin action invoke agent-board\.install$/m)
  assert.match(en.stdout, /^- {2}herdr-wake is off$/m)
  assert.match(en.stdout, /\d+ things need a look\.\n$/)
  const box2 = await sandbox()
  const ru = await doctor(box2, 'ru')
  assert.match(ru.stdout, /^!! Нет хуков Claude Code: SessionStart, UserPromptSubmit$/m)
  assert.match(ru.stdout, /требуют внимания\.\n$/)
}, 20_000)
