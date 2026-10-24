import { describe, expect, test } from 'bun:test'
import { isOwnFile, oddWindowsPath, underFolder } from '../../src/core/own-files.ts'

describe('underFolder', () => {
  test('on Windows: case and either separator do not matter', () => {
    expect(underFolder('C:\\s\\agent-board\\access.json', 'C:\\s\\agent-board', 'win32')).toBe(true)
    expect(underFolder('c:/S/AGENT-BOARD/access.json', 'C:\\s\\agent-board', 'win32')).toBe(true)
    expect(underFolder('C:\\s\\agent-board\\access.json', 'c:/S/AGENT-BOARD/', 'win32')).toBe(true)
  })

  test('on Linux case matters and a backslash is part of a name; on macOS case does not matter', () => {
    expect(underFolder('/S/x', '/s', 'linux')).toBe(false)
    expect(underFolder('/s/x', '/s', 'linux')).toBe(true)
    expect(underFolder('/s/agent-board\\x', '/s/agent-board', 'linux')).toBe(false)
    expect(underFolder('/S/x', '/s', 'darwin')).toBe(true)
  })

  test('the folder itself counts, with or without a trailing separator', () => {
    expect(underFolder('C:\\s\\agent-board', 'C:\\s\\agent-board', 'win32')).toBe(true)
    expect(underFolder('C:\\s\\agent-board\\', 'C:\\s\\agent-board', 'win32')).toBe(true)
    expect(underFolder('/s/agent-board', '/s/agent-board/', 'linux')).toBe(true)
  })

  test('whole segments only', () => {
    expect(underFolder('C:\\s\\agent-board-2\\x', 'C:\\s\\agent-board', 'win32')).toBe(false)
    expect(underFolder('/s/agent-board2/x', '/s/agent-board', 'linux')).toBe(false)
    expect(underFolder('/s/agent-board2/x', '/s/agent-board', 'darwin')).toBe(false)
  })

  test('a root folder holds everything on its drive; an empty folder holds nothing', () => {
    expect(underFolder('C:\\s\\x', 'C:\\', 'win32')).toBe(true)
    expect(underFolder('D:\\s\\x', 'C:\\', 'win32')).toBe(false)
    expect(underFolder('/s/x', '/', 'linux')).toBe(true)
    expect(underFolder('/s/x', '', 'linux')).toBe(false)
  })
})

describe('isOwnFile', () => {
  const win = { refused: ['C:\\s\\agent-board', 'C:\\c\\agent-board'], allowed: ['C:\\s\\agent-board\\uploads'] }
  const linux = { refused: ['/s/agent-board', '/c/agent-board'], allowed: ['/s/agent-board/uploads'] }

  test('refuses under the state and config folders, the folders themselves too', () => {
    expect(isOwnFile('C:\\s\\agent-board\\access.json', win, 'win32')).toBe(true)
    expect(isOwnFile('C:\\S\\Agent-Board\\tunnel\\id_ed25519', win, 'win32')).toBe(true)
    expect(isOwnFile('C:\\s\\agent-board', win, 'win32')).toBe(true)
    expect(isOwnFile('C:\\c\\agent-board\\config.json', win, 'win32')).toBe(true)
    expect(isOwnFile('/s/agent-board/access.json', linux, 'linux')).toBe(true)
    expect(isOwnFile('/c/agent-board/config.json', linux, 'linux')).toBe(true)
  })

  test('lets through what is under uploads inside the state folder, and what is under neither', () => {
    expect(isOwnFile('C:\\s\\agent-board\\uploads\\2026-10-20\\a.png', win, 'win32')).toBe(false)
    expect(isOwnFile('C:\\s\\agent-board\\uploads', win, 'win32')).toBe(false)
    expect(isOwnFile('/s/agent-board/uploads/2026-10-20/a.png', linux, 'linux')).toBe(false)
    expect(isOwnFile('C:\\work\\x.txt', win, 'win32')).toBe(false)
    expect(isOwnFile('/work/x.txt', linux, 'linux')).toBe(false)
  })

  test('a name that only starts like uploads is still refused', () => {
    expect(isOwnFile('C:\\s\\agent-board\\uploads-old\\a.png', win, 'win32')).toBe(true)
    expect(isOwnFile('/s/agent-board/uploads2/a.png', linux, 'linux')).toBe(true)
  })
})

describe('oddWindowsPath', () => {
  test('UNC and device paths, either separator', () => {
    for (const path of [
      '\\\\localhost\\C$\\x',
      '//localhost/C$/x',
      '\\\\?\\C:\\x',
      '\\\\.\\C:\\x',
      '/\\localhost\\C$\\x',
      '\\??\\C:\\x',
      '\\??\\UNC\\localhost\\C$\\x',
      '/??/UNC/localhost/C$/x',
    ])
      expect([path, oddWindowsPath(path)]).toEqual([path, true])
  })

  test('a colon past the drive letter: an NTFS stream', () => {
    for (const path of ['C:\\a\\b.txt:secret', 'C:\\a\\b.txt::$DATA', 'a\\b.txt:secret', '\\a\\b:c'])
      expect([path, oddWindowsPath(path)]).toEqual([path, true])
  })

  test('ordinary paths are not odd', () => {
    for (const path of ['C:\\a\\b.txt', 'C:/a/b', 'c:\\a', 'C:', 'C:a\\b', '\\a\\b', 'a/b'])
      expect([path, oddWindowsPath(path)]).toEqual([path, false])
  })
})
