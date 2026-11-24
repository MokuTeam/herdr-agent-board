// A node's update to its master's commit (#590, services/node/update.ts), on a scratch plugin folder:
// the archive kept, checked, unpacked beside the plugin, installed, swapped in, the board told to
// restart; a wrong sha256, an archive with a path outside and a failed install leave the old copy
// as it was; one update at a time; the commit it runs is answered as current; Windows and a board
// with nothing to start it again do not update themselves. On Windows (#699) a node with a guard puts
// the new copy in place file by file, after a copy of the plugin and a pending record, and puts the
// copy back when the new copy does not go in.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backupPlugin,
  besidePlugin,
  claimPending,
  keepStream,
  loadsIn,
  mirrorTree,
  pluginCommit,
  readPending,
  saidTail,
  swapIn,
  writePending,
} from '../../src/adapters/plugin-update.ts'
import { createNodeUpdate, type NodeUpdateDeps } from '../../src/services/node/update.ts'
import { type PluginRepo, pluginRepo, tarOf } from '../support/plugin-tar.ts'

let dir: string
let repo: PluginRepo
let root: string

const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const stream = (bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> =>
  new Response(bytes).body as ReadableStream<Uint8Array>
const text = (...p: string[]): string => readFileSync(join(...p), 'utf8')

/** The plugin folder as the node has it: commit A's files and its stamp, as an archive left it. */
function unpackedA(): void {
  mkdirSync(join(root, 'src', 'adapters'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{ "name": "scratch-plugin", "version": "0.1.0", "dependencies": {} }\n')
  writeFileSync(join(root, 'src', 'adapters', 'paths.ts'), 'export const V = 1\n')
  writeFileSync(join(root, '.archive-commit'), `${repo.a}\n`)
}

function make(over: Partial<NodeUpdateDeps> = {}) {
  const restarts: string[] = []
  const logs: string[] = []
  const update = createNodeUpdate({
    root,
    dir: join(dir, 'state', 'node', 'update'),
    commit: async () => repo.a,
    platform: 'linux',
    canRestart: true,
    restart: old => restarts.push(old),
    log: t => logs.push(t),
    ...over,
  })
  return { update, restarts, logs }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'node-update-'))
  repo = pluginRepo(join(dir, 'repo'))
  root = join(dir, 'home', 'agent-board')
  unpackedA()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** The old copy is the plugin's folder as it was, and nothing was left beside it. */
function oldCopyStands(): void {
  expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
  expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
  expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
  expect(existsSync(besidePlugin(root).fresh)).toBe(false)
  expect(existsSync(besidePlugin(root).old)).toBe(false)
}

describe('a node updates its plugin', () => {
  test('an unpack, a load check and a swap that fail leave the old copy, and say which step', async () => {
    const archive = repo.archive(repo.b)
    const cases = [
      [
        {
          unpack: () => {
            throw new Error('disk full')
          },
        },
        'unpack',
        'disk full',
      ],
      [
        { check: async () => ({ ok: false, detail: 'SyntaxError: Unexpected token' }) },
        'loads',
        'SyntaxError: Unexpected token',
      ],
      [
        {
          swap: () => {
            throw new Error('EBUSY')
          },
        },
        'swap',
        'EBUSY',
      ],
    ] as const
    for (const [over, error, detail] of cases) {
      const { update, restarts } = make(over)
      await update.blob(stream(archive), archive.length)
      expect(await update.update({ commit: repo.b, sha256: sha(archive) })).toEqual({
        status: 500,
        body: { ok: false, error, detail },
      })
      expect(restarts).toEqual([])
      expect(update.busy()).toBe(false)
      oldCopyStands()
    }
  })

  test('a second archive while one comes in is answered busy, and an update meanwhile too', async () => {
    const { update } = make()
    const archive = repo.archive(repo.b)
    let go = (): void => {}
    const slow = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(archive.subarray(0, 512))
        await new Promise<void>(resolve => {
          go = resolve
        })
        c.enqueue(archive.subarray(512))
        c.close()
      },
    })
    const first = update.blob(slow, archive.length)
    await Bun.sleep(20)
    expect((await update.blob(stream(archive), archive.length)).body.error).toBe('busy')
    expect((await update.update({ commit: repo.b, sha256: sha(archive) })).body.error).toBe('busy')
    go()
    expect((await first).body).toEqual({ ok: true, sha256: sha(archive), size: archive.length })
  })

  test('a good update: kept, checked, unpacked, installed, swapped in, stamped, and the board told to restart', async () => {
    const { update, restarts, logs } = make()
    const folder = statSync(root).ino
    const archive = repo.archive(repo.b)
    const kept = await update.blob(stream(archive), archive.length)
    expect(kept).toEqual({ status: 200, body: { ok: true, sha256: sha(archive), size: archive.length } })
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r).toEqual({ status: 200, body: { ok: true, commit: repo.b, restarting: true } })
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 2\n')
    expect(text(root, 'src', 'b.ts')).toBe('export const B = true\n')
    expect(text(root, '.archive-commit')).toBe(`${repo.b}\n`)
    // bun install --production ran in the new copy before it went in
    expect(existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'node_modules'))).toBe(true)
    const { fresh, old } = besidePlugin(root)
    expect(existsSync(fresh)).toBe(false)
    expect(text(old, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(restarts).toEqual([old])
    // the plugin's folder is the same folder: the panes herdr started in it keep one that exists
    expect(statSync(root).ino).toBe(folder)
    // the archive does not stay on the node once it is in place
    expect(readdirSync(join(dir, 'state', 'node', 'update'))).toEqual([])
    expect(logs.join('\n')).toContain(`updated to ${repo.b.slice(0, 12)}`)
    // still busy until the board has restarted: a second update waits for the new code
    expect(update.busy()).toBe(true)
    expect((await update.update({ commit: repo.b, sha256: sha(archive) })).body.error).toBe('busy')
  })

  test('a plugin that is a git checkout is updated the same way: the folder is the archive with its stamp after it', async () => {
    rmSync(root, { recursive: true, force: true })
    const checkout = Bun.spawnSync(['git', 'clone', '-q', repo.dir, root])
    expect(checkout.exitCode).toBe(0)
    Bun.spawnSync(['git', '-C', root, 'checkout', '-q', repo.a])
    const { update } = make()
    const archive = repo.archive(repo.b)
    await update.blob(stream(archive), archive.length)
    expect((await update.update({ commit: repo.b, sha256: sha(archive) })).status).toBe(200)
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(text(root, '.archive-commit')).toBe(`${repo.b}\n`)
    expect(existsSync(join(besidePlugin(root).old, '.git'))).toBe(true)
  })

  test('a wrong sha256 leaves the old copy as it was', async () => {
    const { update, restarts } = make()
    const archive = repo.archive(repo.b)
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: 'f'.repeat(64) })
    expect(r).toEqual({ status: 409, body: { ok: false, error: 'sha256' } })
    oldCopyStands()
    expect(restarts).toEqual([])
    expect(update.busy()).toBe(false)
  })

  test('an archive with a path outside is refused before anything is written', async () => {
    const { update, restarts } = make()
    const archive = tarOf([
      { name: 'package.json', data: '{}' },
      { name: '../../evil.ts', data: 'pwned' },
    ])
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r.status).toBe(422)
    expect(r.body.error).toBe('archive')
    expect(String(r.body.detail)).toContain('leaves the folder')
    expect(existsSync(join(dir, 'evil.ts'))).toBe(false)
    expect(existsSync(join(dir, 'home', 'evil.ts'))).toBe(false)
    oldCopyStands()
    expect(restarts).toEqual([])
  })

  test('an archive of another commit than the one named is refused', async () => {
    const { update } = make()
    const archive = repo.archive(repo.a)
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r.body).toEqual({ ok: false, error: 'archive', detail: 'the archive is of another commit' })
    oldCopyStands()
  })

  test('a failed bun install --production leaves the old copy in place and working', async () => {
    const { update, restarts } = make()
    // A dependency that cannot be had: what an install without the network comes to.
    const archive = tarOf(
      [
        {
          name: 'package.json',
          data: '{ "name": "x", "version": "1.0.0", "dependencies": { "nope": "file:./missing" } }',
        },
        { name: 'src/adapters/paths.ts', data: 'export const V = 3\n' },
      ],
      { comment: repo.b },
    )
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r.status).toBe(500)
    expect(r.body.error).toBe('install')
    expect(String(r.body.detail)).toContain('nope')
    oldCopyStands()
    expect(restarts).toEqual([])
    expect(update.busy()).toBe(false)
  })

  test('a second update while one runs is answered busy, and so is an archive sent meanwhile', async () => {
    let release = (): void => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let installs = 0
    const { update } = make({
      install: async () => {
        installs++
        await held
        return { ok: true, detail: '' }
      },
    })
    const archive = repo.archive(repo.b)
    await update.blob(stream(archive), archive.length)
    const first = update.update({ commit: repo.b, sha256: sha(archive) })
    await Bun.sleep(20)
    expect(await update.update({ commit: repo.b, sha256: sha(archive) })).toEqual({
      status: 409,
      body: { ok: false, error: 'busy' },
    })
    expect((await update.blob(stream(archive), archive.length)).body.error).toBe('busy')
    release()
    expect((await first).status).toBe(200)
    expect(installs).toBe(1)
  })

  test('the commit it runs already is answered as current, and nothing changes', async () => {
    const { update, restarts } = make()
    const r = await update.update({ commit: repo.a, sha256: 'a'.repeat(64) })
    expect(r).toEqual({ status: 200, body: { ok: true, current: true, commit: repo.a } })
    oldCopyStands()
    expect(restarts).toEqual([])
    expect(update.busy()).toBe(false)
  })

  test('no archive kept, a body that is no update, and one too big are refused', async () => {
    const { update } = make()
    expect((await update.update({ commit: repo.b, sha256: 'a'.repeat(64) })).body.error).toBe('blob')
    expect((await update.update({ commit: 'main', sha256: 'a'.repeat(64) })).body.error).toBe('update')
    expect((await update.update(null)).body.error).toBe('update')
    expect((await update.blob(stream(new Uint8Array(4)), 200 * 1024 * 1024)).status).toBe(413)
    oldCopyStands()
  })

  test('on Windows with no guard to give, and with nothing to start the board again, the node does not update itself', async () => {
    const archive = repo.archive(repo.b)
    for (const [over, error] of [
      [{ platform: 'win32' }, 'platform'],
      [{ canRestart: false }, 'restart'],
    ] as const) {
      const { update, restarts } = make(over)
      expect(await update.blob(stream(archive), archive.length)).toEqual({ status: 409, body: { ok: false, error } })
      expect(await update.update({ commit: repo.b, sha256: sha(archive) })).toEqual({
        status: 409,
        body: { ok: false, error },
      })
      expect(restarts).toEqual([])
    }
    oldCopyStands()
  })
})

