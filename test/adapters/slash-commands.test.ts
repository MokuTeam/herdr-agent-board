// The commands one session's chat box offers (#191): Claude's profile and folder, pi's own
// folders, Codex's built-ins, nothing for an agent the board knows none of. Folders with spaces,
// Cyrillic and % in their names, as the board meets them.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionCommands } from '../../src/adapters/slash-commands.ts'
import { CLAUDE_BUILTINS, CODEX_BUILTINS, PI_BUILTINS } from '../../src/core/slash-commands.ts'

let dir = ''
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'slash-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('a Claude session', async () => {
  test("the folder's commands and skills, then the profile's, then Claude's own; nested commands by their file name", async () => {
    const profile = join(dir, 'профиль 100%')
    const cwd = join(dir, 'Проект anna 100%')
    put(join(profile, 'commands', 'standup.md'), '---\ndescription: Write the standup\nargument-hint: [day]\n---\nx')
    put(join(profile, 'commands', 'frontend', 'component.md'), 'Make a component')
    put(join(profile, 'commands', 'review.md'), '---\ndescription: mine\n---')
    put(join(profile, 'commands', 'two words.md'), 'not a command name')
    put(join(profile, 'commands', 'notes.txt'), 'not markdown')
    put(join(profile, 'skills', 'atlas', 'SKILL.md'), '---\nname: atlas-map\ndescription: Draw the map\n---')
    put(join(profile, 'skills', 'quiet', 'SKILL.md'), '---\nuser-invocable: false\ndescription: Claude only\n---')
    put(join(profile, 'skills', 'empty', 'README.md'), 'no SKILL.md here')
    put(join(cwd, '.claude', 'commands', 'review.md'), '---\ndescription: ours\n---')
    put(join(cwd, '.claude', 'skills', 'ben', 'SKILL.md'), '---\ndescription: Ben skill\n---')
    const list = await sessionCommands(
      { agent: 'claude', session: 'x', cwd },
      { claudeRoot: profile, env: {}, home: dir },
    )
    const by = (n: string) => list.find(c => c.name === n)
    expect(by('review')).toEqual({ name: 'review', description: 'ours', source: 'project' })
    expect(by('ben')).toEqual({ name: 'ben', description: 'Ben skill', source: 'project' })
    expect(by('standup')).toEqual({ name: 'standup', description: 'Write the standup', hint: '[day]', source: 'user' })
    expect(by('component')).toEqual({ name: 'component', description: 'Make a component', source: 'user' })
    expect(by('atlas-map')).toEqual({ name: 'atlas-map', description: 'Draw the map', source: 'user' })
    for (const gone of ['quiet', 'empty', 'two words', 'notes']) expect(by(gone)).toBeUndefined()
    expect(by('compact')?.source).toBe('builtin')
    // The folder's /review stands in for Claude's own.
    expect(list.filter(c => c.name === 'review')).toHaveLength(1)
    expect(list.length).toBe(4 + CLAUDE_BUILTINS.length)
  })

  test("no folders at all: Claude's own only; no folder for the session (the board's own files): the profile's and Claude's", async () => {
    const none = join(dir, 'nowhere')
    expect(await sessionCommands({ agent: 'claude', session: 'x', cwd: none }, { claudeRoot: none })).toEqual([
      ...CLAUDE_BUILTINS,
    ])
    const profile = join(dir, 'p2')
    put(join(profile, 'commands', 'mine.md'), 'Mine')
    const cwd = join(dir, 'c2')
    put(join(cwd, '.claude', 'commands', 'theirs.md'), 'Theirs')
    const names = (await sessionCommands({ agent: 'claude', session: 'x', cwd: '' }, { claudeRoot: profile })).map(
      c => c.name,
    )
    expect(names).toContain('mine')
    expect(names).not.toContain('theirs')
  })
})

