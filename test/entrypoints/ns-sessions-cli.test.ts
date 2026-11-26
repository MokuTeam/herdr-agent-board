// `board ns-sessions list` (#860, entrypoints/ns-sessions-cli.ts): the store's metadata as lines or
// JSON, only the fields it knows (a value a server might send is never printed), 503 as "no store".
import { expect, test } from 'bun:test'
import { nsSessionsCommand } from '../../src/entrypoints/ns-sessions-cli.ts'

const T = 1_800_000_000_000
const meta = {
  account: '1234567_SB1',
  user: 'agent@example.com',
  role: '3',
  host: '1234567-sb1.app.netsuite.com',
  state: 'live',
  dead_reason: null,
  dead_matched: null,
  fp: '0a1b2c3d',
  generation: 2,
  origin: { machine: 'laptop', profile: 'work' },
  login_at: T - 3_600_000,
  abs_expiry: T + 11 * 3_600_000,
  idle_expiry: T + 2 * 3_600_000,
  last_activity: { at: T - 120_000, where: 'server-2/main' },
  holders: ['laptop', 'server-2'],
  lock: null,
  // What no store sends, and this command never prints whatever comes.
  cookies: [{ name: 'JSESSIONID', value: 'fake-cli-value-55aa' }],
}

const answering = (status: number, body: unknown): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('http://127.0.0.1:12999/api/ns-sessions/list')
    expect(new Headers(init?.headers).get('x-board')).toBe('1')
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch

async function run(argv: string[], status: number, body: unknown): Promise<{ code: number; out: string[] }> {
  const out: string[] = []
  const code = await nsSessionsCommand(argv, 12999, {
    fetch: answering(status, body),
    print: l => out.push(l),
    now: () => T,
  })
  return { code, out }
}

test('lines and JSON hold the metadata, never a value', async () => {
  const lines = await run(['list'], 200, [meta])
  expect(lines.code).toBe(0)
  expect(lines.out).toEqual([
    '1234567_SB1 · agent@example.com · live · fp 0a1b2c3d · gen 2 · login 1h00 ago · ends in 2h00 · active 2m ago on server-2/main',
  ])
  const json = await run(['list', '--json'], 200, [meta])
  expect(JSON.parse(json.out.join('\n'))).toEqual([{ ...meta, cookies: undefined }].map(({ cookies: _, ...m }) => m))
  for (const r of [lines, json]) expect(r.out.join('\n')).not.toContain('fake-cli-value-55aa')
})

test('an empty store, no store, and a wrong word', async () => {
  expect((await run(['list'], 200, [])).out).toEqual(['no NetSuite sessions in the store'])
  expect(await run(['list'], 503, { ok: false, error: 'node-master-offline' })).toEqual({
    code: 1,
    out: ['no store: the master board is not reachable now'],
  })
  await expect(run(['get'], 200, [])).rejects.toThrow('usage: board ns-sessions list [--json]')
  await expect(run(['list'], 403, { error: 'header' })).rejects.toThrow('ns-sessions list: header')
})
