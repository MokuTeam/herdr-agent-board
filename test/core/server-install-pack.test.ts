// Path B of the board on a server (core/server-install.ts): the command that receives the local
// checkout's pack on the server, the setup link kept out of the install's output, and the pack's
// mark added to its tar (core/tar.ts).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { receiverScript, setupLinkIn } from '../../src/core/server-install.ts'
import { tarAppend } from '../../src/core/tar.ts'

describe("path B's command and its output", () => {
  test('the receiver: the pack from stdin, unpacked in a folder of root’s own, its bootstrap run without a question', () => {
    const r = receiverScript({ domain: 'w.example.com', lang: 'ru' })
    expect(r.split('\n')[0]).toBe('# agent-board: install')
    expect(r).toContain('umask 077')
    expect(r).toContain('base64 -d > "$d/pack.tar.gz"')
    expect(r).toContain(
      'sh "$d/src/server-install.sh" --archive "$d/pack.tar.gz" --domain w.example.com --lang ru --yes </dev/null',
    )
    expect(() => receiverScript({ domain: 'a;b', lang: 'en' })).toThrow()
  })

  test('the setup link is taken out of the output: any line with a code in it', () => {
    const link = 'https://w.example.com/setup#code=abc_DEF-123'
    expect(setupLinkIn(`  ${link}`)).toBe(link)
    expect(setupLinkIn('agent-board: done')).toBeNull()
    expect(setupLinkIn('weird #code=xyz')).toBe('')
  })
})

test('a file added to a tar: tar lists and reads it after the others', async () => {
  const tarBin = Bun.which('tar')
  if (!tarBin) return
  const dir = mkdtempSync(join(tmpdir(), 'tar-append-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'first\n')
    const made = Bun.spawnSync([tarBin, '-cf', '-', '-C', dir, 'a.txt'], { stdout: 'pipe' })
    const out = tarAppend(new Uint8Array(made.stdout), '.mark.json', new TextEncoder().encode('{"x":1}\n'), 0)
    // on stdin: GNU tar takes `C:\…` for a remote host's file
    const list = Bun.spawnSync([tarBin, '-tf', '-'], { stdin: out, stdout: 'pipe' })
    expect(new TextDecoder().decode(list.stdout).trim().split(/\r?\n/)).toEqual(['a.txt', '.mark.json'])
    const read = Bun.spawnSync([tarBin, '-xOf', '-', '.mark.json'], { stdin: out, stdout: 'pipe' })
    expect(new TextDecoder().decode(read.stdout)).toBe('{"x":1}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
