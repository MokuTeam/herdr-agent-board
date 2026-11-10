// `board team join|roster` (#231, entrypoints/cli.ts), run as an agent runs them in a sandbox. Join
// goes to a hub in this process (test/hub/harness.ts); roster asks a running board. With `team` off
// the command says so and writes nothing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fingerprint, generateKey } from '../../src/core/team.ts'
import { type Harness, startHarness } from '../hub/harness.ts'
import { serveBoard } from '../support/board-server.ts'
import { type ChildResult, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const teamFiles = (box: Sandbox): string[] =>
  existsSync(stateOf(box)) ? readdirSync(stateOf(box)).filter(f => f.startsWith('team-')) : []
const writeConfig = (box: Sandbox, value: Record<string, unknown>): void => {
  mkdirSync(dirname(configPath(box)), { recursive: true })
  writeFileSync(configPath(box), JSON.stringify({ language: 'en', wakeUrl: '', port: 9, ...value }, null, 2))
}
const configOf = (box: Sandbox): Record<string, unknown> => JSON.parse(readFileSync(configPath(box), 'utf8'))
const board = (box: Sandbox, args: string[]): Promise<ChildResult> => box.run('cli', { args, env: {} }).exited

describe('board team, off and misused', () => {
  test('roster with no team: says so, writes no team file and leaves config.json as it was', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const before = readFileSync(configPath(box), 'utf8')
    const r = await board(box, ['team', 'roster'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^team is off \(no "team" in config\.json;/)
    expect(teamFiles(box)).toEqual([])
    expect(readFileSync(configPath(box), 'utf8')).toBe(before)
  })

  test('draft with no team: says so, writes no team file and leaves config.json as it was', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const before = readFileSync(configPath(box), 'utf8')
    const r = await board(box, ['team', 'draft', 'Roman', 'is it green?'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^team is off \(no "team" in config\.json;/)
    expect(teamFiles(box)).toEqual([])
    expect(readFileSync(configPath(box), 'utf8')).toBe(before)
  })

  test('draft with team on and no board running says to open it; nothing is written', async () => {
    const box = await sandbox()
    writeConfig(box, { team: { hub: 'ws://127.0.0.1:9', name: 'anna' } })
    const r = await board(box, ['team', 'draft', 'Roman', 'hi'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('the board does not run: open it first')
    expect(teamFiles(box)).toEqual([])
  })

  test.each([
    ['draft without a text', ['team', 'draft', 'Roman']],
    ['draft without anything', ['team', 'draft']],
    ['draft with a third word', ['team', 'draft', 'Roman', 'is it', 'green?']],
  ])('%s: the usage line, which lists team draft, a non-zero exit', async (_n, args) => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, args)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('board team draft <name|peer-id> "<text>"')
    expect(teamFiles(box)).toEqual([])
  })

  test('board help lists team draft', async () => {
    const box = await sandbox()
    const r = await board(box, ['help'])
    expect(r.stdout).toContain('team draft <name|peer-id> "<text>"')
  })

  test.each([
    ['no subcommand', ['team']],
    ['an unknown one', ['team', 'bogus']],
    ['roster with an argument', ['team', 'roster', 'x']],
    ['join without an invite', ['team', 'join', '--hub', 'ws://127.0.0.1:9', '--name', 'anna']],
    ['join without a hub', ['team', 'join', 'hab-x', '--name', 'anna']],
    ['join without a name', ['team', 'join', 'hab-x', '--hub', 'ws://127.0.0.1:9']],
    ['join with a hub that is no ws url', ['team', 'join', 'hab-x', '--hub', 'http://127.0.0.1:9', '--name', 'anna']],
    [
      'join with a name that is too long',
      ['team', 'join', 'hab-x', '--hub', 'ws://127.0.0.1:9', '--name', 'n'.repeat(41)],
    ],
    ['join with a name holding a newline', ['team', 'join', 'hab-x', '--hub', 'ws://127.0.0.1:9', '--name', 'an\nna']],
    [
      'join with a name holding a right-to-left override',
      ['team', 'join', 'hab-x', '--hub', 'ws://127.0.0.1:9', '--name', 'an\u202ena'],
    ],
    ['join with two invites', ['team', 'join', 'hab-x', 'hab-y', '--hub', 'ws://127.0.0.1:9', '--name', 'anna']],
  ])('%s: a usage line, a non-zero exit, nothing written', async (_n, args) => {
    const box = await sandbox()
    writeConfig(box, {})
    const before = readFileSync(configPath(box), 'utf8')
    const r = await board(box, args)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('usage: board team join <invite> --hub <ws://host:7443> --name <name>')
    expect(teamFiles(box)).toEqual([])
    expect(readFileSync(configPath(box), 'utf8')).toBe(before)
  })

  test('roster with team on and no board running says to open it', async () => {
    const box = await sandbox()
    writeConfig(box, { team: { hub: 'ws://127.0.0.1:9', name: 'anna' } })
    const r = await board(box, ['team', 'roster'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('the board does not run: open it first')
    expect(teamFiles(box)).toEqual([])
  })

  test('a hub that cannot be reached: non-zero, nothing written', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, ['team', 'join', 'hab-x', '--hub', 'ws://127.0.0.1:9', '--name', 'anna'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/cannot reach the hub|closed the connection/)
    expect(teamFiles(box)).toEqual([])
    expect(configOf(box)).not.toHaveProperty('team')
  })
})

describe('board team against a hub', () => {
  let hub: Harness
  let base = ''
  beforeAll(async () => {
    hub = await startHarness()
    base = hub.url.replace(/\/v1$/, '')
  })
  afterAll(() => hub.stop())

  test('join with a good invite writes `team` and a 0600 key the hub knows; --name is read although fork strips it', async () => {
    const box = await sandbox()
    writeConfig(box, { language: 'en' })
    const r = await board(box, ['team', 'join', hub.invite(), '--hub', `${base}/`, '--name', 'anna'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^ok · joined ws:\/\/127\.0\.0\.1:\d+ as anna · your key (\w{4} ){7}\w{4} /)
    expect(configOf(box)).toMatchObject({ language: 'en', team: { hub: base, name: 'anna' } })
    const key = JSON.parse(readFileSync(join(stateOf(box), 'team-key.json'), 'utf8')) as { pkcs8: string; pub: string }
    expect(r.stdout).toContain(fingerprint(key.pub))
    if (process.platform !== 'win32') expect(statSync(join(stateOf(box), 'team-key.json')).mode & 0o777).toBe(0o600)
    // The hub knows that key: it logs in with it.
    await hub.login(key)
  })

  test('join with --hub ending in /v1 reaches the hub and saves the address without it', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, ['team', 'join', hub.invite(), '--hub', `${base}/v1`, '--name', 'vone'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(configOf(box)).toMatchObject({ team: { hub: base, name: 'vone' } })
  })

  test('join with a bad, used or expired invite: non-zero, no team in config.json, no key kept', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const bad = await board(box, ['team', 'join', 'hab-nope', '--hub', base, '--name', 'bob'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toMatch(/^board: the hub/)
    const used = hub.invite()
    await hub.join(await generateKey(), 'carol', used)
    const again = await board(box, ['team', 'join', used, '--hub', base, '--name', 'dave'])
    expect(again.code).toBe(1)
    const taken = await board(box, ['team', 'join', hub.invite(), '--hub', base, '--name', 'carol'])
    expect(taken.code).toBe(1)
    expect(taken.stderr).toContain('name_taken')
    expect(configOf(box)).not.toHaveProperty('team')
    expect(teamFiles(box)).toEqual([])
  })

  test('roster of a running board: the peers, online or when last seen, a changed key flagged', async () => {
    const box = await sandbox()
    const me = await generateKey()
    const peer = await generateKey()
    ;(await hub.join(me, 'rosterme')).close()
    const peerClient = await hub.join(peer, 'rosterpeer')
    mkdirSync(stateOf(box), { recursive: true })
    writeFileSync(join(stateOf(box), 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
    const team = { hub: base, name: 'rosterme' }
    const { url } = await serveBoard(box, { language: 'en', team })
    writeConfig(box, { port: Number(new URL(url).port), team })
    const end = Date.now() + 8000
    let out: ChildResult
    do {
      out = await board(box, ['team', 'roster'])
      if (out.stdout.includes('rosterpeer')) break
      await Bun.sleep(100)
    } while (Date.now() < end)
    const lines = out.stdout.trim().split('\n')
    const head = lines[0]
    const line = lines.find(l => l.includes('rosterpeer'))
    expect(head).toBe(`${base} · online · you: rosterme ${fingerprint(me.pub)}`)
    expect(line).toBe(`● rosterpeer  ${fingerprint(peer.pub)}  online`)
    peerClient.close()
    await Bun.sleep(300)
    out = await board(box, ['team', 'roster'])
    expect(out.stdout.split('\n').find(l => l.includes('rosterpeer'))).toMatch(
      new RegExp(`^○ rosterpeer  ${fingerprint(peer.pub)}  (last seen .+ ago|not seen yet)$`),
    )
  })
  test('draft: resolves a name (exact, then any case) or a peer id against the roster, leaves a draft, sends nothing', async () => {
    const box = await sandbox()
    const me = await generateKey()
    const roman = await generateKey()
    const twin1 = await generateKey()
    const twin2 = await generateKey()
    ;(await hub.join(me, 'draftme')).close()
    const romanClient = await hub.join(roman, 'Roman')
    await hub.join(twin1, 'Twin')
    await hub.join(twin2, 'twin')
    mkdirSync(stateOf(box), { recursive: true })
    writeFileSync(join(stateOf(box), 'team-key.json'), JSON.stringify({ v: 1, ...me }), { mode: 0o600 })
    const team = { hub: base, name: 'draftme' }
    const { url } = await serveBoard(box, { language: 'en', team })
    writeConfig(box, { port: Number(new URL(url).port), team })
    const end = Date.now() + 8000
    let r: ChildResult
    do {
      r = await board(box, ['team', 'draft', 'roman', 'is the build green?'])
      if (r.code === 0) break
      await Bun.sleep(100)
    } while (Date.now() < end)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('draft for Roman is in the Team panel; nothing is sent until a person presses Send')
    const byId = await board(box, ['team', 'draft', roman.pub, 'second one'])
    expect(byId.code).toBe(0)
    const thread = (await (await fetch(`${url}/api/team/thread/${roman.pub}`)).json()) as {
      messages: { dir: string; text: string }[]
    }
    expect(thread.messages.map(m => [m.dir, m.text])).toEqual([
      ['draft', 'is the build green?'],
      ['draft', 'second one'],
    ])
    expect(existsSync(join(stateOf(box), 'team-drafts.json'))).toBe(true)
    // Nothing was sent: the peer got no frame.
    await Bun.sleep(200)
    expect(romanClient.frames.filter(f => f.t === 'deliver')).toEqual([])
    // Unknown name: lists the names. A name two people fit (exactly one each): exact wins; any-case two: ambiguous.
    const unknown = await board(box, ['team', 'draft', 'Zed', 'hi'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('nobody called Zed on the team. On it:')
    expect(unknown.stderr).toContain('Roman')
    const exact = await board(box, ['team', 'draft', 'Twin', 'hi'])
    expect(exact.code).toBe(0)
    const ambiguous = await board(box, ['team', 'draft', 'TWIN', 'hi'])
    expect(ambiguous.code).toBe(1)
    expect(ambiguous.stderr).toContain('fits more than one person (')
    expect(ambiguous.stderr).toContain('Twin')
    const empty = await board(box, ['team', 'draft', 'Roman', '   '])
    expect(empty.code).toBe(1)
    expect(empty.stderr).toContain('no draft made: the text is empty or longer than 4000 characters')
  })
})
