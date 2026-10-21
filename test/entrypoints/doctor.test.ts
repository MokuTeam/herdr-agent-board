import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WAKE_SHIPPED } from '../../src/core/wake/config.ts'
import { unusedPort } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
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

// `board doctor` with the new wake turned on in config.json (#119).
async function doctorWith(box: Sandbox, config: Record<string, unknown>) {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...config }))
  const proc = Bun.spawn([process.execPath, join(root, 'src', 'entrypoints', 'cli.ts'), 'doctor'], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}
const stateDir = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')

test('board doctor with wake on: running on its port, how many asleep, and wakeUrl set elsewhere not used', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  mkdirSync(stateDir(box), { recursive: true })
  writeFileSync(join(stateDir(box), 'wake-status.json'), JSON.stringify({ state: 'running', at: Date.now() }))
  writeFileSync(
    join(stateDir(box), 'wake-sessions.json'),
    JSON.stringify({ 'w1:p2': { session: 's-bill', name: 'Billing', seen_at: 1, slept_at: 2 } }),
  )
  const out = await doctorWith(box, { wakeUrl: 'http://127.0.0.1:9', wake: { enabled: true, port: wake.port } })
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, new RegExp(`^ok Sleep and wake runs · on 127\\.0\\.0\\.1:${wake.port}, 1 asleep$`, 'm'))
  assert.match(out.stdout, /^- {2}wakeUrl in config\.json is not used while Sleep and wake is on$/m)
  // The sandbox's profile has no settings.json: wake's hooks are flagged, with the install to run.
  assert.match(out.stdout, /^! {2}Sleep and wake’s hooks are not in place$/m)
  assert.doesNotMatch(out.stdout, /herdr-wake|Node\.js/)
  assert.deepEqual(wake.requests(), [{ method: 'GET', path: '/status', body: null }])
}, 20_000)

test('board doctor with wake on but not answering: what to do, and where its log is', async () => {
  const box = await sandbox()
  const port = await unusedPort()
  const out = await doctorWith(box, { wakeUrl: 'http://127.0.0.1:12421', wake: { enabled: true, port } })
  assert.equal(out.code, 0, out.stderr)
  assert.match(out.stdout, new RegExp(`^! {2}Sleep and wake is on but does not answer on port ${port}$`, 'm'))
  const log = join(stateDir(box), 'wake.log').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  assert.match(out.stdout, new RegExp(`^ {5}Settings → Sleep and wake… → Start\\. Its log: ${log}$`, 'm'))
  // The default wakeUrl: no second line.
  assert.doesNotMatch(out.stdout, /wakeUrl in config\.json/)
}, 20_000)

// Before wake ships, off is today's setup: herdr-wake's line, word for word.
test.skipIf(WAKE_SHIPPED)(
  'board doctor with wake turned off in config.json, before it ships: today’s line',
  async () => {
    for (const wake of [false, { enabled: false, port: 23456 }]) {
      const box = await sandbox()
      const out = await doctorWith(box, { wakeUrl: '', wake })
      assert.match(out.stdout, /^- {2}herdr-wake is off$/m)
      assert.match(out.stdout, /Node\.js 20/)
      assert.doesNotMatch(out.stdout, /Sleep and wake/)
    }
  },
  20_000,
)

test.skipIf(!WAKE_SHIPPED)(
  'board doctor with wake turned off in config.json: off, and how to turn it on',
  async () => {
    const box = await sandbox()
    const out = await doctorWith(box, { wakeUrl: '', wake: false })
    assert.match(out.stdout, /^- {2}Sleep and wake is off$/m)
    assert.match(out.stdout, /^ {5}Turn it on in Settings → Sleep and wake…/m)
    assert.doesNotMatch(out.stdout, /herdr-wake|Node\.js|Sleep and wake’s hooks/)
  },
  20_000,
)
