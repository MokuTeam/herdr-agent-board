// What a command or skill file says of itself, for the chat box's slash list (#191).
import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_BUILTINS,
  CODEX_BUILTINS,
  commandName,
  mergeCommands,
  PI_BUILTINS,
  readFront,
} from '../../src/core/slash-commands.ts'

describe('readFront', () => {
  test('description and argument-hint from the frontmatter, quoted or not', () => {
    expect(readFront('---\ndescription: Review the diff\nargument-hint: "[focus]"\n---\nBody')).toEqual({
      description: 'Review the diff',
      hint: '[focus]',
    })
    expect(readFront("---\nname: deploy\ndescription: 'Ship it: now'\n---\n")).toEqual({
      name: 'deploy',
      description: 'Ship it: now',
    })
  })

  test('a folded block, a BOM and Windows line ends', () => {
    const text = '\uFEFF---\r\ndescription: >\r\n  Two lines\r\n  of text\r\nname: x\r\n---\r\nBody'
    expect(readFront(text)).toEqual({ description: 'Two lines of text', name: 'x' })
  })

  test('no description: the first line of the body that is not a heading', () => {
    expect(readFront('# Title\n\nFix the build for anna\nmore')).toEqual({ description: 'Fix the build for anna' })
    expect(readFront('---\nargument-hint: <n>\n---\n# H\nDo it')).toEqual({ hint: '<n>', description: 'Do it' })
    expect(readFront('')).toEqual({})
  })

  test('user-invocable: false hides a skill; a long line is cut', () => {
    expect(readFront('---\nuser-invocable: false\ndescription: x\n---').hidden).toBe(true)
    const long = readFront(`---\ndescription: ${'a'.repeat(300)}\n---`).description ?? ''
    expect(long.length).toBe(160)
    expect(long.endsWith('…')).toBe(true)
  })
})

test('commandName takes what the agents take after the slash', () => {
  for (const ok of ['compact', 'pr-comments', 'skill:review', 'a.b', 'x_1']) expect([ok, commandName(ok)]).toEqual([ok, true])
  for (const bad of ['', 'two words', '-x', 'a/b', 'x'.repeat(65)]) expect([bad, commandName(bad)]).toEqual([bad, false])
})

test('mergeCommands keeps the first of a name: the folder before the profile before the agent', () => {
  const project = { name: 'review', description: 'ours', source: 'project' as const }
  const user = { name: 'review', description: 'mine', source: 'user' as const }
  const merged = mergeCommands([project], [user], CLAUDE_BUILTINS)
  expect(merged.filter(c => c.name === 'review')).toEqual([project])
  expect(merged.length).toBe(CLAUDE_BUILTINS.length)
})

test('the built-in lists have unique, valid names and leave out what ends the session', () => {
  for (const list of [CLAUDE_BUILTINS, PI_BUILTINS, CODEX_BUILTINS]) {
    const names = list.map(c => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect([n, commandName(n)]).toEqual([n, true])
    for (const gone of ['exit', 'quit', 'logout']) expect(names).not.toContain(gone)
    for (const c of list) expect(c.description.length).toBeGreaterThan(0)
  }
  expect(CLAUDE_BUILTINS.find(c => c.name === 'compact')?.hint).toBe('[instructions]')
})
