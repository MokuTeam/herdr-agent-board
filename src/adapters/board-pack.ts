// The board's code as the local checkout has it, packed for a server (path B of the board on a
// server, call 5): its tracked files with the uncommitted changes in them (`git stash create`,
// which changes neither the checkout nor its refs), as git stores them (LF, whatever
// core.autocrlf gives the checkout), gzipped, with a mark saying which commit it is of and whether
// it has local changes (core/server-install.ts ARCHIVE_MARK). Untracked files stay behind.
import { gzipSync } from 'node:zlib'
import { ARCHIVE_MARK } from '../core/server-install.ts'
import { tarAppend } from '../core/tar.ts'
import { ROOT } from './paths.ts'

export interface BoardPack {
  /** The pack: a tar, gzipped. */
  bytes: Uint8Array
  commit: string
  changes: boolean
}

async function git(root: string, args: string[]): Promise<{ code: number; out: Uint8Array }> {
  const p = Bun.spawn(['git', '-C', root, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  })
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer())
  return { code: await p.exited, out }
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b).trim()

/** The local checkout's pack; null when the board is not a git checkout (or git is not there). */
export async function boardPack(root: string = ROOT): Promise<BoardPack | null> {
  try {
    const head = await git(root, ['rev-parse', 'HEAD'])
    const commit = text(head.out)
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return null
    const stash = await git(root, ['stash', 'create'])
    if (stash.code !== 0) return null
    const tree = text(stash.out)
    const changes = /^[0-9a-f]{40}$/.test(tree)
    const tar = await git(root, [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.eol=lf',
      'archive',
      '--format=tar',
      changes ? tree : commit,
    ])
    if (tar.code !== 0 || tar.out.length === 0) return null
    const mark = new TextEncoder().encode(`${JSON.stringify({ commit, changes })}\n`)
    return { bytes: gzipSync(tarAppend(tar.out, ARCHIVE_MARK, mark, Date.now())), commit, changes }
  } catch {
    return null
  }
}

/**
 * The local checkout's version, cheaply (no pack): its commit, and whether its tracked files have
 * uncommitted changes, as the pack would carry them (untracked files stay behind there too); null
 * when the board is not a git checkout.
 */
export async function boardHead(root: string = ROOT): Promise<{ commit: string; changes: boolean } | null> {
  try {
    const head = await git(root, ['rev-parse', 'HEAD'])
    const commit = text(head.out)
    if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return null
    const status = await git(root, ['status', '--porcelain', '--untracked-files=no'])
    if (status.code !== 0) return null
    return { commit, changes: text(status.out) !== '' }
  } catch {
    return null
  }
}
