// The secrets' rules (core/secrets.ts): names, scopes, which one a session gets, and how a value
// goes into a shell, checked against bash itself where a shell is at hand.
import { expect, test } from 'bun:test'
import {
  appliesTo,
  exportLines,
  nameProblem,
  parseSecretId,
  pickFor,
  placeOf,
  SECRET_MOST,
  secretId,
  sessionFolder,
  sessionInArgs,
  shellWord,
  sourceLine,
  valueProblem,
  withBoardBlock,
} from '../../src/core/secrets.ts'

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('a name is a shell variable name, and not one the setup reads itself', () => {
  for (const ok of ['TOGGL_API_TOKEN', 'SLACK_BOT_TOKEN', '_X', 'a1', 'BOARD_TEST_SECRET'])
    expect(nameProblem(ok)).toBeNull()
  for (const bad of ['', '1X', 'A-B', 'A B', 'Ключ', 'X'.repeat(129), 'A=B', null, 3])
    expect(nameProblem(bad)).toBe('name')
  for (const own of [
    'PATH',
    'HOME',
    'path',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_API_KEY',
    'HERDR_PANE_ID',
    'LD_PRELOAD',
    'BASH_ENV',
    'XDG_RUNTIME_DIR',
    'NODE_OPTIONS',
  ])
    expect(nameProblem(own)).toBe('reserved')
})

test('a value: not empty, no NUL, 64 KB at most; newlines, quotes and other alphabets are fine', () => {
  expect(valueProblem('')).toBe('empty')
  expect(valueProblem(undefined)).toBe('empty')
  expect(valueProblem('a\0b')).toBe('nul')
  expect(valueProblem('я'.repeat(SECRET_MOST / 2 + 1))).toBe('long')
  expect(valueProblem('line 1\nit\'s "q" $HOME `x` %41 ключ')).toBeNull()
})

test('ids: scope, target and name, back again; a target with a colon or a path stays whole', () => {
  for (const [scope, target] of [
    ['global', null],
    ['profile', 'work'],
    ['session', SID],
    ['session', 'C:\\Users\\me\\.pi\\s:1.jsonl'],
  ] as const) {
    const id = secretId({ scope, target }, 'TOKEN')
    expect(parseSecretId(id)).toEqual({ scope, target, name: 'TOKEN' })
  }
  for (const bad of ['', 'TOKEN', 'nope:x:TOKEN', 'global:x:TOKEN', 'profile::TOKEN', 'global::1X', 7])
    expect(parseSecretId(bad)).toBeNull()
  expect(placeOf('global', 'ignored')).toEqual({ scope: 'global', target: null })
  expect(placeOf('profile', ' work ')).toEqual({ scope: 'profile', target: 'work' })
  expect(placeOf('session', '')).toBeNull()
  expect(placeOf('everyone', null)).toBeNull()
})

test('the session over the profile over the global one; another profile or session gets none of theirs', () => {
  const all = [
    { scope: 'global', target: null, name: 'A', v: 'g' },
    { scope: 'profile', target: 'work', name: 'A', v: 'p' },
    { scope: 'session', target: SID, name: 'A', v: 's' },
    { scope: 'profile', target: 'work', name: 'B', v: 'pb' },
    { scope: 'session', target: 'other', name: 'C', v: 'sc' },
    { scope: 'global', target: null, name: 'D', v: 'gd' },
  ] as const
  const of = (profile: string | null, session: string | null) =>
    pickFor(all, { profile, session }).map(e => `${e.name}=${e.v}`)
  expect(of('work', SID)).toEqual(['A=s', 'B=pb', 'D=gd'])
  expect(of('work', null)).toEqual(['A=p', 'B=pb', 'D=gd'])
  expect(of('default', SID)).toEqual(['A=s', 'D=gd'])
  expect(of(null, null)).toEqual(['A=g', 'D=gd'])
  expect(appliesTo({ scope: 'profile', target: 'work' }, { profile: null, session: null })).toBe(false)
})

test('a value as one shell word: bash reads back exactly what was set', async () => {
  const bash = Bun.which('bash')
  const values = ["it's", "''", 'a"b', '$HOME `id` $(id) \\n', 'line 1\nline 2', 'ключ 🔑', '%41%', ' lead and trail ']
  const lines = exportLines(values.map((value, i) => ({ name: `V${i}`, value })))
  for (const v of values) expect(shellWord(v).startsWith("'")).toBe(true)
  if (!bash) return
  const script = `${lines}${values.map((_, i) => `printf '%s\\0' "$V${i}"`).join('\n')}\n`
  const proc = Bun.spawn([bash, '--noprofile', '--norc', '-c', script], { stdout: 'pipe', env: {} })
  const out = await new Response(proc.stdout).text()
  expect(out.split('\0').slice(0, -1)).toEqual(values)
})

test('export lines are what Claude Code takes as plain assignments (its PowerShell reads only those)', () => {
  // Claude Code 2.1.309's own check, line by line.
  const plain =
    /^(?:\s*(?:#.*)?|(?:export +|declare -x +)?([A-Za-z_]\w*)=((?:[\w@%+=:,./-]|'[^'\0]*'|"(?:[^"\\$`\0]|\\[^\0])*")*))$/
  const lines = exportLines([
    { name: 'A', value: "it's" },
    { name: 'B', value: 'x y $z' },
  ])
  for (const line of lines.trimEnd().split('\n')) expect(plain.test(line)).toBe(true)
})

test("the board's block in Claude Code's env file: set, replaced, taken out; other hooks' lines kept", () => {
  const other = 'export FROM_OTHER=1\n'
  const one = withBoardBlock(other, 'export A=1\n')
  expect(one).toBe(`${other}# agent-board secrets (begin)\nexport A=1\n# agent-board secrets (end)\n`)
  const two = withBoardBlock(one, 'export A=2')
  expect(two).toBe(`${other}# agent-board secrets (begin)\nexport A=2\n# agent-board secrets (end)\n`)
  expect(withBoardBlock(two, null)).toBe(other)
  expect(withBoardBlock('', null)).toBe('')
  expect(withBoardBlock('export X=1', 'export A=1\n')).toStartWith('export X=1\n# agent-board')
  expect(sourceLine("/run/user/1000/a'b/env.sh")).toBe(
    `[ -r '/run/user/1000/a'"'"'b/env.sh' ] && . '/run/user/1000/a'"'"'b/env.sh'\n`,
  )
})

test("a session's folder: a Claude id as it is, anything else hashed; claude's own session from its arguments", () => {
  const h = (s: string) => `h${s.length}`
  expect(sessionFolder(SID.toUpperCase(), h)).toBe(SID)
  expect(sessionFolder('/home/me/.pi/sessions/x.jsonl', h)).toBe('h29')
  expect(sessionFolder('pane-w1:p2', h)).toBe('h10')
  expect(sessionInArgs(['--allow-dangerously-skip-permissions', '--resume', SID])).toBe(SID)
  expect(sessionInArgs(['-r', SID])).toBe(SID)
  expect(sessionInArgs([`--resume=${SID}`])).toBe(SID)
  expect(sessionInArgs(['--session-id', SID, '--model', 'opus'])).toBe(SID)
  expect(sessionInArgs(['--resume'])).toBeNull()
  expect(sessionInArgs(['--resume', '--model'])).toBeNull()
  expect(sessionInArgs(['--continue'])).toBeNull()
  expect(sessionInArgs(['--', '--resume', SID])).toBeNull()
})
