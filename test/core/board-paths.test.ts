import { expect, test } from 'bun:test'
import { boardPathIndexes, withBoardPaths } from '../../src/core/board-paths.ts'

const upper = (paths: string[]): string[] => paths.map(p => `C:${p.slice(2)}`)

test('board texts that start with / are no paths: left as typed, no call (#532)', () => {
  for (const argv of [
    ['thread', 'post', 'atlas-12', '/review is done'],
    ['ask', '/model: which one?'],
    ['doing', '/compact', '--session', '/anna'],
    ['fork', '--name', '/cleo', '/note'],
    ['thread', 'post', 'atlas-12', '--summary', '/done', '--link', '/pr/12', 'text'],
    ['remind', 'in', '30m', '/review'],
    ['backup', 'list', '/c/x'],
  ]) {
    expect(boardPathIndexes(argv)).toEqual([])
    expect(withBoardPaths(argv, () => expect.unreachable())).toBe(argv)
  }
})

test('the file options and the file and folder words are converted, in one call, in order (#532)', () => {
  const seen: string[][] = []
  const convert = (paths: string[]): string[] => {
    seen.push(paths)
    return upper(paths)
  }
  expect(
    withBoardPaths(['thread', 'post', 'atlas-12', '--file', '/c/r/a.md', '/review', '--file', '/c/r/b.md'], convert),
  ).toEqual(['thread', 'post', 'atlas-12', '--file', 'C:/r/a.md', '/review', '--file', 'C:/r/b.md'])
  expect(seen).toEqual([['/c/r/a.md', '/c/r/b.md']])
  expect(
    withBoardPaths(['db', 'restore', '--file', '/c/s.db', '--passphrase-file', '/c/p.txt', '--replace-file'], upper),
  ).toEqual(['db', 'restore', '--file', 'C:/s.db', '--passphrase-file', 'C:/p.txt', '--replace-file'])
  expect(withBoardPaths(['sleep', 'wA:p2', '--pi-session', '/c/pi/s.jsonl'], upper)).toEqual([
    'sleep',
    'wA:p2',
    '--pi-session',
    'C:/pi/s.jsonl',
  ])
  expect(withBoardPaths(['call-report', '--session', '/anna', '--file', '/c/r.md'], upper)).toEqual([
    'call-report',
    '--session',
    '/anna',
    '--file',
    'C:/r.md',
  ])
  expect(withBoardPaths(['time', 'import', '/c/t.csv', '--tz', 'Asia/Tbilisi'], upper)).toEqual([
    'time',
    'import',
    'C:/t.csv',
    '--tz',
    'Asia/Tbilisi',
  ])
  expect(withBoardPaths(['--session', 'ben', 'thread', 'import', '/c/tasks.json', '--lane', 'x'], upper)).toEqual([
    '--session',
    'ben',
    'thread',
    'import',
    'C:/tasks.json',
    '--lane',
    'x',
  ])
  expect(withBoardPaths(['backup', 'folder', '/d/backups'], upper)).toEqual(['backup', 'folder', 'C:/backups'])
  // After a --, in the commands that take a file or a folder, a path is still a path.
  expect(withBoardPaths(['backup', 'folder', '--', '/d/backups'], upper)).toEqual([
    'backup',
    'folder',
    '--',
    'C:/backups',
  ])
  expect(withBoardPaths(['time', 'import', '--tz', 'UTC', '--', '/c/t.csv'], upper)).toEqual([
    'time',
    'import',
    '--tz',
    'UTC',
    '--',
    'C:/t.csv',
  ])
  // todo add's --ref: a draft file converted; a ticket or a link is no /-word.
  expect(withBoardPaths(['todo', 'add', '--ref', '/c/drafts/x.md', '/send it'], upper)).toEqual([
    'todo',
    'add',
    '--ref',
    'C:/drafts/x.md',
    '/send it',
  ])
  expect(boardPathIndexes(['todo', 'add', '--ref', 'https://x.test/1', 'text'])).toEqual([])
})

test('Windows and relative paths, and every word after --, are left as typed (#404, #532)', () => {
  for (const argv of [
    ['thread', 'post', 'atlas-12', '--file', 'C:\\r\\a.md'],
    ['call-report', '--file', 'r.md'],
    ['backup', 'folder', 'off'],
    ['thread', 'post', 'atlas-12', '--', '--file', '/c/r.md'],
    ['call-report', '--file'],
  ])
    expect(boardPathIndexes(argv)).toEqual([])
  // A converter that gives nothing back for one leaves it as typed.
  expect(withBoardPaths(['db', 'restore', '--file', '/x', '--passphrase-file', '/y'], () => ['X:/', ''])).toEqual([
    'db',
    'restore',
    '--file',
    'X:/',
    '--passphrase-file',
    '/y',
  ])
})
