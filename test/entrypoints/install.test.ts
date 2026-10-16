import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { planShims, quote } from '../../src/core/install-plan.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// The install action end to end, only ever against a sandbox's home (HOME and USERPROFILE).
const entry = (name: string): string => join(root, 'src', 'entrypoints', name)

/** The sandbox's home, after making sure it is one (install writes there). */
function homeOf(box: Sandbox): string {
  for (const dir of [box.env.HOME, box.env.USERPROFILE] as string[]) {
    assert.ok(dir.startsWith(box.dir + sep), `${dir} is outside the sandbox`)
  }
  return box.env.USERPROFILE as string
}

async function install(box: Sandbox, bun = process.execPath) {
  homeOf(box)
  const proc = Bun.spawn([bun, entry('install.ts')], { cwd: root, env: box.env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('install: settings.json backed up and rewritten with the Bun path, shims in ~/.local/bin', async () => {
  const box = await sandbox()
  const home = homeOf(box)
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

  const { code, stdout, stderr } = await install(box)
  assert.equal(code, 0, stderr)

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

test('install: a status line someone else set stays, and install says so', async () => {
  const box = await sandbox()
  const claude = join(homeOf(box), '.claude')
  mkdirSync(claude, { recursive: true })
  // Not our status line, though the file it runs has our hook's name.
  const line = { type: 'command', command: 'node "C:/x/agent-board/src/hook.mjs"' }
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ statusLine: line }))
  const { code, stdout, stderr } = await install(box)
  assert.equal(code, 0, stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')).statusLine, line)
  assert.ok(stdout.includes('status line: left as it was (not ours)'), stdout)
})

test('install: a settings.json that is not an object is left as it was', async () => {
  const box = await sandbox()
  const claude = join(homeOf(box), '.claude')
  mkdirSync(claude, { recursive: true })
  writeFileSync(join(claude, 'settings.json'), '[]\n')
  const { code, stderr } = await install(box)
  assert.equal(code, 1)
  assert.match(stderr, /not a JSON object/)
  assert.equal(readFileSync(join(claude, 'settings.json'), 'utf8'), '[]\n')
  assert.ok(!existsSync(join(claude, 'settings.json.bak-agent-board')))
})

// board.cmd under a Windows user name that is not ASCII: Bun itself lives under it (%USERPROFILE%\.bun).
const windows = process.platform === 'win32'
const cmdExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')

/** This Bun under a Cyrillic folder in the sandbox: a hard link, else a copy. */
function cyrillicBun(box: Sandbox): string {
  const dir = join(box.dir, 'Имя пользователя', '.bun', 'bin')
  mkdirSync(dir, { recursive: true })
  const bun = join(dir, 'bun.exe')
  try {
    linkSync(process.execPath, bun)
  } catch {
    copyFileSync(process.execPath, bun)
  }
  return bun
}

/** `cmd /c` with the console in code page `cp`, running `line`; System32 on PATH, as in any console. */
function underCodePage(box: Sandbox, cp: string, line: string) {
  const env = { ...box.env, PATH: `${dirname(cmdExe)};${box.env.PATH}` }
  const proc = Bun.spawnSync([cmdExe, '/d', '/s', '/c', `"chcp ${cp} >nul & ${line}"`], {
    env,
    windowsVerbatimArguments: true,
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

test.skipIf(!windows)(
  'board.cmd with Cyrillic paths runs under code pages 866, 437 and 65001: arguments through, exit code and code page kept',
  async () => {
    const box = await sandbox()
    const bun = cyrillicBun(box)
    const cli = join(box.dir, 'Имя пользователя', 'плагин', 'cli.ts')
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)))\nprocess.exit(3)\n')
    const shim = join(box.dir, 'Имя пользователя', 'board.cmd')
    // As install writes it: a string, so UTF-8 without a BOM.
    writeFileSync(shim, planShims({ bun, cli, hook: '', statusline: '', binDir: dirname(shim) })['board.cmd'])
    for (const cp of ['866', '437', '65001']) {
      const run = underCodePage(box, cp, `"${shim}" one "two words" Жук`)
      assert.equal(run.code, 3, `${cp}: ${run.stdout}${run.stderr}`)
      assert.equal(run.stdout, '["one","two words","Жук"]\n', cp)
      assert.equal(run.stderr, '', cp)
      const after = underCodePage(box, cp, `call "${shim}" & chcp`)
      assert.match(after.stdout.trim().split('\n').at(-1) ?? '', new RegExp(`\\b${cp}\\b`), `${cp}: ${after.stdout}`)
    }
  },
  20_000,
)

test.skipIf(!windows)(
  'install run by a Bun under a Cyrillic folder writes a board.cmd (UTF-8, no BOM) that runs under code page 866',
  async () => {
    const box = await sandbox()
    const bun = cyrillicBun(box)
    const { code, stderr } = await install(box, bun)
    assert.equal(code, 0, stderr)
    const shim = join(homeOf(box), '.local', 'bin', 'board.cmd')
    const bytes = readFileSync(shim)
    assert.deepEqual([...bytes.subarray(0, 4)], [...Buffer.from('@rem')], 'no BOM')
    const expected = planShims({ bun, cli: entry('cli.ts'), hook: '', statusline: '', binDir: '' })['board.cmd']
    assert.deepEqual(bytes, Buffer.from(expected, 'utf8'))
    const help = underCodePage(box, '866', `"${shim}" help`)
    assert.equal(help.code, 0, help.stdout + help.stderr)
    assert.match(help.stdout, /^board \[cat <id>/)
    const unknown = underCodePage(box, '866', `"${shim}" frobnicate --session 11111111-2222-3333-4444-555555555555`)
    assert.equal(unknown.code, 1, unknown.stdout + unknown.stderr)
    assert.match(unknown.stderr, /^board: unknown command "frobnicate"/)
  },
  20_000,
)
