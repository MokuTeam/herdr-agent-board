// The secrets a node takes from its master's sync (services/node/secrets.ts, #604), through the file
// sink's own writer into folders of the test's own: the env file keeps the lines a sink the owner
// filled by hand wrote, a value that did not change is not written again, a name or file the master
// no longer sends is taken out and one given by hand under another name stays, a file of the
// node's own is kept and said, and no value is in an answer, a log line, the audit or the record.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSink } from '../../src/adapters/secret-sinks.ts'
import { parseEnvFile } from '../../src/core/node-env.ts'
import type { Profile } from '../../src/core/profiles.ts'
import { createNodeSecrets } from '../../src/services/node/secrets.ts'

const CANARY = 'canary-node-secrets-5a1f'

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'node-secrets-'))
  const state = join(root, 'state', 'node')
  const profile = join(root, 'home', '.claude')
  mkdirSync(profile, { recursive: true })
  const profiles: Profile[] = [{ id: 'default', title: 'Default', dir: profile, color: 'gray', hidden: false }]
  const audit: Record<string, unknown>[] = []
  const logs: string[] = []
  let writes = 0
  const secrets = createNodeSecrets({
    dir: state,
    profiles: () => profiles,
    write: input => {
      writes++
      return writeSink(input)
    },
    audit: line => audit.push(line),
    log: text => logs.push(text),
  })
  const envFile = join(state, 'env', 'default.env')
  return {
    root,
    state,
    profile,
    secrets,
    audit,
    logs,
    envFile,
    writes: () => writes,
    env: (): Record<string, string> => parseEnvFile(readFileSync(envFile, 'utf8')).vars,
    give: (body: unknown) => secrets.give('default', body),
  }
}

