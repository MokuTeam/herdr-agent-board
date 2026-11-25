import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isolatedHome } from './env.ts'

const outside = () => ({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  homedir: homedir(),
})
const found = outside()
const OUTSIDE = { ...found, homedir: (process.platform === 'win32' ? found.USERPROFILE : found.HOME) || found.homedir }

const dirs: string[] = []

describe('multiple isolatedHome() calls in one test (#736, #737)', () => {
  let preTest: ReturnType<typeof outside> | null = null
  const created: string[] = []

  test('two isolatedHome() calls in one test keep each sandbox isolated', () => {
    preTest = outside()
    const dir1 = isolatedHome()
    created.push(dir1)
    expect(process.env.HOME).toBe(join(dir1, 'home'))
    expect(process.env.USERPROFILE).toBe(join(dir1, 'home'))
    expect(homedir()).toBe(join(dir1, 'home'))

    const dir2 = isolatedHome()
    created.push(dir2)
    expect(process.env.HOME).toBe(join(dir2, 'home'))
    expect(process.env.USERPROFILE).toBe(join(dir2, 'home'))
    expect(homedir()).toBe(join(dir2, 'home'))
  })

  afterAll(() => {
    if (preTest) {
      expect(process.env.HOME).toBe(preTest.HOME)
      expect(process.env.USERPROFILE).toBe(preTest.USERPROFILE)
      expect(homedir()).toBe(preTest.homedir)
      expect(outside()).toEqual(preTest)
    }
    for (const dir of created) expect(existsSync(dir)).toBe(false)
  })
})

test('isolatedHome() with custom folder names sets and isolates home, folders, and homedir', () => {
  const dir = isolatedHome({ home: 'Иван Петров 100%', appData: 'Роуминг 100%', localAppData: 'Local x 50%' })
  dirs.push(dir)
  expect(process.env.HOME).toBe(join(dir, 'Иван Петров 100%'))
  expect(process.env.USERPROFILE).toBe(join(dir, 'Иван Петров 100%'))
  expect(process.env.APPDATA).toBe(join(dir, 'Роуминг 100%'))
  expect(process.env.LOCALAPPDATA).toBe(join(dir, 'Local x 50%'))
  expect(homedir()).toBe(join(dir, 'Иван Петров 100%'))
})

afterAll(() => {
  expect(outside()).toEqual(OUTSIDE)
  for (const dir of dirs) expect(existsSync(dir)).toBe(false)
})
