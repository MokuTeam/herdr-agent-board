import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configFile } from '../../src/adapters/config-file.ts'
import { configDir } from '../../src/adapters/paths.ts'
import { findProfileDirs, inheritedProfileDir, loadProfiles } from '../../src/adapters/profiles.ts'
import { sameDir } from '../../src/core/launch/names.ts'
import { isolatedHome } from '../support/env.ts'

/** A temp home with profile folders, an empty one, and files that are no folders. */
function ownersHome(): string {
  const home = join(isolatedHome(), 'home')
  const file = (...parts: string[]) => {
    mkdirSync(join(home, ...parts.slice(0, -1)), { recursive: true })
    writeFileSync(join(home, ...parts), '{}')
  }
  file('.claude', 'settings.json')
  mkdirSync(join(home, '.claude-work', 'projects'), { recursive: true })
  file('.claude-gamedev', 'settings.json')
  mkdirSync(join(home, '.claude-empty'))
  file('.claude.json')
  file('.claude-notes.txt')
  return home
}

test('found: the default folder first, then ~/.claude-* folders, each with settings.json or projects/', () => {
  const home = ownersHome()
  expect(findProfileDirs(home)).toEqual([
    join(home, '.claude'),
    join(home, '.claude-gamedev'),
    join(home, '.claude-work'),
  ])
  const emptyHome = join(home, 'empty')
  mkdirSync(emptyHome)
  expect(findProfileDirs(emptyHome)).toEqual([])
  // ~/.claude there but holding neither: not in use.
  mkdirSync(join(emptyHome, '.claude'))
  expect(findProfileDirs(emptyHome)).toEqual([])
  mkdirSync(join(emptyHome, '.claude', 'projects'))
  expect(findProfileDirs(emptyHome)).toEqual([join(emptyHome, '.claude')])
  expect(findProfileDirs(join(home, 'gone'))).toEqual([])
})

test('loadProfiles: a board whose CLAUDE_CONFIG_DIR is a folder elsewhere keeps one profile shown', () => {
  const home = join(isolatedHome(), 'home')
  const own = join(home, 'elsewhere', 'claude')
  mkdirSync(join(own, 'projects'), { recursive: true })
  expect(loadProfiles({ home, shownDir: own }).map(p => [p.id, p.hidden])).toEqual([
    ['default', true],
    ['claude', false],
  ])
  // Once ~/.claude is in use, it is shown as on every board.
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', 'settings.json'), '{}')
  expect(loadProfiles({ home, shownDir: own }).map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
    ['claude', false],
  ])
})

test('the inherited folder: unset is ~/.claude; ~ is the home folder', () => {
  const home = join(isolatedHome(), 'home')
  expect(sameDir(inheritedProfileDir({}, home), join(home, '.claude'))).toBe(true)
  expect(sameDir(inheritedProfileDir({ CLAUDE_CONFIG_DIR: '' }, home), join(home, '.claude'))).toBe(true)
  expect(sameDir(inheritedProfileDir({ CLAUDE_CONFIG_DIR: '~/.claude-work' }, home), join(home, '.claude-work'))).toBe(
    true,
  )
  expect(inheritedProfileDir({ CLAUDE_CONFIG_DIR: '/c/Users/me/.claude-work' }, 'C:\\Users\\me', 'win32')).toBe(
    'c:/Users/me/.claude-work',
  )
  // Without arguments: this process's env and home folder.
  expect(sameDir(inheritedProfileDir(), join(homedir(), '.claude'))).toBe(true)
})

test('loadProfiles merges config.json and the folders without writing either', () => {
  const home = ownersHome()
  expect(loadProfiles({ home }).map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
    ['gamedev', true],
    ['work', true],
  ])
  expect(existsSync(configFile())).toBe(false)
  // The board's own folder shows; what config.json lists wins.
  expect(loadProfiles({ home, shownDir: join(home, '.claude-work') }).map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
    ['gamedev', true],
    ['work', false],
  ])
  mkdirSync(configDir(), { recursive: true })
  const listed = { id: 'work', title: 'BluBanyan', dir: join(home, '.claude-work'), color: 'teal', hidden: false }
  writeFileSync(configFile(), JSON.stringify({ profiles: [listed] }))
  expect(loadProfiles({ home }).map(p => [p.id, p.title, p.hidden])).toEqual([
    ['work', 'BluBanyan', false],
    ['default', 'Default', false],
    ['gamedev', 'Gamedev', true],
  ])
  expect(readdirSync(join(home, '.claude'))).toEqual(['settings.json'])
})

test('isolatedHome hides the developer’s own home and CLAUDE_CONFIG_DIR', () => {
  const dir = isolatedHome()
  expect(homedir().startsWith(dir)).toBe(true)
  expect(existsSync(homedir())).toBe(true)
  expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined()
})
