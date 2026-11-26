// The pieces of the placer that need no board (#504): the thresholds written once from a device's
// first status, the system folders a brief may name and still leave, "Where" in a launch request
// (read only while the board places), and the queue's file.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeQueue, QUEUE_MAX, type QueueEntry } from '../../src/adapters/node-queue.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { defaultThresholds, fillThresholds } from '../../src/core/nodes.ts'
import { everyMachineHas, portable } from '../../src/core/portable.ts'
import { defaultProfileDir, mergeProfiles, profileSet } from '../../src/core/profiles.ts'
import { checkRequest } from '../../src/services/launch/request.ts'

// biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
useLanguage('en')

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'placer-facts-'))
  scratch.push(dir)
  return dir
}

test('the thresholds a device lacks are written from its first status; what the owner typed stays', () => {
  // The lead's real node: 7.9 GB, 4 cores.
  const small = defaultThresholds({ memTotalMb: 7900, cpus: 4 })
  expect(small).toEqual({ maxSessions: 4, minFreeMemMb: 1185, maxLoad: 0.9 })
  const nodes: Record<string, unknown> = {
    devices: { 'server-1': { link: { kind: 'direct', url: 'https://x' }, maxSessions: 2, maxLoad: null } },
  }
  expect(fillThresholds(nodes, 'server-1', small)).toBe(true)
  expect((nodes.devices as Record<string, unknown>)['server-1']).toEqual({
    link: { kind: 'direct', url: 'https://x' },
    maxSessions: 2,
    maxLoad: null,
    minFreeMemMb: 1185,
  })
  // Once there, nothing more to write.
  expect(fillThresholds(nodes, 'server-1', small)).toBe(false)
  // A device config.json does not have is not added; this computer is.
  expect(fillThresholds(nodes, 'server-9', small)).toBe(false)
  expect(fillThresholds(nodes, 'local', small)).toBe(true)
  expect((nodes.devices as Record<string, unknown>).local).toEqual(small)
  const bare: Record<string, unknown> = {}
  expect(fillThresholds(bare, 'local', small)).toBe(true)
  expect(bare).toEqual({ devices: { local: small } })
  expect(fillThresholds({ devices: 'x' }, 'local', small)).toBe(false)
})

test('a brief that names a system folder every machine has may still leave; one naming a file of here may not', () => {
  for (const p of [
    '/usr/bin/env',
    '/bin',
    '/etc/hosts',
    '/dev/null',
    '/proc/self',
    'C:\\Windows\\System32',
    'c:/program files/git',
  ])
    expect([p, everyMachineHas(p)]).toEqual([p, true])
  // /tmp is on every machine, but a file in it (an agent's scratchpad) is this computer's.
  for (const p of [
    '/usrx',
    '/tmp/claude-1000/plan.md',
    '/home/me/brief.md',
    '/var/tmp',
    'C:\\Users\\me\\brief.md',
    'D:\\Windows',
    '\\\\host\\usr',
  ])
    expect([p, everyMachineHas(p)]).toEqual([p, false])
  const facts = (brief: string) => ({
    lane: 'atlas',
    lanes: 'all' as const,
    checkout: { remote: 'https://github.com/a/b', clean: true, headPushed: true },
    worktree: null,
    brief,
    // As the placer asks: a system folder is no file of this computer's, whatever is on its disk.
    exists: (p: string) => !everyMachineHas(p),
  })
  expect(portable(facts('Run /usr/bin/env node x.js'))).toEqual({ ok: true })
  expect(portable(facts('Read /home/me/brief.md'))).toEqual({
    ok: false,
    why: { kind: 'local-path', path: '/home/me/brief.md' },
  })
})

test('"Where" is read only while the board places; a folder this computer lacks is then the pinned node’s', async () => {
  const dir = tmp()
  const home = join(dir, 'home')
  const profiles = profileSet(mergeProfiles([], [], home).list, defaultProfileDir(home))
  const body = { name: 'A', cwd: dir, workspace: { id: 'w2' } }
  // Without nodes: a pin is not looked at, the request is what it was.
  const off = await checkRequest({ ...body, pin: { nonsense: 1 } }, { profiles })
  expect(off.ok && Object.keys(off.launch).includes('pin')).toBe(false)
  const gone = await checkRequest({ ...body, cwd: '/srv/node/atlas', pin: { device: 'server-1' } }, { profiles })
  expect(gone.ok).toBe(false)
  expect(!gone.ok && gone.field).toBe('cwd')
  // With nodes: a device (or local) or a tag, one of them.
  const on = { profiles, pins: true }
  const pinOf = async (pin: unknown) => {
    const r = await checkRequest({ ...body, pin }, on)
    return r.ok ? r.launch.pin : r.field
  }
  expect(await pinOf({ device: 'server-1' })).toEqual({ device: 'server-1' })
  expect(await pinOf({ device: 'local' })).toEqual({ device: 'local' })
  expect(await pinOf({ tag: 'linux' })).toEqual({ tag: 'linux' })
  expect(await pinOf(null)).toBeUndefined()
  for (const bad of [
    { device: 'Server 1' },
    { device: '@x:y' },
    { tag: '-x' },
    { device: 'a', tag: 'b' },
    'server-1',
    {},
  ])
    expect([bad, await pinOf(bad)]).toEqual([bad, 'pin'])
  const r = await checkRequest({ ...body, cwd: '/srv/node/atlas', pin: { device: 'server-1' } }, on)
  expect(r.ok && [r.launch.cwd, r.launch.remote]).toEqual(['/srv/node/atlas', 'server-1'])
  // Pinned here, or to a tag: the folder must be this computer's as always.
  for (const pin of [{ device: 'local' }, { tag: 'linux' }]) {
    const here = await checkRequest({ ...body, cwd: join(dir, 'missing'), pin }, on)
    expect(!here.ok && here.field).toBe('cwd')
  }
  // A folder this computer has is its own, pinned or not.
  const own = await checkRequest({ ...body, pin: { device: 'server-1' } }, on)
  expect(own.ok && own.launch.remote).toBeUndefined()
})

