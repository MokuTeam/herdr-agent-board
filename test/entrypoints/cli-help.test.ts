// `board <command> --help` and `-h` print that command's usage and do nothing else (#305), and
// after a lone `--` the board reads no flag of its own: the words reach the command as text (#404).
// Child processes run the board command in a sandbox against the fake herdr; port 9 answers
// nothing and wake is off, so no command reaches a live board or wake.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(120_000)

const SID = '11111111-2222-3333-4444-555555555555'

function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ language: 'en', port: 9, wakeUrl: 'http://127.0.0.1:9/', wake: false, ...extra }),
  )
}

/** The board command; one that has not ended in 20 s is stopped (`board mcp` serves stdin). */
async function cli(box: Sandbox, args: string[]): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), ...args], {
    cwd: box.dir,
    // A file that is not there: `remote on` on a build that runs it reaches no real Tailscale.
    env: { ...box.env, TAILSCALE_BIN_PATH: join(box.dir, 'no-tailscale.exe') },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => proc.kill(), 20_000)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, out: `${out}${err}`.trim() }
}

/** Every file under the sandbox's home, config and state folders, with its content, and herdr's calls. */
function snapshot(box: Sandbox): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      // Bun's own cache under the sandbox's home fills as the children start.
      if (name === '.bun') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(box.dir, path)] = readFileSync(path).toString('base64')
    }
  }
  for (const dir of [box.env.HOME, box.env.APPDATA, box.env.LOCALAPPDATA]) walk(dir as string)
  files.herdrCalls = JSON.stringify(box.calls())
  return files
}

