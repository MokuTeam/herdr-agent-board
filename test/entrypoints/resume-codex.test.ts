import { expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, sandbox } from '../support/sandbox.ts'

const ID = '509dfc37-b58e-4851-9988-a8c7befe9f0d'

test('board resume --codex passes the exact UUID, rollout cwd and home to Codex', async () => {
  const box = await sandbox()
  const cwd = join(box.dir, 'Проект 50%')
  const home = join(box.dir, 'Codex home')
  const rolls = join(home, 'sessions', '2026', '11', '26')
  const config = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  for (const dir of [cwd, rolls, config]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(rolls, `rollout-2026-11-26T12-00-00-${ID}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd } })}\n`,
  )
  const codex = join(box.dir, 'fake-codex.ts')
  writeFileSync(
    codex,
    `
    const args = process.argv.slice(2)
    if (args.includes('--help')) console.log('--no-daemon')
    else {
      console.log(JSON.stringify({ args, cwd: process.cwd(), home: process.env.CODEX_HOME }))
      process.exit(7)
    }
  `,
  )
  writeFileSync(
    join(config, 'config.json'),
    JSON.stringify({
      codexHome: home,
      launch: { codex: [process.execPath, codex] },
    }),
  )
  const child = Bun.spawn(
    [process.execPath, join(root, 'src/entrypoints/cli.ts'), 'resume', '--codex', ID.toUpperCase()],
    {
      cwd: box.dir,
      env: { ...box.env, CODEX_HOME: join(box.dir, 'other home') },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exit, err).toBe(7)
  const ran = JSON.parse(out)
  expect(ran.args).toEqual(['--no-daemon', 'resume', ID])
  expect(realpathSync(ran.cwd)).toBe(realpathSync(cwd))
  expect(ran.home).toBe(home)
  expect(box.calls()).toEqual([])
})
