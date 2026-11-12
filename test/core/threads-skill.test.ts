// The threads skill install copies while threads are on (skills/agent-board-threads, #379): its
// front matter parses and names it, the install marker is in it, and every `board thread` command
// it names, with its flags, is in the usage `board thread --help` prints, so renaming a command or
// a flag fails here until the skill follows.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THREADS_SKILL } from '../../src/core/setup.ts'
import { THREAD_USAGE } from '../../src/entrypoints/thread-cli.ts'
import { root } from '../support/sandbox.ts'

const text = readFileSync(join(root, 'skills', THREADS_SKILL, 'SKILL.md'), 'utf8')

function split(skill: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(skill)
  if (!m) throw new Error('no front matter')
  return { front: Bun.YAML.parse(m[1] ?? '') as Record<string, unknown>, body: m[2] ?? '' }
}

/** Each op of the usage and the flags its lines name. */
function usage(): Map<string, Set<string>> {
  const ops = new Map<string, Set<string>>()
  let op = ''
  for (const line of THREAD_USAGE.split('\n')) {
    const m = /^board thread ([a-z]+)(.*)$/.exec(line)
    if (m) op = m[1] ?? ''
    else if (!/^\s{20,}/.test(line)) op = ''
    if (!op) continue
    const set = ops.get(op) ?? new Set<string>()
    for (const f of (m ? (m[2] ?? '') : line).matchAll(/--[a-z][a-z-]*/g)) set.add(f[0])
    ops.set(op, set)
  }
  return ops
}

describe('skills/agent-board-threads', () => {
  test('its front matter parses: the name is the folder, a description that says when to load it', () => {
    const { front, body } = split(text)
    expect(front.name).toBe(THREADS_SKILL)
    const description = String(front.description)
    for (const word of ['board thread', 'hand work', 'report', 'fork', 'watch', '[board reminder from threads]'])
      expect(description).toContain(word)
    expect(description.length).toBeLessThan(1024)
    expect(body).toContain('agent-board: installed by')
  })

  test('every `board thread` command it names is one the command has, with the flags given after it', () => {
    const ops = usage()
    const uses = [...text.matchAll(/\bboard thread ([a-z]+)([^`\n]*)/g)]
    expect(uses.length).toBeGreaterThan(10)
    for (const m of uses) {
      const op = m[1] ?? ''
      expect(ops.has(op), `board thread ${op}`).toBe(true)
      const said = (m[2] ?? '').split(/\bboard /)[0] ?? ''
      const flags = [...said.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map(f => f[0])
      for (const f of flags) expect(ops.get(op)?.has(f) || f === '--json', `board thread ${op} ${f}`).toBe(true)
    }
  })

  test('no long dash in it', () => {
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })
})
