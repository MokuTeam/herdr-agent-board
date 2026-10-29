// `board move` (#250): the target profile's `.claude.json` keeps its permissions when its trust is
// written (it holds the account; adapters/json-store.ts replaceFile with `mode`), and replaceFile
// without one writes as before (POSIX only: Windows has no such mode). Moving back (#256): a target
// copy the source goes on from, compared a piece at a time.
import { expect, onTestFinished, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceFile } from '../../src/adapters/json-store.ts'
import { copyTrust, isPrefixFile } from '../../src/adapters/move-files.ts'

test.skipIf(process.platform === 'win32')(
  'copyTrust keeps the target state file’s 0600; replaceFile without a mode is as before',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-move-files-'))
    const from = join(dir, 'from.json')
    const to = join(dir, 'to.json')
    writeFileSync(from, JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true } } }))
    writeFileSync(to, JSON.stringify({ oauthAccount: { id: 'x' } }))
    chmodSync(to, 0o600)
    expect(copyTrust(from, to, '/work/a b')).toBe('copied')
    expect(statSync(to).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(to, 'utf8'))).toEqual({
      oauthAccount: { id: 'x' },
      projects: { '/work/a b': { hasTrustDialogAccepted: true } },
    })
    expect(copyTrust(from, to, '/work/a b')).toBe('trusted')
    const plain = join(dir, 'plain.json')
    writeFileSync(plain, '{}')
    chmodSync(plain, 0o600)
    replaceFile(plain, '{"a":1}')
    expect(statSync(plain).mode & 0o777).toBe(0o666 & ~process.umask())
  },
)

// A session moved back (#256): the target's copy is the start of the source's transcript, read a
// piece at a time.
test('isPrefixFile: a longer file going on from the shorter one, a byte apart past the first piece', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-move-prefix-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const older = join(dir, 'older.jsonl')
  const newer = join(dir, 'newer.jsonl')
  const more = Buffer.from('{"turn":2}\n')
  // Past the 1 MiB piece, so the difference is found in a later one.
  const start = Buffer.alloc(2.5 * 1024 * 1024, 'a')
  writeFileSync(older, start)
  writeFileSync(newer, Buffer.concat([start, more]))
  expect(isPrefixFile(older, newer)).toBe(true)
  expect(isPrefixFile(newer, older)).toBe(false)
  expect(isPrefixFile(older, older)).toBe(true)
  const apart = Buffer.from(start)
  apart[apart.length - 10] = 0x62
  writeFileSync(newer, Buffer.concat([apart, more]))
  expect(isPrefixFile(older, newer)).toBe(false)
  const empty = join(dir, 'empty.jsonl')
  writeFileSync(empty, '')
  expect(isPrefixFile(empty, newer)).toBe(true)
})