describe("the update's files", () => {
  test('swapIn moves entries, not the folder; a rename that fails puts every entry back', () => {
    const fresh = join(dir, 'home', 'agent-board.new')
    const old = join(dir, 'home', 'agent-board.old')
    mkdirSync(join(fresh, 'src'), { recursive: true })
    writeFileSync(join(fresh, 'package.json'), 'new')
    writeFileSync(join(fresh, 'src', 'b.ts'), 'new')
    let calls = 0
    const failing = (from: string, to: string): void => {
      calls++
      // the plugin's entries go aside (three of them), then the first of the new copy's fails
      if (calls === 4) throw new Error('EPERM')
      renameSync(from, to)
    }
    expect(() => swapIn(root, fresh, old, failing)).toThrow('EPERM')
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(readdirSync(root).sort()).toEqual(['.archive-commit', 'package.json', 'src'])
    expect(readdirSync(old)).toEqual([])
    expect(readdirSync(fresh).sort()).toEqual(['package.json', 'src'])
    swapIn(root, fresh, old)
    expect(text(root, 'package.json')).toBe('new')
    expect(text(old, 'package.json')).toContain('scratch-plugin')
    expect(existsSync(fresh)).toBe(false)
  })

  test('keepStream stops at its limit without a length told, and leaves no part behind', async () => {
    const file = join(dir, 'state', 'kept.tar')
    expect(await keepStream(stream(new Uint8Array(64)), file, 10)).toBeNull()
    expect(existsSync(file)).toBe(false)
    expect(readdirSync(join(dir, 'state'))).toEqual([])
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4))
        c.error(new Error('the connection dropped'))
      },
    })
    await expect(keepStream(broken, file, 100)).rejects.toThrow('the connection dropped')
    expect(readdirSync(join(dir, 'state'))).toEqual([])
  })

  test('loadsIn: a copy whose web board does not parse is refused, one that loads passes', async () => {
    mkdirSync(join(dir, 'bad', 'src', 'server'), { recursive: true })
    writeFileSync(join(dir, 'bad', 'src', 'server', 'app.ts'), 'export const = 1\n')
    const bad = await loadsIn(join(dir, 'bad'), 30_000)
    expect(bad.ok).toBe(false)
    expect(bad.detail.length).toBeGreaterThan(0)
    mkdirSync(join(dir, 'good', 'src', 'server'), { recursive: true })
    writeFileSync(join(dir, 'good', 'src', 'server', 'app.ts'), 'export const fine = setInterval(() => {}, 1000)\n')
    expect(await loadsIn(join(dir, 'good'), 30_000)).toEqual({ ok: true, detail: '' })
  })

  test("what bun install said loses a URL's password", () => {
    expect(saidTail('GET https://user:s3cret@registry.example.com/x - 401')).toBe(
      'GET https://***@registry.example.com/x - 401',
    )
    expect(saidTail('x'.repeat(700)).length).toBe(600)
  })

  test("pluginCommit: a checkout's HEAD; with no .git of its own, the stamp, never a repository it sits in", async () => {
    expect(await pluginCommit(repo.dir)).toBe(repo.b)
    // a plugin folder inside the repository, with no .git of its own
    const inside = join(repo.dir, 'plugin')
    mkdirSync(inside)
    expect(await pluginCommit(inside)).toBe('')
    writeFileSync(join(inside, '.archive-commit'), `${repo.a}\n`)
    expect(await pluginCommit(inside)).toBe(repo.a)
  })
})