const cardOf = (box: Sandbox, key = SID): Record<string, unknown> | null => {
  const file = join(box.cards, `${key}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

// Every command the board command takes, each with words that would make it act.
const COMMANDS: string[][] = [
  ['cat', 'anna', 'Anna'],
  ['doing', 'fix the import'],
  ['wait', 'the CI run'],
  ['ask', 'which branch?'],
  ['done', 'merged'],
  ['clear'],
  ['favorite'],
  ['list'],
  ['cats'],
  ['remind', 'in', '30m', 'check the CI run'],
  ['every', '0 9 * * 1-5', 'check the inbox'],
  ['restart', 'after the settings change'],
  ['archive'],
  ['sleep', 'anna'],
  ['move', 'anna', '--profile', 'work'],
  ['fork', 'look at the logs'],
  ['schedule'],
  ['unschedule', 'all'],
  ['call-report', '--file', 'report.md'],
  ['remote', 'on'],
  ['tunnel', 'on'],
  ['doctor'],
  ['presence', 'away'],
  ['away', 'on'],
  ['journal', '--since', '3h'],
  ['team', 'roster'],
  ['todo', 'add', 'send the invoice'],
  ['compact', '--at', '60%'],
  ['resume', SID],
  ['secret', 'request', '--title', 'deploy key', '--sink', 'demo'],
  ['cal', 'add', '--title', 'standup', '--start', 'tomorrow 9:00', '--minutes', '15'],
  ['thread', 'new', 'Import mapping'],
  ['workdesk', 'workers', 'complete'],
  ['mcp'],
  ['backup', 'now'],
  ['db', 'restore'],
  ['time', 'add', '30m', 'review'],
  ['tg-key'],
]

const OWN_HELP = ['thread', 'time', 'cal']

/** Runs a few at a time: six agents may share the machine. */
async function eachLimited<T>(list: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...list]
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x)
    }),
  )
}

test('board <command> --help and -h print its usage, exit 0 and change nothing, for every command', async () => {
  const wrong: string[] = []
  await eachLimited(COMMANDS, 4, async ([cmd = '', ...words]) => {
    const box = await sandbox()
    config(box, { todos: true, threads: true, time: true })
    const before = snapshot(box)
    for (const args of [
      [cmd, '--help'],
      [cmd, ...words, '-h'],
      ['--session', SID, cmd, ...words, '--help'],
    ]) {
      const r = await cli(box, args)
      // thread, time and cal print a help of their own that names the command; tg-key, which the
      // usage leaves out, gets all of it.
      const usage = OWN_HELP.includes(cmd)
        ? r.out.includes(`board ${cmd}`)
        : r.out.startsWith(cmd === 'tg-key' ? 'board [cat ' : `usage: board ${cmd}`)
      if (r.code !== 0 || !usage) wrong.push(`${args.join(' ')} -> ${r.code}: ${r.out.slice(0, 120)}`)
      const after = snapshot(box)
      const changed = Object.keys({ ...before, ...after }).filter(k => before[k] !== after[k])
      if (changed.length) wrong.push(`${args.join(' ')} changed ${changed.join(', ')}`)
    }
  })
  expect(wrong).toEqual([])
})

test('the help of a command is its own lines of the usage; an unknown one gets the whole usage', async () => {
  const box = await sandbox()
  config(box)
  expect((await cli(box, ['doing', '--help'])).out).toBe('usage: board doing <text>')
  expect((await cli(box, ['away', '-h'])).out).toBe('usage: board away [on | off]')
  // team and workdesk: the fuller usage they print for a wrong word.
  const team = (await cli(box, ['team', '--help'])).out
  expect(team).toStartWith('usage: board team join ')
  expect(team).toContain(' | board team inbox [--unread] [--json] | ')
  expect((await cli(box, ['workdesk', '-h'])).out).toBe(
    'usage: board workdesk workers link <SID> | unlink <SID> | complete | incomplete',
  )
  // `board -- x` is no command.
  expect((await cli(box, ['--session', SID, '--', 'doing'])).out).toStartWith('board: unknown command "--"')
  expect((await cli(box, ['tg-key', '--help'])).out).toStartWith('board [cat <id>')
  // A word that only contains it is text.
  expect((await cli(box, ['--session', SID, 'doing', 'fix the -h flag'])).code).toBe(0)
  expect(cardOf(box)?.doing).toBe('fix the -h flag')
})

// The board's own flags, each as words after a lone --.
const AFTER = [
  ['--idle'],
  ['--when-free'],
  ['--name', 'anna'],
  ['--session', 'ben'],
  ['--self'],
  ['--pi-session', 'x'],
  ['--help'],
  ['-h'],
]

test('after --, the card commands take the board flags as their text', async () => {
  const box = await sandbox()
  config(box)
  for (const cmd of ['doing', 'wait', 'ask', 'done']) {
    for (const words of AFTER) {
      const r = await cli(box, ['--session', SID, cmd, '--', ...words])
      expect(r.code, `${cmd} -- ${words.join(' ')}: ${r.out}`).toBe(0)
      const field = cmd === 'done' ? 'result' : cmd
      expect(cardOf(box)?.[field]).toBe(words.join(' '))
    }
  }
  // Before --, --session is still the board's.
  expect((await cli(box, ['doing', '--session', SID, 'two', '--', '--session', 'ben'])).code).toBe(0)
  expect(cardOf(box)?.doing).toBe('two --session ben')
})

test('after --, remind and every take the board flags as their text; --idle before it still counts', async () => {
  const box = await sandbox()
  config(box)
  const dir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
  const entry = (out: string): Record<string, unknown> => {
    const id = /(?:reminder|every) ([0-9a-f]{6})/.exec(out)?.[1]
    expect(id, out).toBeDefined()
    return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
  }
  for (const words of AFTER) {
    const r = await cli(box, ['--session', SID, 'remind', 'in', '30m', '--', ...words])
    expect(r.code, r.out).toBe(0)
    const e = entry(r.out)
    expect(e.text).toBe(words.join(' '))
    expect(e.idle).toBeUndefined()
  }
  const every = await cli(box, ['--session', SID, 'every', '0 9 * * 1-5', '--', '--idle'])
  expect(every.code, every.out).toBe(0)
  expect(entry(every.out)).toMatchObject({ text: '--idle', cron: '0 9 * * 1-5' })
  expect(entry(every.out).idle).toBeUndefined()
  const idle = await cli(box, ['--session', SID, 'remind', '--idle', 'in', '1h', '--', '--when-free'])
  expect(entry(idle.out)).toMatchObject({ text: '--when-free', idle: true })
  // The time is read before the --: a text that reads as more of it stays text.
  const now = Date.now()
  const timed = entry((await cli(box, ['--session', SID, 'remind', 'in', '1h', '--', '30m', 'of', 'reading'])).out)
  expect(timed.text).toBe('30m of reading')
  expect(Math.abs((timed.next as number) - (now + 3_600_000))).toBeLessThan(60_000)
  const five = await cli(box, ['--session', SID, 'every', '0', '9', '*', '*', '1-5', '--', '--idle'])
  expect(entry(five.out)).toMatchObject({ text: '--idle', cron: '0 9 * * 1-5' })
})

test('after --, fork takes --name as its note; --name before it still names the fork', async () => {
  const bodies: unknown[] = []
  const board = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => {
      body += c
    })
    req.on('end', () => {
      bodies.push(JSON.parse(body))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, name: 'fork' }))
    })
  })
  await new Promise<void>(resolve => board.listen(0, '127.0.0.1', resolve))
  try {
    const box = await sandbox()
    config(box, { port: (board.address() as AddressInfo).port })
    const one = await cli(box, ['--session', SID, 'fork', '--', '--name', 'anna'])
    expect(one.code, one.out).toBe(0)
    const two = await cli(box, ['--session', SID, 'fork', '--name', 'cleo', '--', '--idle', '-h'])
    expect(two.code, two.out).toBe(0)
    expect(bodies).toEqual([{ message: '--name anna' }, { name: 'cleo', message: '--idle -h' }])
  } finally {
    board.close()
  }
})

test('after --, favorite and cal read no flag: --idle is a word favorite refuses, -h is no help', async () => {
  const box = await sandbox()
  config(box)
  const fav = await cli(box, ['--session', SID, 'favorite', '--', '--idle'])
  expect(fav.code).toBe(1)
  expect(fav.out).toContain('usage: board favorite [off]')
  expect(cardOf(box)?.favorite).toBeUndefined()
  // Calendar is off here: a cal command past its help says so.
  for (const words of [
    ['--', '-h'],
    ['--', '--help'],
  ]) {
    const r = await cli(box, ['cal', 'list', ...words])
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).not.toContain('board cal list [')
  }
})

test('after --, todo add takes --mine and the board flags as its text', async () => {
  const box = await sandbox()
  config(box, { todos: true })
  const r = await cli(box, ['--session', SID, 'todo', 'add', '--', '--mine', '--idle'])
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain("the user's")
  expect((cardOf(box)?.todos as Record<string, unknown>[] | undefined)?.[0]).toMatchObject({
    text: '--mine --idle',
    owner: 'user',
  })
})

test('after --, thread post takes the board flags as its note', async () => {
  const box = await sandbox()
  config(box, { threads: true })
  expect((await cli(box, ['--session', SID, 'cat', 'personal'])).code).toBe(0)
  const made = await cli(box, ['--session', SID, 'thread', 'new', 'Import mapping'])
  expect(made.code, made.out).toBe(0)
  const key = /([a-z]+-\d+)/.exec(made.out)?.[1] ?? ''
  for (const words of AFTER) {
    const r = await cli(box, ['--session', SID, 'thread', 'post', key, '--json', '--', ...words])
    expect(r.code, r.out).toBe(0)
    expect(JSON.parse(r.out).entry.text).toBe(words.join(' '))
  }
})
