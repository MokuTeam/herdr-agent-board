// `board compact` (#378): a session's auto-compact limit and instructions on its card, set, shown
// and cleared from the CLI; Settings' default shown where the session has none of its own.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const SID = 'c0a1e5f2-0000-4000-8000-0000000000c1'
const cardOf = (box: Sandbox): Record<string, unknown> | null => {
  const file = join(box.cards, `${SID}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}
function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

/** `board compact ...` as the session itself runs it (its id in the env, no herdr needed). */
async function compact(box: Sandbox, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'compact', ...args], {
    cwd: root,
    env: { ...box.env, CLAUDE_CODE_SESSION_ID: SID },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: `${out}${err}`.trim() }
}

test('board compact sets, shows and clears the limit; instructions too; never beats the default', async () => {
  const box = await sandbox()
  config(box)
  expect(await compact(box)).toEqual({
    code: 0,
    out: 'compact: off (no limit for this session, no default in Settings) · set one: board compact --at 300k',
  })
  const set = await compact(box, '--at', '300K', '--note', 'keep the ticket list and the open questions')
  expect(set).toEqual({
    code: 0,
    out: "ok · compact: 300k, this session's own · keeps: keep the ticket list and the open questions",
  })
  expect(cardOf(box)).toMatchObject({ compactAt: '300k', compactNote: 'keep the ticket list and the open questions' })
  expect((await compact(box, '--at', '60%')).out).toBe(
    "ok · compact: 60%, this session's own · keeps: keep the ticket list and the open questions",
  )
  expect((await compact(box, '--note', 'none')).out).toBe("ok · compact: 60%, this session's own")
  expect(cardOf(box)?.compactNote).toBeUndefined()

  // Settings' default: shown while the session has none of its own; its own never beats it.
  config(box, { compact: { at: '400k', note: 'keep the plan' } })
  expect((await compact(box, '--clear')).out).toBe("ok · compact: 400k, Settings' default · keeps (Settings): keep the plan")
  expect(cardOf(box)?.compactAt).toBeUndefined()
  expect((await compact(box, '--at', 'never')).out).toBe("ok · compact: never, this session's own")
  expect(cardOf(box)?.compactAt).toBe('never')
})

test('board compact refuses what is no limit, a stray word, and --clear with a value; the card stays as it was', async () => {
  const box = await sandbox()
  config(box)
  await compact(box, '--at', '200k')
  for (const args of [['--at', '5k'], ['--at', 'soon'], ['--at', '120%'], ['now'], ['--clear', '--at', '300k'], ['--at']]) {
    const r = await compact(box, ...args)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('usage: board compact')
  }
  expect(cardOf(box)?.compactAt).toBe('200k')
})
