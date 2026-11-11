// The agents' skill in a profile folder: what is there, and the board's copy put there. Only in
// temp folders.
import { expect, onTestFinished, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installSkill, skillIn } from '../../src/adapters/agents-skill.ts'

const SOURCE =
  '---\nname: herdr-agents\n---\n<!-- agent-board: installed by the install action -->\nHow to work in herdr.\n'
const THEIRS = '---\nname: herdr-agents\n---\nmine\n'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-agents-skill-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('installSkill: written when missing or older, left as it is when the same or someone else’s', () => {
  const dir = tempDir()
  const file = join(dir, 'skills', 'herdr-agents', 'SKILL.md')
  expect(installSkill(dir, SOURCE)).toEqual({ file, action: 'write' })
  expect(readFileSync(file, 'utf8')).toBe(SOURCE)
  expect(installSkill(dir, SOURCE)).toEqual({ file, action: 'same' })
  // An older copy of ours (CRLF line ends are the same text).
  writeFileSync(file, SOURCE.replace('How', 'Once, how'))
  expect(installSkill(dir, SOURCE)).toEqual({ file, action: 'write' })
  expect(readFileSync(file, 'utf8')).toBe(SOURCE)
  writeFileSync(file, SOURCE.replace(/\n/g, '\r\n'))
  expect(installSkill(dir, SOURCE).action).toBe('same')
  // Someone else's skill of that name: not touched.
  writeFileSync(file, THEIRS)
  expect(installSkill(dir, SOURCE)).toEqual({ file, action: 'foreign' })
  expect(readFileSync(file, 'utf8')).toBe(THEIRS)
  // Only that file in the profile folder.
  expect(readdirSync(dir)).toEqual(['skills'])
  expect(readdirSync(dirname(file))).toEqual(['SKILL.md'])
})

test('a skill by its name (Team’s, #369): its own folder, beside the agents’ skill, each judged on its own', () => {
  const dir = tempDir()
  const team = join(dir, 'skills', 'agent-board-team', 'SKILL.md')
  const agents = join(dir, 'skills', 'herdr-agents', 'SKILL.md')
  const TEAM = SOURCE.replace('herdr-agents', 'agent-board-team')
  // Someone else's herdr-agents does not keep Team's out, nor the other way round.
  mkdirSync(dirname(agents), { recursive: true })
  writeFileSync(agents, THEIRS)
  expect(installSkill(dir, TEAM, 'agent-board-team')).toEqual({ file: team, action: 'write' })
  expect(readFileSync(team, 'utf8')).toBe(TEAM)
  expect(installSkill(dir, SOURCE)).toEqual({ file: agents, action: 'foreign' })
  expect(readFileSync(agents, 'utf8')).toBe(THEIRS)
  expect(installSkill(dir, TEAM, 'agent-board-team').action).toBe('same')
  expect(skillIn(dir, TEAM, 'agent-board-team')).toEqual({ file: team, installed: TEAM, source: TEAM })
  expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['agent-board-team', 'herdr-agents'])
})

test('skillIn: the file, the text there (a BOM taken off) or null, and the board’s copy as given', () => {
  const dir = tempDir()
  const file = join(dir, 'skills', 'herdr-agents', 'SKILL.md')
  expect(skillIn(dir, SOURCE)).toEqual({ file, installed: null, source: SOURCE })
  expect(existsSync(join(dir, 'skills'))).toBe(false)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `\uFEFF${THEIRS}`)
  expect(skillIn(dir, null)).toEqual({ file, installed: THEIRS, source: null })
})
