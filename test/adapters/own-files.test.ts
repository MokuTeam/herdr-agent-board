import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { ownFileCheck, ownFolders, realOrNearest } from '../../src/adapters/own-files.ts'
import { configDir, stateDir, uploadsDir } from '../../src/adapters/paths.ts'
import { DEFAULT_CONFIG } from '../../src/core/categories.ts'
import type { Config } from '../../src/core/types.ts'
import { isolatedHome } from '../support/env.ts'
import { canSymlink, SYMLINK_SKIP_REASON } from '../support/fs.ts'

const onWindows = process.platform === 'win32'
// A link into a folder: a junction on Windows (no admin needed), a symlink elsewhere.
const canLink = onWindows || canSymlink

/** A board under isolatedHome(): its state and config folders made, with access.json and config.json. */
function board(tunnel?: unknown) {
  const home = join(isolatedHome(), 'home')
  const state = stateDir()
  const config = configDir()
  mkdirSync(state, { recursive: true })
  mkdirSync(config, { recursive: true })
  writeFileSync(join(state, 'access.json'), '{}')
  writeFileSync(join(config, 'config.json'), '{}')
  const cfg: Config = tunnel === undefined ? { ...DEFAULT_CONFIG } : { ...DEFAULT_CONFIG, tunnel }
  return { home, state, config, cfg, own: ownFileCheck(cfg) }
}

/** `<path>` in its 8.3 spelling, from cmd.exe (by full path, no shell); '' when it cannot say. */
function shortName(path: string): string {
  const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  const r = spawnSync(cmd, ['/d', '/c', 'for', '%I', 'in', `("${path}")`, 'do', '@echo', '%~sI'], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  })
  return r.status === 0 ? r.stdout.trim() : ''
}

