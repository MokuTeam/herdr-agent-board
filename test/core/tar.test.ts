// A plugin archive read as data (#590, core/tar.ts): what `git archive` writes is read whole, with
// its commit, the board's own checkout too; a path outside, any link, a wrong checksum and an
// archive cut short are refused before anything is written.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTar, safeTarPath, type TarRead } from '../../src/core/tar.ts'
import { paxData, pluginRepo, tarOf } from '../support/plugin-tar.ts'
import { root } from '../support/sandbox.ts'

const read = (bytes: Uint8Array): TarRead => {
  const r = readTar(bytes)
  if ('error' in r) throw new Error(r.error)
  return r
}
const refused = (bytes: Uint8Array): string => {
  const r = readTar(bytes)
  if (!('error' in r)) throw new Error('read, not refused')
  return r.error
}

describe('readTar', () => {
  test("git archive's tar: every file with its content and the commit from the pax global header", () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-test-'))
    try {
      const repo = pluginRepo(join(dir, 'repo'))
      const r = read(repo.archive(repo.b))
      expect(r.comment).toBe(repo.b)
      const files = r.entries.filter(e => e.kind === 'file')
      expect(files.map(f => f.path).sort()).toEqual(['package.json', 'src/adapters/paths.ts', 'src/b.ts'])
      const paths = files.find(f => f.path === 'src/adapters/paths.ts')
      expect(paths?.kind === 'file' && new TextDecoder().decode(paths.data)).toBe('export const V = 2\n')
      expect(r.entries.filter(e => e.kind === 'folder').map(e => e.path)).toContain('src/adapters')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the board's own checkout at HEAD, at its real size: read whole, one file for each git tracks", () => {
    const head = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD']).stdout.toString().trim()
    const tar = Bun.spawnSync(['git', '-C', root, 'archive', '--format=tar', head], { maxBuffer: 256 * 1024 * 1024 })
    expect(tar.exitCode).toBe(0)
    const r = read(new Uint8Array(tar.stdout))
    expect(r.comment).toBe(head)
    const tracked = Bun.spawnSync(['git', '-C', root, 'ls-tree', '-r', '--name-only', head])
      .stdout.toString()
      .trim()
      .split('\n')
    expect(r.entries.filter(e => e.kind === 'file').length).toBe(tracked.length)
  })

  test('the mode keeps only whether a file runs; a pax path stands for the short name', () => {
    const long = `${'a/'.repeat(80)}tool.sh`
    const r = read(
      tarOf([
        { name: 'x', type: 'x', data: paxData({ path: long }) },
        { name: 'short-name', data: '#!/bin/sh\n', mode: 0o775 },
        { name: 'plain.txt', data: 'hi', mode: 0o664 },
      ]),
    )
    expect(r.entries).toEqual([
      { kind: 'file', path: long, mode: 0o755, data: expect.any(Uint8Array) },
      { kind: 'file', path: 'plain.txt', mode: 0o644, data: expect.any(Uint8Array) },
    ])
    expect(r.comment).toBeNull()
  })

  test.each([['../evil.ts'], ['src/../../evil.ts'], ['/etc/passwd'], ['C:/Windows/evil.ts'], ['src\\..\\evil.ts']])(
    'a path outside is refused: %s',
    name => {
      const tar = tarOf([
        { name: 'ok.ts', data: '1' },
        { name, data: 'x' },
      ])
      expect(refused(tar)).toContain('a path that leaves the folder')
    },
  )

  test('a pax path outside is refused as the short name would be', () => {
    const tar = tarOf([
      { name: 'x', type: 'x', data: paxData({ path: '../../x' }) },
      { name: 'ok.ts', data: '1' },
    ])
    expect(refused(tar)).toContain('leaves the folder')
  })

  test('every link is refused, a hard link and one inside the folder too, and so is a device', () => {
    expect(refused(tarOf([{ name: 'l', type: '2', link: '../../etc' }]))).toContain('a link: l')
    expect(refused(tarOf([{ name: 'src/l', type: '2', link: '../package.json' }]))).toContain('a link: src/l')
    expect(refused(tarOf([{ name: 'h', type: '1', link: 'package.json' }]))).toContain('a link: h')
    expect(refused(tarOf([{ name: 'dev', type: '3' }]))).toContain('an entry of type')
  })

  test('a path under a file and a path written twice are refused', () => {
    const under = tarOf([
      { name: 'a', data: '1' },
      { name: 'a/b.ts', data: '2' },
    ])
    expect(refused(under)).toContain('a path under a file')
    const twice = tarOf([
      { name: 'a.ts', data: '1' },
      { name: 'a.ts', data: '2' },
    ])
    expect(refused(twice)).toContain('written twice')
  })

  test('a wrong checksum, an archive cut short and one with no end marker are refused', () => {
    expect(refused(tarOf([{ name: 'a.ts', data: '1' }], { badChecksum: 'a.ts' }))).toContain('wrong checksum')
    const whole = tarOf([{ name: 'a.ts', data: 'x'.repeat(2000) }])
    expect(refused(whole.subarray(0, 1024))).toContain('cut short')
    expect(refused(whole.subarray(0, whole.length - 1024))).toContain('end marker')
  })
})

describe('the path rule', () => {
  test('safeTarPath keeps a plain relative path and drops "." and empty segments', () => {
    expect(safeTarPath('./src//a.ts')).toBe('src/a.ts')
    expect(safeTarPath('src/')).toBe('src')
    for (const bad of ['', '/', '..', 'a/../..', '/a', 'C:a', 'a\\b', 'a\0b']) expect(safeTarPath(bad)).toBeNull()
  })
})