test('a Windows node’s folder pinned to that node is the node’s on any master; pinned elsewhere it is refused (#891)', async () => {
  const dir = tmp()
  const home = join(dir, 'home')
  const profiles = profileSet(mergeProfiles([], [], home).list, defaultProfileDir(home))
  const on = { profiles, pins: true }
  const body = { name: 'A', workspace: { id: 'w2' } }
  for (const cwd of ['C:\\Users\\Анна Мария\\Board 100%', 'C:/Users/x/Board-Smoke', '\\\\nas\\share\\proj']) {
    const r = await checkRequest({ ...body, cwd, pin: { device: 'win-laptop' } }, on)
    expect([cwd, r.ok && [r.launch.cwd, r.launch.remote]]).toEqual([cwd, [cwd, 'win-laptop']])
    // Pinned here, to a tag, or not at all, or with nodes off: this computer's folder, which it lacks.
    for (const [pin, opts] of [
      [{ device: 'local' }, on],
      [{ tag: 'windows' }, on],
      [undefined, on],
      [{ device: 'win-laptop' }, { profiles }],
    ] as const) {
      const here = await checkRequest({ ...body, cwd, pin }, opts)
      expect([cwd, pin, !here.ok && here.field]).toEqual([cwd, pin, 'cwd'])
    }
  }
  // A relative folder is not a node's absolute one: refused as before.
  const rel = await checkRequest({ ...body, cwd: 'Projects\\x', pin: { device: 'win-laptop' } }, on)
  expect(!rel.ok && rel.field).toBe('cwd')
})

test('the queue keeps 50 starts, each its master’s; another master’s entries are left as they are', () => {
  const dir = tmp()
  const file = join(dir, 'nodes', 'queue.json')
  const q = createNodeQueue({ file })
  const entry = (id: string, master = 'laptop'): QueueEntry => ({
    id,
    session: `5d0c6a1e-1111-4222-8333-${id.padStart(12, '0')}`,
    master,
    at: 1,
    request: { name: id, cwd: dir },
    task: { lane: 'atlas', profile: 'default', agent: 'claude', origin: 'local', portable: { ok: true }, byHand: true },
    source: null,
  })
  mkdirSync(join(dir, 'nodes'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 1, entries: [entry('a', 'desktop')] }))
  // Another master's entry does not count against this one's 50.
  for (let i = 1; i <= QUEUE_MAX; i++) expect(q.put(entry(String(i)))).toBe(true)
  expect(q.put(entry('51'))).toBe(false)
  expect(q.read('laptop').length).toBe(QUEUE_MAX)
  expect(q.read('desktop').map(e => e.id)).toEqual(['a'])
  // Put again: replaced, not added.
  expect(q.put({ ...entry('1'), at: 2 })).toBe(true)
  expect(q.read('laptop').find(e => e.id === '1')?.at).toBe(2)
  // Optional in-flight markers (#588) round-trip, do not count toward QUEUE_MAX, and are checked when present.
  expect(q.put({ ...entry('501'), syncing: 'server-1' })).toBe(true)
  expect(q.put({ ...entry('502'), sent: 'server-1', sentAt: 1234 })).toBe(true)
  expect(q.read('laptop').find(e => e.id === '501')?.syncing).toBe('server-1')
  expect(q.read('laptop').find(e => e.id === '502')?.sent).toBe('server-1')
  expect(q.read('laptop').find(e => e.id === '502')?.sentAt).toBe(1234)
  // 50 waiting entries already: another waiting one is refused, while in-flight ones still fit.
  expect(q.put(entry('52'))).toBe(false)
  expect(q.put({ ...entry('503'), sent: 'server-2', sentAt: 5678 })).toBe(true)
  q.remove('501')
  q.remove('502')
  q.remove('503')
  q.remove('1')
  q.remove('nope')
  expect(q.read('laptop').some(e => e.id === '1')).toBe(false)
  expect((JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] }).entries.length).toBe(QUEUE_MAX)
  // An entry without a session id of the board's shape, or with invalid in-flight markers, is not one.
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        { ...entry('y'), session: '' },
        { ...entry('z1'), syncing: '' },
        { ...entry('z2'), sent: 42 },
        { ...entry('z3'), sent: 'server-1', sentAt: 'bad' },
      ],
    }),
  )
  expect(q.read('laptop')).toEqual([])
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  // A file that is not the queue's is read as empty, and not taken for one.
  writeFileSync(file, '[1,2]')
  expect(q.read('laptop')).toEqual([])
})
