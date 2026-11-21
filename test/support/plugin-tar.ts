// Plugin archives for the tests of a node's update (#590): a tar written byte by byte, so a test
// can make one `git archive` never would (a path outside, a link out, a wrong checksum), and a
// scratch plugin repository with two commits whose `git archive` is the real thing.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TarSpec {
  name: string
  /** '0' file (the default), '5' folder, '2' symlink, '1' hard link, or any other type flag. */
  type?: string
  data?: string | Uint8Array
  mode?: number
  link?: string
}

const enc = new TextEncoder()

function put(b: Uint8Array, at: number, len: number, value: string): void {
  b.set(enc.encode(value).subarray(0, len), at)
}

const oct = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`

/** One ustar header block; `checksum: false` writes a wrong one. */
export function tarHeader(s: TarSpec & { size: number }, checksum = true): Uint8Array {
  const h = new Uint8Array(512)
  put(h, 0, 100, s.name)
  put(h, 100, 8, oct(s.mode ?? 0o644, 8))
  put(h, 108, 8, oct(0, 8))
  put(h, 116, 8, oct(0, 8))
  put(h, 124, 12, oct(s.size, 12))
  put(h, 136, 12, oct(1_700_000_000, 12))
  put(h, 148, 8, '        ')
  put(h, 156, 1, s.type ?? '0')
  put(h, 157, 100, s.link ?? '')
  put(h, 257, 6, 'ustar\0')
  put(h, 263, 2, '00')
  let sum = 0
  for (const byte of h) sum += byte
  put(h, 148, 8, `${(checksum ? sum : sum + 1).toString(8).padStart(6, '0')}\0 `)
  return h
}

/** A pax record set as a header's data: `<len> <key>=<value>\n` each. */
export function paxData(records: Record<string, string>): Uint8Array {
  let out = ''
  for (const [k, v] of Object.entries(records)) {
    const body = ` ${k}=${v}\n`
    let len = body.length + 1
    while (String(len).length + body.length !== len) len = String(len).length + body.length
    out += `${len}${body}`
  }
  return enc.encode(out)
}

/** A whole archive: a pax global header with `comment` when given, the entries, the end marker. */
export function tarOf(
  entries: readonly TarSpec[],
  o: { comment?: string; badChecksum?: string } = {},
): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  const add = (s: TarSpec): void => {
    const data = typeof s.data === 'string' ? enc.encode(s.data) : (s.data ?? new Uint8Array())
    parts.push(tarHeader({ ...s, size: data.length }, s.name !== o.badChecksum))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(new Uint8Array(pad))
  }
  if (o.comment) add({ name: 'pax_global_header', type: 'g', data: paxData({ comment: o.comment }) })
  for (const e of entries) add(e)
  parts.push(new Uint8Array(1024))
  const size = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-C', dir, ...args], {
    env: { ...process.env, ...GIT_ENV, GIT_CONFIG_GLOBAL: join(dir, '..', 'no-gitconfig') },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** git's folder, for a child whose PATH holds only Bun's. */
export function gitDir(): string {
  const at = Bun.which('git')
  if (!at) throw new Error('git is not on PATH')
  return join(at, '..')
}

export interface PluginRepo {
  dir: string
  /** The first commit and the second, which changes `src/adapters/paths.ts` and adds a file. */
  a: string
  b: string
  /** `git archive --format=tar <commit>`. */
  archive(commit: string): Uint8Array<ArrayBuffer>
}

/** A scratch plugin: a package with no dependencies (`bun install --production` needs no network), two commits. */
export function pluginRepo(dir: string): PluginRepo {
  mkdirSync(join(dir, 'src', 'adapters'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'package.json'), '{ "name": "scratch-plugin", "version": "0.1.0", "dependencies": {} }\n')
  writeFileSync(join(dir, 'src', 'adapters', 'paths.ts'), 'export const V = 1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'a')
  const a = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'src', 'adapters', 'paths.ts'), 'export const V = 2\n')
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const B = true\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'b')
  const b = git(dir, 'rev-parse', 'HEAD')
  return {
    dir,
    a,
    b,
    archive(commit) {
      const r = Bun.spawnSync(['git', '-c', 'core.autocrlf=false', '-C', dir, 'archive', '--format=tar', commit], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '..', 'no-gitconfig') },
      })
      if (r.exitCode !== 0) throw new Error(`git archive: ${r.stderr.toString()}`)
      return new Uint8Array(r.stdout)
    },
  }
}