describe('a node takes the secrets of a sync (#604)', () => {
  test('the variables into the env file, a hand-given line kept, a file into its place; names in the answer', async () => {
    const r = rig()
    mkdirSync(join(r.state, 'env'), { recursive: true })
    // What the owner's own sink wrote before: another name, and the same name.
    writeFileSync(r.envFile, `HAND_GIVEN=keep-me\nMCP_MEMPALACE_AUTHORIZATION='Bearer old'\n`)
    const res = await r.give({
      env: { MCP_MEMPALACE_AUTHORIZATION: `Bearer ${CANARY}`, GITHUB_TOKEN: `${CANARY}-gh` },
      files: [{ path: 'mempalace-memory/config.json', text: JSON.stringify({ token: CANARY }) }],
    })
    expect(res.status).toBe(200)
    expect(r.env()).toEqual({
      HAND_GIVEN: 'keep-me',
      MCP_MEMPALACE_AUTHORIZATION: `Bearer ${CANARY}`,
      GITHUB_TOKEN: `${CANARY}-gh`,
    })
    expect(JSON.parse(readFileSync(join(r.profile, 'mempalace-memory', 'config.json'), 'utf8'))).toEqual({
      token: CANARY,
    })
    if (process.platform !== 'win32') {
      expect(statSync(r.envFile).mode & 0o777).toBe(0o600)
      expect(statSync(join(r.profile, 'mempalace-memory', 'config.json')).mode & 0o777).toBe(0o600)
    }
    expect(res.body).toEqual({
      ok: true,
      env: ['GITHUB_TOKEN', 'MCP_MEMPALACE_AUTHORIZATION'],
      written: ['GITHUB_TOKEN', 'MCP_MEMPALACE_AUTHORIZATION'],
      removed: [],
      files: ['mempalace-memory/config.json'],
      filesWritten: ['mempalace-memory/config.json'],
      filesRemoved: [],
      kept: [],
      refused: [],
    })
    expect(r.audit).toEqual([
      {
        op: 'bundle-given',
        profile: 'default',
        names: ['GITHUB_TOKEN', 'MCP_MEMPALACE_AUTHORIZATION'],
        removed: [],
        files: ['mempalace-memory/config.json'],
        filesRemoved: [],
      },
    ])
    const record = readFileSync(join(r.state, 'bundle-secrets', 'default.json'), 'utf8')
    for (const said of [JSON.stringify(res.body), JSON.stringify(r.audit), r.logs.join('\n'), record])
      expect(said).not.toContain(CANARY)
  })

  test('the same again: nothing written, no audit line', async () => {
    const r = rig()
    const body = { env: { API_TOKEN: CANARY }, files: [{ path: 'mem/config.json', text: `{"token":"${CANARY}"}` }] }
    await r.give(body)
    const writes = r.writes()
    const mtime = statSync(r.envFile).mtimeMs
    const again = await r.give(body)
    expect([again.status, again.body.written, again.body.filesWritten]).toEqual([200, [], []])
    expect(r.writes()).toBe(writes)
    expect(statSync(r.envFile).mtimeMs).toBe(mtime)
    expect(r.audit.length).toBe(1)
  })

  test('one the master no longer sends is taken out; one given by hand under another name stays', async () => {
    const r = rig()
    await r.give({ env: { A_TOKEN: 'a', B_TOKEN: 'b' }, files: [{ path: 'mem/config.json', text: '{"token":"x"}' }] })
    writeFileSync(r.envFile, `${readFileSync(r.envFile, 'utf8')}HAND_GIVEN=keep-me\n`)
    const res = await r.give({ env: { A_TOKEN: 'a' }, files: [] })
    expect(r.env()).toEqual({ A_TOKEN: 'a', HAND_GIVEN: 'keep-me' })
    expect([res.body.removed, res.body.filesRemoved]).toEqual([['B_TOKEN'], ['mem/config.json']])
    expect(() => statSync(join(r.profile, 'mem', 'config.json'))).toThrow()
  })

  test("a file of the node's own that differs is kept and said; one that is the same becomes the bundle's", async () => {
    const r = rig()
    mkdirSync(join(r.profile, 'mem'), { recursive: true })
    writeFileSync(join(r.profile, 'mem', 'config.json'), '{"token":"given by hand"}')
    writeFileSync(join(r.profile, 'mem', 'same.json'), '{"token":"same"}')
    const res = await r.give({
      env: {},
      files: [
        { path: 'mem/config.json', text: '{"token":"the master has this"}' },
        { path: 'mem/same.json', text: '{"token":"same"}' },
      ],
    })
    expect(res.body.kept).toEqual([{ path: 'mem/config.json', why: 'not-owned' }])
    expect(res.body.files).toEqual(['mem/same.json'])
    expect(readFileSync(join(r.profile, 'mem', 'config.json'), 'utf8')).toBe('{"token":"given by hand"}')
  })

  test('refused by name: one the board sets itself, a line break, a path out of the folder, no data file', async () => {
    const r = rig()
    const res = await r.give({
      env: { PATH: '/evil', HERDR_PANE_ID: 'x', 'BAD NAME': 'x', TWO_LINES: 'a\nb', OK_TOKEN: 'fine' },
      files: [
        { path: '../escape.json', text: '{}' },
        { path: 'mem/run.py', text: 'print(1)' },
        { path: '.credentials.json', text: '{}' },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body.refused).toEqual([
      'PATH',
      'HERDR_PANE_ID',
      'BAD NAME',
      'TWO_LINES',
      '../escape.json',
      'mem/run.py',
      '.credentials.json',
    ])
    expect(r.env()).toEqual({ OK_TOKEN: 'fine' })
  })

  test('a profile the node does not have: 404, nothing written', async () => {
    const r = rig()
    expect((await r.secrets.give('work', { env: { A_TOKEN: 'a' } })).status).toBe(404)
    expect(r.writes()).toBe(0)
  })

  test("a file the bundle gave and a sink changed here since (a JSON sink with 'at'): neither overwritten nor removed", async () => {
    const r = rig()
    await r.give({ env: {}, files: [{ path: 'mem/config.json', text: '{"token":"m","other":"o"}' }] })
    // The owner's own sink fills a key of that file on the node.
    const filled = await writeSink({
      sink: {
        id: 'mempalace-hooks',
        kind: 'file',
        title: 'hooks',
        params: {},
        fields: ['extra'],
        raw: null,
        once: [],
        problems: [],
        folder: join(r.profile, 'mem'),
        name: 'config.json',
        format: 'json',
        template: '{{extra}}',
        at: ['extra'],
      },
      params: {},
      fields: [{ name: 'extra', hidden: true }],
      values: { extra: 'node-value' },
    })
    expect(filled.ok).toBe(true)
    const again = await r.give({ env: {}, files: [{ path: 'mem/config.json', text: '{"token":"m","other":"o"}' }] })
    expect([again.body.filesWritten, again.body.kept]).toEqual([[], [{ path: 'mem/config.json', why: 'changed' }]])
    expect(JSON.parse(readFileSync(join(r.profile, 'mem', 'config.json'), 'utf8')).extra).toBe('node-value')
    // The master drops it: changed here, so it stays.
    const dropped = await r.give({ env: {}, files: [] })
    expect(dropped.body.filesRemoved).toEqual([])
    expect(JSON.parse(readFileSync(join(r.profile, 'mem', 'config.json'), 'utf8')).extra).toBe('node-value')
  })

  test('one the master named and could not send this time, and a name it sent and the node now refuses, stay', async () => {
    const r = rig()
    await r.give({ env: { A_TOKEN: 'a' }, files: [{ path: 'mem/config.json', text: '{"token":"x"}' }] })
    const res = await r.give({ env: { A_TOKEN: 'two\nlines' }, files: [], keep: ['mem/config.json'] })
    expect([res.body.removed, res.body.filesRemoved, res.body.refused]).toEqual([[], [], ['A_TOKEN']])
    expect(r.env()).toEqual({ A_TOKEN: 'a' })
    expect(readFileSync(join(r.profile, 'mem', 'config.json'), 'utf8')).toBe('{"token":"x"}')
    // Still the bundle's: taken out once the master no longer names them.
    const later = await r.give({ env: {}, files: [] })
    expect([later.body.removed, later.body.filesRemoved]).toEqual([['A_TOKEN'], ['mem/config.json']])
  })
})

describe('the GitHub login and leaving (#609)', () => {
  test('the logins go to the node git service with the master; hosts and accounts in the answer, never the token', async () => {
    const r = rig()
    const given: { raw: unknown; master: string | undefined }[] = []
    const secrets = createNodeSecrets({
      dir: r.state,
      profiles: () => [{ id: 'default', title: 'Default', dir: r.profile, color: 'gray', hidden: false }],
      write: writeSink,
      audit: () => {},
      git: {
        logins: async (raw, master) => {
          given.push({ raw, master })
          return {
            logins: [{ host: 'github.com', user: 'owner', via: 'gh' }],
            taken: ['github.com'],
            kept: [],
            refused: [],
            gh: true,
          }
        },
      },
      log: () => {},
    })
    const res = await secrets.give(
      'default',
      { env: {}, files: [], logins: [{ host: 'github.com', user: 'owner', token: CANARY }] },
      'm1',
    )
    expect(given).toEqual([{ raw: [{ host: 'github.com', user: 'owner', token: CANARY }], master: 'm1' }])
    expect(res.body).toMatchObject({
      logins: [{ host: 'github.com', user: 'owner', via: 'gh' }],
      loginsTaken: ['github.com'],
      loginsKept: [],
      loginsRefused: [],
      gh: true,
    })
    expect(JSON.stringify(res.body)).not.toContain(CANARY)
  })

  test('a node with no git service refuses the logins by host', async () => {
    const r = rig()
    const res = await r.give({ env: {}, files: [], logins: [{ host: 'github.com', user: 'owner', token: CANARY }] })
    expect(res.body).toMatchObject({ logins: [], loginsRefused: ['github.com'], gh: false })
  })

  test("leaving: the master's variables and unchanged files taken out, a hand-given line and a changed file stay", async () => {
    const r = rig()
    await r.secrets.give(
      'default',
      {
        env: { A_TOKEN: CANARY, B_TOKEN: 'b' },
        files: [
          { path: 'mem/config.json', text: '{"token":"x"}' },
          { path: 'mem/other.json', text: '{"token":"y"}' },
        ],
      },
      'm1',
    )
    writeFileSync(r.envFile, `${readFileSync(r.envFile, 'utf8')}HAND_GIVEN=keep-me\n`)
    writeFileSync(join(r.profile, 'mem', 'other.json'), '{"token":"changed on the node"}')
    expect(JSON.parse(readFileSync(join(r.state, 'bundle-secrets', 'default.json'), 'utf8')).master).toBe('m1')
    const out = await r.secrets.leave('m1')
    expect(out).toEqual({ env: ['A_TOKEN', 'B_TOKEN'], files: ['mem/config.json'] })
    expect(r.env()).toEqual({ HAND_GIVEN: 'keep-me' })
    expect(() => statSync(join(r.profile, 'mem', 'config.json'))).toThrow()
    expect(readFileSync(join(r.profile, 'mem', 'other.json'), 'utf8')).toBe('{"token":"changed on the node"}')
    expect(() => statSync(join(r.state, 'bundle-secrets', 'default.json'))).toThrow()
    expect(r.audit.at(-1)).toEqual({
      op: 'bundle-left',
      master: 'm1',
      removed: ['A_TOKEN', 'B_TOKEN'],
      filesRemoved: ['mem/config.json'],
    })
    expect(JSON.stringify(r.audit) + r.logs.join('\n')).not.toContain(CANARY)
  })

  test("another master's leave takes out nothing; a record of before #609 (no master) is the one master's", async () => {
    const r = rig()
    await r.secrets.give('default', { env: { A_TOKEN: 'a' }, files: [] }, 'm1')
    expect(await r.secrets.leave('m2')).toEqual({ env: [], files: [] })
    expect(r.env()).toEqual({ A_TOKEN: 'a' })
    // As #608 wrote it: no master.
    const old = rig()
    await old.give({ env: { A_TOKEN: 'a' }, files: [] })
    expect(await old.secrets.leave('m2')).toEqual({ env: ['A_TOKEN'], files: [] })
    expect(old.env()).toEqual({})
  })
})