test("a pi session: its prompt templates and skills (as skill:<name>) from its own folder, the session's and ~/.agents, then pi's own", async () => {
  const own = join(dir, 'pi agent dir')
  const home = join(dir, 'home cleo')
  const cwd = join(dir, 'pi проект')
  put(join(own, 'prompts', 'review.md'), '---\ndescription: Review staged changes\nargument-hint: "[focus]"\n---')
  put(join(own, 'skills', 'atlas', 'SKILL.md'), '---\nname: atlas\ndescription: Atlas skill\n---')
  put(join(home, '.agents', 'skills', 'shared', 'SKILL.md'), '---\ndescription: Shared\n---')
  put(join(cwd, '.pi', 'prompts', 'fix.md'), 'Fix it')
  const list = await sessionCommands(
    { agent: 'pi', session: join(dir, 'session.jsonl'), cwd },
    { claudeRoot: join(dir, 'unused'), env: { PI_CODING_AGENT_DIR: own }, home },
  )
  const custom = list.filter(c => c.source !== 'builtin').map(c => [c.name, c.source])
  expect(custom).toEqual([
    ['fix', 'project'],
    ['review', 'user'],
    ['skill:atlas', 'user'],
    ['skill:shared', 'user'],
  ])
  expect(list.find(c => c.name === 'review')?.hint).toBe('[focus]')
  expect(list.slice(custom.length)).toEqual([...PI_BUILTINS])
})

test('pi without PI_CODING_AGENT_DIR reads ~/.pi/agent', async () => {
  const home = join(dir, 'home ben')
  put(join(home, '.pi', 'agent', 'prompts', 'daily.md'), 'Daily')
  const list = await sessionCommands(
    { agent: 'pi', session: join(dir, 's.jsonl'), cwd: '' },
    { claudeRoot: '', env: {}, home },
  )
  expect(list[0]).toEqual({ name: 'daily', description: 'Daily', source: 'user' })
})

test('Codex gets its own; an unknown agent, or pi with no session file, gets nothing and reads no folder', async () => {
  expect(await sessionCommands({ agent: 'codex', session: null, cwd: dir }, { claudeRoot: dir })).toEqual([
    ...CODEX_BUILTINS,
  ])
  expect(await sessionCommands({ agent: 'agy', session: null, cwd: dir }, { claudeRoot: dir })).toEqual([])
  expect(await sessionCommands({ session: null, cwd: dir }, { claudeRoot: dir })).toEqual([])
  expect(await sessionCommands({ agent: 'pi', session: 'pane-x', cwd: dir }, { claudeRoot: dir })).toEqual([])
})

test('a name in another alphabet is a command; a folder past the cap or a cut-off frontmatter adds nothing wrong', async () => {
  const profile = join(dir, 'p3')
  put(join(profile, 'commands', 'отчёт.md'), '---\ndescription: Weekly report\n---')
  put(join(profile, 'commands', 'cut.md'), `---\ndescription: never closed\n${'x: y\n'.repeat(3000)}`)
  put(join(profile, 'commands', 'fenced.md'), '```bash\nmake\n```\nRun the build')
  const list = await sessionCommands({ agent: 'claude', session: 'x', cwd: '' }, { claudeRoot: profile })
  const by = (n: string) => list.find(c => c.name === n)
  expect(by('отчёт')).toEqual({ name: 'отчёт', description: 'Weekly report', source: 'user' })
  expect(by('cut')).toEqual({ name: 'cut', description: '', source: 'user' })
  expect(by('fenced')?.description).toBe('make')
})

test('a folder of more entries than the cap is read only that far', async () => {
  const profile = join(dir, 'p4')
  for (let i = 0; i < 1100; i++) put(join(profile, 'commands', `c${String(i).padStart(4, '0')}.md`), 'x')
  const list = await sessionCommands({ agent: 'claude', session: 'x', cwd: '' }, { claudeRoot: profile })
  expect(list.filter(c => c.source === 'user').length).toBe(1000)
})

test('a .md that is a folder is no command', async () => {
  const profile = join(dir, 'p5')
  mkdirSync(join(profile, 'commands', 'odd.md'), { recursive: true })
  put(join(profile, 'commands', 'odd.md', 'inner.md'), 'Inner')
  const names = (await sessionCommands({ agent: 'claude', session: 'x', cwd: '' }, { claudeRoot: profile })).map(
    c => c.name,
  )
  expect(names).not.toContain('odd')
  expect(names).toContain('inner')
})
