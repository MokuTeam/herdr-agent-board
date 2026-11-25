// A node's update to its master's commit (#590, services/node/update.ts), on a scratch plugin folder:
// the archive kept, checked, unpacked beside the plugin, installed, swapped in, the board told to
// restart; a wrong sha256, an archive with a path outside and a failed install leave the old copy
// as it was; one update at a time; the commit it runs is answered as current; Windows and a board
// with nothing to start it again do not update themselves. On Windows (#699) a node with a guard puts
// a copy of the plugin and a pending record, starts a guard and says go, and writes nothing into the
// plugin's folder itself; what the guard and the board that comes back do is tested here and in
// node-update-guard.test.ts.
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
  aliveAt,
  applyUpdate,
  backupPlugin,
  besidePlugin,
  claimPending,
  goLater,
  keepStream,
  loadsIn,
  mirrorTree,
  pluginCommit,
  readPending,
  removeAlive,
  restorePlugin,
  saidTail,
  setPhase,
  swapIn,
  writeAlive,
  writePending,
  writeTree,
} from '../../src/adapters/plugin-update.ts'
import { readTar } from '../../src/core/tar.ts'
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

describe('a Windows node hands its update to a guard', () => {
  test('a copy of the plugin and the record first, the guard started and heard, then go; nothing of the plugin written', async () => {
    const seen: string[] = []
    const gos: string[] = []
    const guard = (file: string, old: string): void => {
      // by now: the copy before is whole, the record says ready
      seen.push(`${file}|${old}|${text(old, 'src', 'adapters', 'paths.ts')}|${readPending(file)?.phase}`)
      writeAlive(file)
    }
    const { update, restarts, logs } = make({
      ...stub,
      platform: 'win32',
      guard,
      go: file => void gos.push(`${file}|${readPending(file)?.phase}`),
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
    expect(seen).toEqual([`${pendingFile()}|${old}|export const V = 1\n|ready`])
    expect(gos).toEqual([`${pendingFile()}|ready`])
    expect(readPending(pendingFile())).toMatchObject({ commit: repo.b, from: repo.a, root, old, fresh, phase: 'ready' })
    // the board wrote nothing into the plugin: the guard does
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
    expect(statSync(root).ino).toBe(folder)
    expect(statSync(join(root, 'src')).ino).toBe(src)
    // the copy before is whole
    expect(text(old, '.archive-commit')).toBe(`${repo.a}\n`)
    expect(text(fresh, 'src', 'b.ts')).toBe('export const B = true\n')
    expect(restarts).toEqual([])
    expect(logs.join('\n')).toContain('handed to the guard')
    expect(update.busy()).toBe(true)
  })

  test('Linux and macOS go through the swap as before: no copy, no record, no guard, no go', async () => {
    for (const platform of ['linux', 'darwin']) {
      let calls = 0
      const { update, restarts } = make({
        ...stub,
        platform,
        guard: () => void calls++,
        go: () => void calls++,
        alive: () => {
          calls++
          return Date.now() + 1e9
        },
        backup: async () => {
          throw new Error('no backup here')
        },
      })
      const archive = repo.archive(repo.b)
      await update.blob(stream(archive), archive.length)
      const r = await update.update({ commit: repo.b, sha256: sha(archive) })
      expect(r).toEqual({ status: 200, body: { ok: true, commit: repo.b, restarting: true } })
      expect(calls).toBe(0)
      expect(existsSync(pendingFile())).toBe(false)
      expect(text(besidePlugin(root).old, '.archive-commit')).toBe(`${repo.a}\n`)
      expect(text(root, '.archive-commit')).toBe(`${repo.b}\n`)
      expect(restarts).toHaveLength(1)
      // started() reads nothing off Windows: a record stays as it is
      writePending(pendingFile(), { commit: repo.b, from: repo.a, root, old: '', fresh: '', phase: 'applied', at: 1 })
      await update.started()
      expect(readPending(pendingFile())?.phase).toBe('applied')
      rmSync(pendingFile())
      // each platform starts from commit A again
      rmSync(root, { recursive: true, force: true })
      rmSync(besidePlugin(root).old, { recursive: true, force: true })
      unpackedA()
    }
  })

  test('a guard that does not start, one that never answers, a copy that cannot be made: the plugin is as it was', async () => {
    const archive = repo.archive(repo.b)
    const cases = [
      [
        {
          guard: () => {
            throw new Error('spawn failed')
          },
        },
        'the guard that puts the copy before back did not start: spawn failed',
      ],
      [{ guard: () => {}, ackMs: 600 }, 'the guard that puts the copy before back did not start: no answer within 1 s'],
      [
        {
          guard: () => {},
          backup: async () => {
            throw new Error('disk full')
          },
        },
        'disk full',
      ],
    ] as const
    for (const [over, detail] of cases) {
      let went = 0
      const { update, restarts } = make({ ...stub, platform: 'win32', go: () => void went++, ...over })
      await update.blob(stream(archive), archive.length)
      const r = await update.update({ commit: repo.b, sha256: sha(archive) })
      expect(r).toEqual({ status: 500, body: { ok: false, error: 'swap', detail } })
      expect(went).toBe(0)
      expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
      expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
      expect(existsSync(pendingFile())).toBe(false)
      expect(aliveAt(pendingFile())).toBeNull()
      expect(existsSync(besidePlugin(root).fresh)).toBe(false)
      expect(restarts).toEqual([])
      expect(update.busy()).toBe(false)
    }
  })

  test('a go that cannot be said drops the record and the new copy, and the node can try again', async () => {
    const { update } = make({
      ...stub,
      platform: 'win32',
      guard: file => writeAlive(file),
      go: () => {
        throw new Error('EPERM')
      },
    })
    const archive = repo.archive(repo.b)
    await update.blob(stream(archive), archive.length)
    const r = await update.update({ commit: repo.b, sha256: sha(archive) })
    expect(r).toEqual({ status: 500, body: { ok: false, error: 'swap', detail: 'EPERM' } })
    expect(existsSync(pendingFile())).toBe(false)
    expect(aliveAt(pendingFile())).toBeNull()
    expect(existsSync(besidePlugin(root).fresh)).toBe(false)
    expect(update.busy()).toBe(false)
  })

  test('started: only a copy the guard put in place, on the commit it was given, taken once', async () => {
    const base = {
      commit: repo.b,
      from: repo.a,
      root,
      old: besidePlugin(root).old,
      fresh: besidePlugin(root).fresh,
      at: 1,
    }
    // not yet in place, or being rolled back: the record stays
    for (const phase of ['ready', 'go', 'restoring'] as const) {
      writePending(pendingFile(), { ...base, phase })
      const { update, logs } = make({ platform: 'win32', guard: () => {}, commit: async () => repo.b })
      await update.started()
      expect(readPending(pendingFile())?.phase).toBe(phase)
      expect(logs).toEqual([])
    }
    // in place, but another commit runs
    writePending(pendingFile(), { ...base, phase: 'applied' })
    const wrong = make({ platform: 'win32', guard: () => {} })
    await wrong.update.started()
    expect(readPending(pendingFile())?.phase).toBe('applied')
    // in place and running: taken, once
    const back = make({ platform: 'win32', guard: () => {}, commit: async () => repo.b })
    await back.update.started()
    expect(existsSync(pendingFile())).toBe(false)
    expect(existsSync(`${pendingFile()}.rollback`)).toBe(false)
    expect(back.logs.join('\n')).toContain(`back on ${repo.b.slice(0, 12)}`)
    await back.update.started()
    expect(back.logs).toHaveLength(1)
  })

  test('a board killed in the middle of the mirror has no commit to confirm: the record stays for the guard', async () => {
    const { fresh, old } = besidePlugin(root)
    await backupPlugin(root, old)
    const read = readTar(repo.archive(repo.b))
    if ('error' in read) throw new Error(read.error)
    writeTree(fresh, [
      ...read.entries,
      { kind: 'file', path: '.archive-commit', mode: 0o644, data: new TextEncoder().encode(`${repo.b}\n`) },
    ])
    let writes = 0
    expect(() =>
      applyUpdate(fresh, root, old, (file, data, mode) => {
        if (++writes === 2) throw new Error('killed')
        writeFileSync(file, data, { mode })
      }),
    ).toThrow('killed')
    // a half copy: files of both, and no stamp at all
    expect(existsSync(join(root, '.archive-commit'))).toBe(false)
    expect(await pluginCommit(root)).toBe('')
    writePending(pendingFile(), { commit: repo.b, from: repo.a, root, old, fresh, phase: 'applied', at: 1 })
    const { update } = make({ platform: 'win32', guard: () => {}, commit: () => pluginCommit(root) })
    await update.started()
    expect(readPending(pendingFile())?.phase).toBe('applied')
    // and the copy before restores it whole, stamp last
    restorePlugin(old, root)
    expect(await pluginCommit(root)).toBe(repo.a)
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(existsSync(join(root, 'src', 'b.ts'))).toBe(false)
  })

  test('a pending record in any phase answers busy to an archive and an update, and nothing is touched', async () => {
    const archive = repo.archive(repo.b)
    const { fresh, old } = besidePlugin(root)
    for (const phase of ['ready', 'go', 'applied', 'restoring'] as const) {
      const record = { commit: repo.b, from: repo.a, root, old, fresh, phase, at: 1 }
      writePending(pendingFile(), record)
      let calls = 0
      const { update, restarts } = make({
        ...stub,
        platform: 'win32',
        guard: () => void calls++,
        backup: async () => void calls++,
      })
      expect(update.busy()).toBe(true)
      const busy = { status: 409, body: { ok: false, error: 'busy' } }
      expect(await update.blob(stream(archive), archive.length)).toEqual(busy)
      expect(await update.update({ commit: repo.b, sha256: sha(archive) })).toEqual(busy)
      expect(calls).toBe(0)
      expect(restarts).toEqual([])
      expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
      expect(readPending(pendingFile())).toEqual(record)
      // settled by a person or the guard: the node takes updates again
      rmSync(pendingFile())
      expect(update.busy()).toBe(false)
      expect((await update.blob(stream(archive), archive.length)).status).toBe(200)
    }
  })

  test('a record does not make a Linux or macOS node busy: nothing is read there', async () => {
    const archive = repo.archive(repo.b)
    for (const platform of ['linux', 'darwin']) {
      writePending(pendingFile(), { commit: repo.b, from: repo.a, root, old: '', fresh: '', phase: 'ready', at: 1 })
      const { update, restarts } = make({ ...stub, platform })
      expect(update.busy()).toBe(false)
      await update.blob(stream(archive), archive.length)
      expect((await update.update({ commit: repo.b, sha256: sha(archive) })).status).toBe(200)
      expect(restarts).toHaveLength(1)
      rmSync(pendingFile())
      rmSync(root, { recursive: true, force: true })
      rmSync(besidePlugin(root).old, { recursive: true, force: true })
      unpackedA()
    }
  })

  test('a board restarted in the middle of the apply (no commit) is not updated again over the guard', async () => {
    const { fresh, old } = besidePlugin(root)
    for (const folder of [fresh, old]) {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'marker.ts'), 'the guard reads this')
    }
    writePending(pendingFile(), { commit: repo.b, from: repo.a, root, old, fresh, phase: 'go', at: 1 })
    const { update } = make({ ...stub, platform: 'win32', guard: () => {}, commit: async () => '' })
    const archive = repo.archive(repo.b)
    expect((await update.blob(stream(archive), archive.length)).body.error).toBe('busy')
    expect((await update.update({ commit: repo.b, sha256: sha(archive) })).body.error).toBe('busy')
    expect(text(old, 'marker.ts')).toBe('the guard reads this')
    expect(text(fresh, 'marker.ts')).toBe('the guard reads this')
  })

  test('goLater writes the go after its time; a go that cannot be written is logged, never thrown', async () => {
    const record = { commit: repo.b, from: repo.a, root, old: '', fresh: '', phase: 'ready', at: 1 } as const
    writePending(pendingFile(), record)
    const logs: string[] = []
    goLater(pendingFile(), 1, t => void logs.push(t))
    await Bun.sleep(30)
    expect(readPending(pendingFile())?.phase).toBe('go')
    expect(logs).toEqual([])
    goLater(
      pendingFile(),
      1,
      t => void logs.push(t),
      () => {
        throw new Error('EPERM')
      },
    )
    await Bun.sleep(30)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('could not be written: EPERM')
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

  test('mirrorTree: a name that changes only in case ends with the new name alone, by the names the source lists', () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    put(from, 'src/foo.ts', 'x')
    put(to, 'src/Foo.ts', 'x')
    mirrorTree(from, to)
    expect(readdirSync(join(to, 'src'))).toEqual(['foo.ts'])
  })

  test.skipIf(process.platform === 'win32')('mirrorTree follows a link as a link (a privilege on Windows)', () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    put(from, 'src/foo.ts', 'x')
    mkdirSync(to)
    symlinkSync('foo.ts', join(from, 'src', 'link.ts'))
    mirrorTree(from, to)
    expect(readdirSync(join(to, 'src')).sort()).toEqual(['foo.ts', 'link.ts'])
    expect(readFileSync(join(to, 'src', 'link.ts'), 'utf8')).toBe('x')
  })

  test('mirrorTree: the last names go in after every other file, and out first when they differ; keep names stay', () => {
    const from = join(dir, 'from')
    const to = join(dir, 'to')
    put(from, '.stamp', 'new')
    put(from, 'a.ts', 'a2')
    put(from, 'src/b.ts', 'b2')
    put(to, '.stamp', 'old')
    put(to, 'a.ts', 'a1')
    put(to, 'src/b.ts', 'b1')
    put(to, '.git/HEAD', 'ref')
    const order: string[] = []
    mirrorTree(
      from,
      to,
      (file, data) => {
        order.push(file.slice(to.length + 1))
        writeFileSync(file, data)
      },
      { last: ['.stamp'], keep: ['.git'] },
    )
    expect(order.at(-1)).toBe('.stamp')
    expect(order.sort()).toEqual(['.stamp', 'a.ts', join('src', 'b.ts')])
    expect(text(to, '.git', 'HEAD')).toBe('ref')
    // a stamp that differs is gone while the other files are written
    put(from, '.stamp', 'newer')
    put(from, 'a.ts', 'a3')
    let seen = null as boolean | null
    mirrorTree(
      from,
      to,
      (file, data) => {
        if (seen === null) seen = existsSync(join(to, '.stamp'))
        writeFileSync(file, data)
      },
      { last: ['.stamp'] },
    )
    expect(seen).toBe(false)
    expect(text(to, '.stamp')).toBe('newer')
    // the same stamp is left alone
    const writes: string[] = []
    mirrorTree(from, to, f => void writes.push(f), { last: ['.stamp'] })
    expect(writes).toEqual([])
  })

  test('applyUpdate refuses a checkout and never moves its .git (#793); restorePlugin puts files back and keeps a .git', () => {
    put(root, '.git/HEAD', 'ref')
    const { fresh, old } = besidePlugin(root)
    mkdirSync(old)
    put(fresh, 'src/adapters/paths.ts', 'export const V = 2\n')
    put(fresh, '.archive-commit', 'new\n')
    expect(() => applyUpdate(fresh, root, old)).toThrow('.git')
    expect(text(root, '.git', 'HEAD')).toBe('ref')
    expect(existsSync(join(old, '.git'))).toBe(false)
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(text(root, '.archive-commit')).toBe(`${repo.a}\n`)
    // an archive install takes the new copy, stamp and all
    rmSync(join(root, '.git'), { recursive: true })
    applyUpdate(fresh, root, old)
    expect(text(root, '.archive-commit')).toBe('new\n')
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 2\n')
    // the copy before: what backupPlugin made
    put(old, 'src/adapters/paths.ts', 'export const V = 1\n')
    put(old, '.archive-commit', 'old\n')
    put(root, '.git/HEAD', 'ref')
    restorePlugin(old, root)
    expect(text(root, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
    expect(text(root, '.archive-commit')).toBe('old\n')
    // a .git in the plugin is not taken out by a restore from a copy without one
    expect(text(root, '.git', 'HEAD')).toBe('ref')
  })

  test('backupPlugin copies everything, off the event loop, and replaces an older copy', async () => {
    put(root, 'node_modules/dep/index.js', 'dep')
    const old = join(dir, 'home', 'agent-board.old')
    put(old, 'stale.ts', 'stale')
    const done = backupPlugin(root, old)
    expect(done).toBeInstanceOf(Promise)
    await done
    expect(existsSync(join(old, 'stale.ts'))).toBe(false)
    expect(text(old, 'node_modules', 'dep', 'index.js')).toBe('dep')
    expect(text(old, 'src', 'adapters', 'paths.ts')).toBe('export const V = 1\n')
  })

  test('backupPlugin keeps a copy before that holds a .git, and refuses a plugin that is a checkout (#793)', async () => {
    const old = join(dir, 'home', 'agent-board.old')
    put(old, '.git/HEAD', 'ref')
    await expect(backupPlugin(root, old)).rejects.toThrow('.git')
    expect(text(old, '.git', 'HEAD')).toBe('ref')
    rmSync(old, { recursive: true })
    put(root, '.git/HEAD', 'ref')
    await expect(backupPlugin(root, old)).rejects.toThrow('.git')
    expect(existsSync(old)).toBe(false)
    expect(text(root, '.git', 'HEAD')).toBe('ref')
  })

  test('claimPending gives the record once and leaves nothing beside it; the phase and the heartbeat', () => {
    const file = join(dir, 'state', 'pending.json')
    const p = {
      commit: repo.b,
      from: repo.a,
      root,
      old: `${root}.old`,
      fresh: `${root}.new`,
      phase: 'ready',
      at: 5,
    } as const
    expect(claimPending(file)).toBeNull()
    writePending(file, p)
    setPhase(file, 'go')
    expect(readPending(file)).toEqual({ ...p, phase: 'go' })
    expect(claimPending(file)).toEqual({ ...p, phase: 'go' })
    expect(claimPending(file)).toBeNull()
    expect(readdirSync(join(dir, 'state'))).toEqual([])
    setPhase(file, 'go')
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, 'not json')
    expect(readPending(file)).toBeNull()
    writeFileSync(file, JSON.stringify({ ...p, phase: 'nope' }))
    expect(readPending(file)).toBeNull()
    expect(aliveAt(file)).toBeNull()
    const before = Date.now()
    writeAlive(file)
    expect(aliveAt(file)).toBeGreaterThanOrEqual(before)
    removeAlive(file)
    expect(aliveAt(file)).toBeNull()
  })
})

describe('the installer, once for each commit the board starts on (#797)', () => {
  const stampFile = (): string => join(dir, 'state', 'node', 'update', 'installed.json')
  const ok = { ok: true, detail: '' }

  /** The two steps, recorded in the order they run. */
  function steps() {
    const calls: string[] = []
    const deps: Partial<NodeUpdateDeps> = {
      ...stub,
      backupSettings: () => {
        calls.push('backup')
        return ['/profiles/default.json']
      },
      installer: async () => {
        calls.push('installer')
        return ok
      },
    }
    return { calls, deps }
  }

  async function updateTo(update: ReturnType<typeof make>['update'], commit = repo.b) {
    const archive = repo.archive(commit)
    await update.blob(stream(archive), archive.length)
    return update.update({ commit, sha256: sha(archive) })
  }

  test('the first board on an update by an older board (which wrote nothing) runs it once, and says so in installed.json', async () => {
    const { calls, deps } = steps()
    // The update itself, as the old code does it: no installer wired, no file.
    expect((await updateTo(make({ ...stub }).update)).status).toBe(200)
    expect(existsSync(stampFile())).toBe(false)
    const back = make({ ...deps, commit: async () => repo.b })
    await back.update.started()
    expect(calls).toEqual(['backup', 'installer'])
    expect(JSON.parse(text(stampFile()))).toMatchObject({ commit: repo.b })
    expect(back.logs.join('\n')).toContain(`the installer ran for ${repo.b.slice(0, 12)}`)
    // Again on the same commit (a restart): nothing.
    await make({ ...deps, commit: async () => repo.b }).update.started()
    expect(calls).toEqual(['backup', 'installer'])
    // A later commit: once more.
    await make({ ...deps, commit: async () => repo.a }).update.started()
    expect(calls).toEqual(['backup', 'installer', 'backup', 'installer'])
    expect(JSON.parse(text(stampFile()))).toMatchObject({ commit: repo.a })
  })

  test('the board that hands an update over runs nothing before its restart; the one that comes back does', async () => {
    const { calls, deps } = steps()
    const first = make(deps)
    expect((await updateTo(first.update)).status).toBe(200)
    await first.update.started()
    expect(calls).toEqual([])
    await make({ ...deps, commit: async () => repo.b }).update.started()
    expect(calls).toEqual(['backup', 'installer'])
  })

  test('no installer wired: nothing read or written; no commit to name: nothing runs', async () => {
    const { update, logs } = make({ ...stub, commit: async () => repo.b })
    await update.started()
    expect(logs).toEqual([])
    expect(existsSync(stampFile())).toBe(false)
    const { calls, deps } = steps()
    await make({ ...deps, commit: async () => '' }).update.started()
    expect(calls).toEqual([])
    expect(existsSync(stampFile())).toBe(false)
  })

  test('an installer that fails or throws, a settings.json that cannot be copied: said, never thrown, tried again at the next start', async () => {
    const cases: [Partial<NodeUpdateDeps>, string, string[]][] = [
      [{ installer: async () => ({ ok: false, detail: 'boom\nmore' }) }, 'failed: boom', ['backup']],
      [
        {
          installer: async () => {
            throw new Error('spawn failed')
          },
        },
        'did not run: spawn failed',
        ['backup'],
      ],
      [
        {
          backupSettings: () => {
            throw new Error('EACCES')
          },
        },
        'settings.json not copied: EACCES',
        [],
      ],
    ]
    for (const [over, said, ran] of cases) {
      const { calls, deps } = steps()
      const back = make({ ...deps, ...over, commit: async () => repo.b })
      await back.update.started()
      expect(calls).toEqual(ran)
      expect(back.logs.join('\n')).toContain(said)
      expect(existsSync(stampFile())).toBe(false)
    }
    // A file that does not parse names no commit: the installer runs.
    const { calls, deps } = steps()
    mkdirSync(join(dir, 'state', 'node', 'update'), { recursive: true })
    writeFileSync(stampFile(), '{ not json')
    await make({ ...deps, commit: async () => repo.b }).update.started()
    expect(calls).toEqual(['backup', 'installer'])
  })

  test('on Windows the installer runs only once the record is settled: claimed as applied, or gone', async () => {
    const { calls, deps } = steps()
    const guard = (file: string): void => writeAlive(file)
    expect((await updateTo(make({ ...deps, platform: 'win32', guard, go: () => {} }).update)).status).toBe(200)
    const { fresh, old } = besidePlugin(root)
    const record = { commit: repo.b, from: repo.a, root, old, fresh, at: 1 }
    const back = (over: Partial<NodeUpdateDeps> = {}, commit = repo.b) =>
      make({ ...deps, platform: 'win32', guard, commit: async () => commit, ...over })
    for (const phase of ['ready', 'go', 'restoring'] as const) {
      writePending(pendingFile(), { ...record, phase })
      await back().update.started()
      expect(calls).toEqual([])
      expect(readPending(pendingFile())?.phase).toBe(phase)
    }
    writePending(pendingFile(), { ...record, phase: 'applied' })
    await back({}, repo.a).update.started()
    expect(calls).toEqual([])
    writeFileSync(pendingFile(), 'not json')
    await back().update.started()
    expect(calls).toEqual([])
    writePending(pendingFile(), { ...record, phase: 'applied' })
    const seen: boolean[] = []
    const settled = back({
      installer: async () => {
        seen.push(existsSync(pendingFile()))
        calls.push('installer')
        return ok
      },
    })
    await settled.update.started()
    expect(seen).toEqual([false])
    expect(calls).toEqual(['backup', 'installer'])
    expect(settled.logs.join('\n')).toContain(`back on ${repo.b.slice(0, 12)}`)
    // No record at all: the stamp alone decides.
    await back().update.started()
    expect(calls).toEqual(['backup', 'installer'])
  })
})