const pendingFile = (): string => join(dir, 'state', 'node', 'update', 'pending.json')
const stub = {
  install: async () => ({ ok: true, detail: '' }),
  check: async () => ({ ok: true, detail: '' }),
}

describe('a Windows node updates its plugin in place', () => {
  test('a copy of the plugin and the record first, the guard started, then the files in place, and the board told to restart', async () => {
    const seen: string[] = []
    const guard = (file: string, old: string): void => {
      // by now: the plugin's folder is as it was, the copy before is whole, the record is written
      seen.push(
        `${file}|${old}|${text(root, 'src', 'adapters', 'paths.ts')}|${text(old, 'src', 'adapters', 'paths.ts')}`,
      )
      expect(readPending(file)).toMatchObject({ commit: repo.b, from: repo.a, root, old })
    }
    const { update, restarts, logs } = make({
      ...stub,
      platform: 'win32',
      guard,
      swap: () => {
        throw new Error('the folders are not swapped on Windows')
      },
    })
    const folder = statSync(root).ino
    const src = statSync(join(root, 'src')).ino
    const archive = repo.archive(repo.b)
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r).toEqual({ status: 200, body: { ok: true, commit: repo.b, restarting: true } })
    const { fresh, old } = besidePlugin(root)
    expect(seen).toEqual([`${pendingFile()}|${old}|export const V = 1\n|export const V = 1\n`])
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 2\n')
    expect(text(root, 'src', 'b.ts')).toBe('export const B = true\n')
    expect(text(root, '.archive-commit')).toBe(`${repo.b}\n`)
    expect(text(old, '.archive-commit')).toBe(`${repo.a}\n`)
    expect(existsSync(join(old, 'src', 'b.ts'))).toBe(false)
    expect(existsSync(fresh)).toBe(false)
    // in place: the plugin's folder and its src are the same folders
    expect(statSync(root).ino).toBe(folder)
    expect(statSync(join(root, 'src')).ino).toBe(src)
    expect(readPending(pendingFile())).toMatchObject({ commit: repo.b, from: repo.a, root, old })
    expect(restarts).toEqual([old])
    expect(logs.join('\n')).toContain(`updated to ${repo.b.slice(0, 12)}`)
    expect(update.busy()).toBe(true)
  })

  test('Linux and macOS go through the swap as before: no copy, no record, no guard', async () => {
    for (const platform of ['linux', 'darwin']) {
      let guards = 0
      const { update, restarts } = make({
        ...stub,
        platform,
        guard: () => void guards++,
        backup: () => {
          throw new Error('no backup here')
        },
        mirror: () => {
          throw new Error('no mirror here')
        },
      })
      const archive = repo.archive(repo.b)
      await update.blob(stream(archive), archive.length)
      const r = await update.update({ commit: repo.b, sha256: sha(archive) })
      expect(r.status).toBe(200)
      expect(guards).toBe(0)
      expect(existsSync(pendingFile())).toBe(false)
      expect(text(besidePlugin(root).old, '.archive-commit')).toBe(`${repo.a}\n`)
      expect(restarts).toHaveLength(1)
      // each platform starts from commit A again
      rmSync(root, { recursive: true, force: true })
      rmSync(besidePlugin(root).old, { recursive: true, force: true })
      unpackedA()
    }
  })

  test('a mirror that fails half way is put back at once from the copy before, and no restart follows', async () => {
    const { fresh } = besidePlugin(root)
    const { update, restarts } = make({
      ...stub,
      platform: 'win32',
      guard: () => {},
      mirror: (from, to) => {
        if (from !== fresh) return mirrorTree(from, to)
        writeFileSync(join(to, 'src', 'b.ts'), 'half')
        throw new Error('EBUSY')
      },
    })
    const archive = repo.archive(repo.b)
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'swap', detail: 'EBUSY' } })
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
    expect(existsSync(pendingFile())).toBe(false)
    expect(existsSync(fresh)).toBe(false)
    expect(restarts).toEqual([])
    expect(update.busy()).toBe(false)
  })

  test('a mirror and its put-back that both fail keep the record for the guard, and the log names both', async () => {
    const { update, restarts, logs } = make({
      ...stub,
      platform: 'win32',
      guard: () => {},
      mirror: (from, to) => {
        throw new Error(from === besidePlugin(root).fresh ? 'EBUSY first' : `EPERM back into ${to === root}`)
      },
    })
    const archive = repo.archive(repo.b)
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r.body).toEqual({ ok: false, error: 'swap', detail: 'EBUSY first' })
    expect(readPending(pendingFile())).toMatchObject({ commit: repo.b, from: repo.a })
    expect(logs.join('\n')).toContain('EBUSY first')
    expect(logs.join('\n')).toContain('EPERM back into true')
    expect(restarts).toEqual([])
    expect(update.busy()).toBe(false)
  })

  test('a copy that cannot be made and a guard that does not start leave the plugin as it was', async () => {
    const archive = repo.archive(repo.b)
    for (const [over, detail] of [
      [
        {
          guard: () => {
            throw new Error('spawn failed')
          },
        },
        'the guard that puts the copy before back did not start: spawn failed',
      ],
      [
        {
          guard: () => {},
          backup: () => {
            throw new Error('disk full')
          },
        },
        'disk full',
      ],
    ] as const) {
      const { update, restarts } = make({ ...stub, platform: 'win32', ...over })
      await update.blob(stream(archive), archive.length)
      const r = await update.update({ commit: repo.b, sha256: sha(archive) })
      expect(r).toEqual({ status: 500, body: { ok: false, error: 'swap', detail } })
      expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
      expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
      expect(existsSync(pendingFile())).toBe(false)
      expect(existsSync(besidePlugin(root).fresh)).toBe(false)
      expect(restarts).toEqual([])
      expect(update.busy()).toBe(false)
    }
  })

  test('started: the board that came back on the commit removes the record; another commit leaves it; Linux reads nothing', async () => {
    const record = { commit: repo.b, from: repo.a, root, old: besidePlugin(root).old, at: 1 }
    writePending(pendingFile(), record)
    const wrong = make({ platform: 'win32', guard: () => {} })
    await wrong.update.started()
    expect(readPending(pendingFile())).toEqual(record)
    expect(wrong.logs).toEqual([])
    const linux = make({ platform: 'linux', commit: async () => repo.b })
    await linux.update.started()
    expect(readPending(pendingFile())).toEqual(record)
    const back = make({ platform: 'win32', guard: () => {}, commit: async () => repo.b })
    await back.update.started()
    expect(existsSync(pendingFile())).toBe(false)
    expect(back.logs.join('\n')).toContain(`back on ${repo.b.slice(0, 12)}`)
    // nothing pending: nothing happens
    await back.update.started()
  })
})