/** Whether the temp folder's volume gives 8.3 short names (they can be turned off per volume), probed once. */
function probeShortNames(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'board-short-name-probe-'))
  try {
    const short = shortName(dir)
    return short !== '' && short.toLowerCase() !== dir.toLowerCase()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const shortNames = onWindows && probeShortNames()

describe('the board’s own files', () => {
  test('the state and config folders and what is in them, made or not; not the uploads', () => {
    const { home, state, config, own } = board()
    mkdirSync(join(state, 'uploads', '2026-10-20'), { recursive: true })
    writeFileSync(join(state, 'uploads', '2026-10-20', 'a.png'), '')
    mkdirSync(join(home, 'x'))
    expect(own(join(state, 'access.json'))).toBe(true)
    expect(own(state)).toBe(true)
    expect(own(join(config, 'config.json'))).toBe(true)
    expect(own(join(state, 'nope', 'x.txt'))).toBe(true)
    expect(own(join(state, 'uploads', '2026-10-20', 'a.png'))).toBe(false)
    expect(own(join(state, 'uploads'))).toBe(false)
    expect(own(join(home, 'x'))).toBe(false)
    expect(own(join(home, 'x', 'missing.txt'))).toBe(false)
  })

  test('a path through `..` counts where it leads, the uploads folder not made yet', () => {
    const { state, own } = board()
    expect(own(`${state}/uploads/../access.json`)).toBe(true)
    expect(own(`${uploadsDir()}/../../${basename(state)}/access.json`)).toBe(true)
    expect(own(`${state}/uploads/2026-10-20/a.png`)).toBe(false)
  })

  test('folders not made yet count by their resolved paths', () => {
    const home = join(isolatedHome(), 'home')
    const own = ownFileCheck({ ...DEFAULT_CONFIG, tunnel: { key: join(home, 'keys', 'k') } })
    expect(own(join(stateDir(), 'access.json'))).toBe(true)
    expect(own(join(configDir(), 'config.json'))).toBe(true)
    expect(own(join(home, 'keys', 'other'))).toBe(true)
    expect(own(join(uploadsDir(), '2026-10-20', 'a.png'))).toBe(false)
    expect(own(join(home, 'x'))).toBe(false)
  })

  test('the folder of a tunnel key outside the state folder', () => {
    const { home, cfg, own } = board()
    const keys = join(home, 'keys')
    mkdirSync(keys)
    writeFileSync(join(keys, 'other'), '')
    expect(own(join(keys, 'other'))).toBe(false)

    const withKey = ownFileCheck({ ...cfg, tunnel: { key: join(keys, 'k') } })
    expect(withKey(join(keys, 'other'))).toBe(true)
    expect(withKey(keys)).toBe(true)
    expect(withKey(join(home, 'x'))).toBe(false)
  })

  test('a key given from the home folder (`~`) refuses its folder there', () => {
    const { home, own } = board({ key: '~/keys/k' })
    expect(own(join(home, 'keys', 'other'))).toBe(true)
    expect(own(join(home, 'x'))).toBe(false)
  })

  test('a key inside the state folder refuses nothing more', () => {
    const { state, cfg } = board()
    const plain = ownFolders(cfg).refused
    expect(plain).toHaveLength(2)
    expect(ownFolders({ ...cfg, tunnel: { key: join(state, 'keys', 'k') } }).refused).toEqual(plain)
    expect(ownFolders({ ...cfg, tunnel: { key: join(state, 'tunnel', 'id_ed25519') } }).refused).toEqual(plain)
  })

  test('the folders are read at each call: a key set later counts', () => {
    const { home, cfg, own } = board()
    expect(own(join(home, 'keys', 'other'))).toBe(false)
    cfg.tunnel = { key: join(home, 'keys', 'k') }
    expect(own(join(home, 'keys', 'other'))).toBe(true)
  })

  test.skipIf(!canLink)(`a link into the state folder counts as the state folder (${SYMLINK_SKIP_REASON})`, () => {
    const { home, state, own } = board()
    const link = join(home, 'link')
    symlinkSync(state, link, 'junction')
    expect(realOrNearest(join(link, 'access.json'))).toBe(realOrNearest(join(state, 'access.json')))
    expect(own(join(link, 'access.json'))).toBe(true)
    expect(own(link)).toBe(true)
    expect(own(join(link, 'nope', 'x.txt'))).toBe(true)
    expect(own(join(link, 'uploads', 'a.png'))).toBe(false)
  })

  test.skipIf(!canLink)(`an uploads folder that is a link lets nothing through (${SYMLINK_SKIP_REASON})`, () => {
    const { state, cfg, own } = board()
    mkdirSync(join(state, 'tunnel'))
    writeFileSync(join(state, 'tunnel', 'id_ed25519'), '')
    symlinkSync(join(state, 'tunnel'), uploadsDir(), 'junction')
    expect(ownFolders(cfg).allowed).toEqual([])
    expect(own(join(uploadsDir(), 'id_ed25519'))).toBe(true)
    expect(own(join(state, 'tunnel', 'id_ed25519'))).toBe(true)
  })

  test('the uploads folder made as a plain folder stays readable', () => {
    const { state, cfg } = board()
    mkdirSync(uploadsDir())
    expect(ownFolders(cfg).allowed).toEqual([realOrNearest(join(state, 'uploads'))])
  })

  describe.skipIf(!onWindows)('on Windows', () => {
    test('the state folder in another case, through `.` or a stream', () => {
      const { state, own } = board()
      for (const path of [
        join(state.toUpperCase(), 'ACCESS.JSON'),
        join(state.toLowerCase(), 'access.json'),
        `${state}\\.\\access.json`,
        `${state}\\access.json::$DATA`,
      ])
        expect([path, own(path)]).toEqual([path, true])
    })

    test('a name spelled with trailing dots or spaces counts as the name Windows opens', () => {
      const { home, state, own } = board()
      const link = join(home, 'link')
      symlinkSync(state, link, 'junction')
      for (const path of [
        `${state}.`,
        `${state} `,
        `${state}. .`,
        `${state}...`,
        `${state}\\access.json.`,
        `${state}\\access.json `,
        `${state}\\access.json. .`,
        `${state}.\\access.json`,
        `${state} \\access.json`,
        `${state}...\\access.json`,
        `${state}.\\nope\\x.txt`,
        `${state} \\nope\\x.txt`,
        `${dirname(state)}.\\${basename(state)}\\access.json`,
        `${link}.\\access.json`,
      ])
        expect([path, own(path)]).toEqual([path, true])
      expect(own(`${state}.\\uploads\\2026-10-20\\a.png`)).toBe(false)
      expect(own(`${home}.\\x`)).toBe(false)
    })

    test.skipIf(!shortNames)(
      'the state folder by its 8.3 short name (needs short names on the temp folder’s volume)',
      () => {
        const { state, own } = board()
        const short = shortName(state)
        expect(short).not.toBe('')
        expect(short.toLowerCase()).not.toBe(state.toLowerCase())
        expect(own(short)).toBe(true)
        expect(own(join(short, 'access.json'))).toBe(true)
        expect(own(join(short, 'nope', 'x.txt'))).toBe(true)
      },
    )

    test('the state folder through a UNC or device path', () => {
      const { state, own } = board()
      const rest = state.slice(2)
      expect(own(`\\\\localhost\\${state[0]}$${rest}\\access.json`)).toBe(true)
      expect(own(`//localhost/${state[0]}$${rest.replaceAll('\\', '/')}/access.json`)).toBe(true)
      expect(own(`\\\\?\\${state}\\access.json`)).toBe(true)
      expect(own(`\\\\.\\${state}\\access.json`)).toBe(true)
    })
  })
})
