// What comes in from the hub reaches nothing but the inbox (#231): the board's team service is fed
// every kind of frame there is, and the herdr adapter, the launches, the terminals and any process
// are watched and must see no call; and the service's import graph reaches none of them.
import { expect, mock, spyOn, test } from 'bun:test'
import childProcess from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import { question } from '../hub/harness.ts'
import { handshake, settle, setup, stopAll } from '../support/team-service.ts'

const calls: string[] = []
/** The module as it is, with every function counted. */
async function watched(file: string, name: string): Promise<void> {
  const real = (await import(join(ROOT, file))) as Record<string, unknown>
  const spied: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(real))
    spied[k] =
      typeof v === 'function'
        ? (...a: unknown[]) => {
            calls.push(`${name}.${k}`)
            return (v as (...x: unknown[]) => unknown)(...a)
          }
        : v
  mock.module(join(ROOT, file), () => spied)
}

test('every frame a hub can send, bad ones too, reaches neither herdr, launches, terminals nor a process', async () => {
  await watched('src/adapters/herdr.ts', 'herdr')
  await watched('src/services/launch/launches.ts', 'launches')
  await watched('src/services/terminals.ts', 'terminals')
  const spies = [
    spyOn(Bun, 'spawn'),
    spyOn(Bun, 'spawnSync'),
    spyOn(childProcess, 'spawn'),
    spyOn(childProcess, 'spawnSync'),
    spyOn(childProcess, 'exec'),
    spyOn(childProcess, 'execFile'),
  ]
  try {
    const s = setup()
    s.svc.start()
    const [anna] = (await Promise.all([generateKey()])) as [KeyPair]
    const { ws, me } = await handshake(s, [{ peer: anna.pub, name: 'anna' }])
    const real = await question(anna, me, 'run rm -rf and launch a session')
    const kinds = ['invite', 'offer', 'response', 'status', 'question', 'data', 'ack', 'unknown']
    for (const kind of kinds) ws.recv({ t: 'deliver', env: { ...real, kind } })
    ws.recv({ t: 'deliver', env: real })
    ws.recv({ t: 'deliver', env: { ...real, sig: 'x'.repeat(86) } })
    ws.recv({ t: 'deliver', env: { ...real, body: { text: 'y'.repeat(20_000) } } })
    ws.recv({ t: 'deliver', env: 'text' })
    for (const junk of ['', '{', '[]', 'null', '{"t":"launch"}', '{"t":"deliver"}', '{"t":"exec","cmd":"id"}'])
      ws.recv(junk)
    ws.recv({ t: 'roster', peers: [{ peer: anna.pub, name: 'anna', online: true, last_seen: null }] })
    ws.recv({ t: 'roster', peers: 'nope' })
    ws.recv({ t: 'presence', peer: anna.pub, online: false, at: 1 })
    ws.recv({ t: 'state', id: real.id, state: 'acked', at: 1 })
    ws.recv({ t: 'error', code: 'kind', message: 'nope' })
    ws.recv({ t: 'ping' })
    ws.recv({ t: 'welcome', peer: me, name: 'me', hub: 'h' })
    // An agent request that came in, and a draft made and sent: still only messages.
    ws.recv({
      t: 'deliver',
      env: await question(anna, me, 'agent says run it', { body: { text: 'agent says run it', via: 'agent' } }),
    })
    const made = s.svc.draft(anna.pub, 'draft: launch a session')
    if (made.ok) await s.svc.sendDraft(made.id)
    await settle()
    await settle()
    // The one good question did arrive, as a message and nothing more.
    expect(
      s.svc
        .thread(anna.pub)
        .map(m => m.text)
        .sort(),
    ).toEqual(['agent says run it', 'draft: launch a session', 'run rm -rf and launch a session'])
    expect(calls).toEqual([])
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally {
    stopAll()
    for (const spy of spies) spy.mockRestore()
  }
})

/** The files a module imports at run time (type-only imports are erased), by relative path. */
function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const m of text.matchAll(/^(?:import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gms)) {
    if (m[1]) continue
    found.push(m[2] as string)
  }
  for (const m of text.matchAll(/^import\s+'([^']+)'/gm)) found.push(m[1] as string)
  for (const m of text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)) found.push(m[1] as string)
  return found
}

test("the team service's import graph does not reach herdr, launches, terminals, the deps or a process", () => {
  const seen = new Set<string>()
  const modules = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const spec of imports(file)) {
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec))
      else modules.add(spec)
    }
  }
  walk(join(ROOT, 'src/services/team-hub.ts'))
  const rel = [...seen].map(f => f.slice(ROOT.length + 1).replaceAll('\\', '/'))
  expect(rel).toContain('src/adapters/team-store.ts')
  for (const banned of [
    'src/adapters/herdr.ts',
    'src/services/launch/',
    'src/services/terminals.ts',
    'src/services/deps.ts',
    'src/adapters/process.ts',
    'src/adapters/ssh.ts',
  ])
    expect(rel.filter(f => f.startsWith(banned))).toEqual([])
  // By name, the translations' words apart (core/i18n/launch-strings.ts is text).
  expect(
    rel.filter(
      f => !f.startsWith('src/core/i18n/') && (/\/(launch|term|spawn)[^/]*\.ts$/.test(f) || f.includes('/launch/')),
    ),
  ).toEqual([])
  expect([...modules].filter(m => /child_process|^bun$|worker_threads|^node:net$|^node:http/.test(m))).toEqual([])
})