describe('the Windows update files', () => {
  const put = (base: string, rel: string, data: string): void => {
    mkdirSync(join(base, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(base, ...rel.split('/')), data)
  }

  test('mirrorTree writes only the files that differ, removes what the source lacks, and keeps the folders', () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    put(from, 'same.ts', 'same')
    put(from, 'src/new.ts', 'new')
    put(from, 'src/changed.ts', 'after')
    put(from, 'asfolder/inner.ts', 'inner')
    put(from, 'asfile', 'file now')
    put(to, 'same.ts', 'same')
    put(to, 'src/changed.ts', 'before')
    put(to, 'src/gone.ts', 'gone')
    put(to, 'gone/deep/x.ts', 'x')
    put(to, 'asfolder', 'was a file')
    put(to, 'asfile/inner.ts', 'was a folder')
    const old = new Date(2000, 0, 1)
    utimesSync(join(to, 'same.ts'), old, old)
    const folder = statSync(to).ino
    const src = statSync(join(to, 'src')).ino
    mirrorTree(from, to)
    expect(text(to, 'same.ts')).toBe('same')
    expect(statSync(join(to, 'same.ts')).mtimeMs).toBe(old.getTime())
    expect(text(to, 'src', 'changed.ts')).toBe('after')
    expect(text(to, 'src', 'new.ts')).toBe('new')
    expect(existsSync(join(to, 'src', 'gone.ts'))).toBe(false)
    expect(existsSync(join(to, 'gone'))).toBe(false)
    expect(text(to, 'asfolder', 'inner.ts')).toBe('inner')
    expect(text(to, 'asfile')).toBe('file now')
    expect(statSync(to).ino).toBe(folder)
    expect(statSync(join(to, 'src')).ino).toBe(src)
    expect(readdirSync(join(to, 'src')).sort()).toEqual(['changed.ts', 'new.ts'])
    // a second time changes nothing
    const writes: string[] = []
    mirrorTree(from, to, f => void writes.push(f))
    expect(writes).toEqual([])
  })

  test('mirrorTree: a name that changes only in case ends with the new name alone, and a link is followed as a link', () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    put(from, 'src/foo.ts', 'x')
    put(to, 'src/Foo.ts', 'x')
    symlinkSync('foo.ts', join(from, 'src', 'link.ts'))
    mirrorTree(from, to)
    expect(readdirSync(join(to, 'src')).sort()).toEqual(['foo.ts', 'link.ts'])
    expect(readFileSync(join(to, 'src', 'link.ts'), 'utf8')).toBe('x')
  })

  test('backupPlugin copies everything, a .git folder too, and replaces an older copy', () => {
    put(root, '.git/HEAD', 'ref')
    put(root, 'node_modules/dep/index.js', 'dep')
    const old = join(dir, 'home', 'agent-board.old')
    put(old, 'stale.ts', 'stale')
    backupPlugin(root, old)
    expect(existsSync(join(old, 'stale.ts'))).toBe(false)
    expect(text(old, '.git', 'HEAD')).toBe('ref')
    expect(text(old, 'node_modules', 'dep', 'index.js')).toBe('dep')
    expect(text(old, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
  })

  test('claimPending gives the record once, and leaves nothing beside it', () => {
    const file = join(dir, 'state', 'pending.json')
    expect(claimPending(file)).toBeNull()
    writePending(file, { commit: repo.b, from: repo.a, root, old: `${root}.old`, at: 5 })
    expect(claimPending(file)).toEqual({ commit: repo.b, from: repo.a, root, old: `${root}.old`, at: 5 })
    expect(claimPending(file)).toBeNull()
    expect(readdirSync(join(dir, 'state'))).toEqual([])
    writeFileSync(file, 'not json')
    expect(readPending(file)).toBeNull()
  })
})
