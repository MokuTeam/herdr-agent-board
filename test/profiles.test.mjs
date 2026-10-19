import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { liveSessions, transcriptPath } from '../src/claude.mjs'
import { claudeDirs, configDirOf, envArgs, profileEnv } from '../src/paths.mjs'
import { checkSetup, gatherFacts } from '../src/setup.mjs'

const home = () => mkdtempSync(join(tmpdir(), 'board-profiles-'))

test('config folders: CLAUDE_CONFIG_DIR first, then ~/.claude, then the profiles beside it that Claude ran in', () => {
  const h = home()
  for (const d of ['.claude-work/sessions', '.claude-moku/projects', '.claude-empty', '.claude.json.bak-x']) mkdirSync(join(h, d), { recursive: true })
  writeFileSync(join(h, '.claude-file'), '')
  assert.deepEqual(claudeDirs({}, h), [join(h, '.claude'), join(h, '.claude-moku'), join(h, '.claude-work')])
  assert.deepEqual(claudeDirs({ CLAUDE_CONFIG_DIR: '~/.claude-work' }, h), [join(h, '.claude-work'), join(h, '.claude'), join(h, '.claude-moku')])
  assert.deepEqual(claudeDirs({ CLAUDE_CONFIG_DIR: '/elsewhere/claude' }, h)[0], '/elsewhere/claude')
})

test('sessions and transcripts of every profile; a resume runs with its profile, ~/.claude without the variable', () => {
  const h = home()
  const dirs = [join(h, '.claude'), join(h, '.claude-work')]
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  mkdirSync(join(dirs[1], 'sessions'), { recursive: true })
  writeFileSync(join(dirs[1], 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: id, kind: 'interactive', cwd: '/w/app' }))
  assert.deepEqual([...liveSessions(dirs.map(d => join(d, 'sessions'))).keys()], [id])
  const project = join(dirs[1], 'projects', '-w-app')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, `${id}.jsonl`), '')
  const path = transcriptPath(id, '/w/app', dirs.map(d => join(d, 'projects')))
  assert.equal(path, join(project, `${id}.jsonl`))
  assert.equal(configDirOf(path), dirs[1])
  assert.deepEqual(envArgs(profileEnv(configDirOf(path))), ['--env', `CLAUDE_CONFIG_DIR=${dirs[1]}`])
  assert.deepEqual(profileEnv(null), {})
})

test('board doctor checks the hooks and the skill in each profile, naming the folder', async () => {
  const h = home()
  const dirs = [join(h, '.claude'), join(h, '.claude-work')]
  for (const d of dirs) mkdirSync(d, { recursive: true })
  const facts = await gatherFacts(null, { env: { PATH: '' }, home: h, dirs })
  assert.deepEqual(facts.profiles.map(p => p.settingsFile), dirs.map(d => join(d, 'settings.json')))
  const hooks = checkSetup(facts).filter(c => c.id === 'hooks')
  assert.equal(hooks.length, 2)
  assert.ok(hooks.every(c => c.level === 'error'))
  assert.match(hooks[1].detail, /\.claude-work/)
  assert.equal(checkSetup(facts).filter(c => c.id === 'skill').length, 2)
})
