// `board move` (#250): the target profile's `.claude.json` keeps its permissions when its trust is
// written (it holds the account; adapters/json-store.ts replaceFile with `mode`), and replaceFile
// without one writes as before. POSIX only: Windows has no such mode.
import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceFile } from '../../src/adapters/json-store.ts'
import { copyTrust } from '../../src/adapters/move-files.ts'

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
