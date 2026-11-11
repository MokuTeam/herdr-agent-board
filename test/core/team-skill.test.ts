// The Team skill install copies (skills/agent-board-team, #369): its front matter parses and names
// it, the install marker is in it, and every `board team` command it names, with its flags, is in
// the usage `board team` prints, so renaming a command or a flag fails here until the skill
// follows. The other `board` commands it starts a line with are in `board --help`.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEAM_SKILL } from '../../src/core/setup.ts'
import { DEFAULT_LIMITS, MAX_LOOP } from '../../src/core/team-agents.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const file = join(root, 'skills', TEAM_SKILL, 'SKILL.md')
const text = readFileSync(file, 'utf8')

/** The YAML between the leading `---` lines, and the body after it. */
function split(skill: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(skill)
  if (!m) throw new Error('no front matter')
  return { front: Bun.YAML.parse(m[1] ?? '') as Record<string, unknown>, body: m[2] ?? '' }
}

/** `board team <op>` uses in a text, each with the flags written after it (up to the next command). */
function teamUses(skill: string): { op: string; flags: string[] }[] {
  const out: { op: string; flags: string[] }[] = []
  for (const m of skill.matchAll(/\bboard team ([a-z]+)/g)) {
    const after = skill.slice((m.index ?? 0) + m[0].length)
    const rest = after.split(/[`\n;]|\bboard /)[0] ?? ''
    out.push({ op: m[1] ?? '', flags: [...rest.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map(f => f[0]) })
  }
  return out
}

/** A usage line `board team a ... | board team b ...` as each op's flags. */
function teamUsage(usage: string): Map<string, Set<string>> {
  const ops = new Map<string, Set<string>>()
  for (const part of usage.replace(/^.*?usage:\s*/s, '').split(' | ')) {
    const m = /^board team ([a-z]+)(.*)$/.exec(part.trim())
    if (m) ops.set(m[1] ?? '', new Set([...(m[2] ?? '').matchAll(/--[a-z][a-z-]*/g)].map(f => f[0])))
  }
  return ops
}

/** A `board` command at the start of a code span, as in `board ask "..."`: its first word. */
const boardCommands = (skill: string): string[] =>
  [...skill.matchAll(/`board ([a-z-]+)/g)].map(m => m[1] ?? '').filter(w => w !== 'team')

async function boardSays(box: Sandbox, args: string[]): Promise<string> {
  const r = await box.run('cli', { args, env: {} }).exited
  return r.stdout + r.stderr
}

describe('skills/agent-board-team', () => {
  test('its front matter parses: the name is the folder, a description that says when to load it', () => {
    const { front, body } = split(text)
    expect(front.name).toBe(TEAM_SKILL)
    expect(typeof front.description).toBe('string')
    const description = String(front.description)
    for (const word of ['Team', 'hub', "peer's board", 'thread', 'channel', 'hand a task', 'status', 'listener'])
      expect(description).toContain(word)
    expect(description.length).toBeLessThan(1024)
    // The marker that tells install's copy from someone else's skill of that name.
    expect(body).toContain('<!-- agent-board: installed by')
  })

  test('no em or en dashes, and the example names are neutral ones', () => {
    expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`))
    expect(text).toContain('anna')
    expect(text).toContain('ben')
  })

  test('the limits it gives are the board’s defaults', () => {
    const l = DEFAULT_LIMITS
    expect(text).toContain(
      `by default ${l.sessionHour} posts an hour per session, ${l.peerHour} an hour and ${l.peerDay} a day`,
    )
    expect(text).toContain(`within ${l.echoMin} minutes`)
    expect(text).toContain(`a number from 1 to ${MAX_LOOP}`)
  })

  test('the parsers find a renamed command and a renamed flag', () => {
    const usage = teamUsage(
      'usage: board team post <name|team> [--new "<title>"] [--link <url>] "<text>" | board team listen [off]',
    )
    expect([...usage.keys()]).toEqual(['post', 'listen'])
    expect([...(usage.get('post') ?? [])]).toEqual(['--new', '--link'])
    expect(
      teamUses('`board team post ben --new "x" --link https://a.example/1 "y"`; `board team send ben "z"`'),
    ).toEqual([
      { op: 'post', flags: ['--new', '--link'] },
      { op: 'send', flags: [] },
    ])
    expect(teamUses('Read it: board team thread 1a2b3c4d; answer with board team reply 1a2b3c4d "..."')).toEqual([
      { op: 'thread', flags: [] },
      { op: 'reply', flags: [] },
    ])
    expect(boardCommands('`board ask "x"`, `[board reminder from team] x`, `board team inbox`')).toEqual(['ask'])
  })

  test('every board team command and flag it names is in the usage board team prints', async () => {
    const box = await sandbox()
    const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', wakeUrl: '', port: 9 }))
    const usage = teamUsage(await boardSays(box, ['team', '--help']))
    expect(usage.size).toBeGreaterThan(5)
    const uses = teamUses(text)
    // What the issue asks the skill to cover is there.
    for (const op of ['roster', 'inbox', 'thread', 'watch', 'post', 'reply', 'assign', 'release', 'draft', 'listen'])
      expect(uses.map(u => u.op)).toContain(op)
    for (const use of uses) {
      expect({ op: use.op, known: usage.has(use.op) }).toEqual({ op: use.op, known: true })
      for (const flag of use.flags)
        expect({ op: use.op, flag, known: usage.get(use.op)?.has(flag) }).toEqual({ op: use.op, flag, known: true })
    }
    // A flag written apart from its command (`--read`, `--link` in prose) is some command's flag still.
    const flags = new Set([...usage.values()].flatMap(s => [...s]))
    const written = [...text.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map(f => f[0])
    expect(written.length).toBeGreaterThan(5)
    for (const flag of written) expect({ flag, known: flags.has(flag) }).toEqual({ flag, known: true })
    // The other board commands it gives (`board ask`, `board list`) are in board --help.
    const help = await boardSays(box, ['--help'])
    const top = new Set(
      help
        .replace(/^[\s\S]*?board \[/, '')
        .split(' | ')
        .map(p => p.trim().split(/\s/)[0]),
    )
    expect(boardCommands(text).length).toBeGreaterThan(0)
    for (const word of boardCommands(text)) expect({ word, known: top.has(word) }).toEqual({ word, known: true })
  }, 30_000)
})
