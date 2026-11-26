// `board team agents [<peer>]` and `board team post @name.agent` (#832) against a board that answers
// the way the routes do: the directory as data lines, and the post sent to that peer with the
// mention in front of the text (the board opens the topic and names the agent).
import { afterEach, expect, test } from 'bun:test'
import { directoryLines, teamAgents } from '../../src/entrypoints/team-agents-cli.ts'

const P = 'A'.repeat(43)
const Q = 'B'.repeat(43)
const servers: { stop(): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop()
})

function board(peers: unknown[]) {
  const posted: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/team/directory') return Response.json({ peers })
      if (path === '/api/team/post') {
        posted.push(await req.json())
        return Response.json({
          ok: true,
          sent: true,
          thread: `${P}/11111111-1111-4111-8111-111111111111`,
          copies: 1,
          skipped: [],
        })
      }
      return Response.json({ ok: false }, { status: 404 })
    },
  })
  servers.push(server)
  const ctx = {
    webPort: server.port as number,
    roster: [
      { peer: P, name: 'Anna Lee' },
      { peer: Q, name: 'ben' },
    ],
    self: async () => ({ key: 'sess-1', name: 'day' }),
    find: async () => ({ key: 'sess-1' }),
  }
  return { posted, ctx }
}

const DIR = [
  { peer: P, name: 'Anna Lee', agents: [{ code: 'helper', about: 'Answers \u001b[2J questions' }] },
  { peer: Q, name: 'ben', agents: [{ code: 'reviewer' }] },
]

test('board team agents lists @name.code with the line about it, printable; one peer, or nobody yet', async () => {
  const { ctx } = board(DIR)
  const all = await teamAgents('agents', [], ctx)
  expect(all.split('\n').slice(0, 2)).toEqual(['@AnnaLee.helper  Answers \\u{1b}[2J questions', '@ben.reviewer'])
  expect(all).toContain('board team post @name.agent')
  expect(await teamAgents('agents', ['ben'], ctx)).toMatch(/^@ben\.reviewer\n/)
  // As the MCP's team tool passes a name: after a lone --.
  expect(await teamAgents('agents', ['--', 'ben'], ctx)).toMatch(/^@ben\.reviewer\n/)
  expect(directoryLines([], null)).toBe('no teammate has an agent this board can address yet')
  expect(directoryLines(DIR, 'C'.repeat(43))).toBe('none of their agents can be addressed from this board')
  await expect(teamAgents('agents', ['team'], ctx)).rejects.toThrow('usage')
})

test('board team post @name.agent goes to that peer with the mention in front; a bad one is refused before anything is sent', async () => {
  const { ctx, posted } = board(DIR)
  expect(await teamAgents('post', ['@AnnaLee.helper', 'check the PR'], ctx)).toContain('ok · sent to Anna Lee')
  expect(posted).toEqual([{ to: P, text: '@AnnaLee.helper check the PR', session: { key: 'sess-1', name: 'day' } }])
  await expect(teamAgents('post', ['@nobody.helper', 'x'], ctx)).rejects.toThrow(
    'nobody on the team is written @nobody',
  )
  await expect(teamAgents('post', ['@AnnaLee', 'x'], ctx)).rejects.toThrow('usage')
  expect(posted).toHaveLength(1)
  // A plain name goes as before.
  await teamAgents('post', ['ben', 'hello'], ctx)
  expect(posted[1]).toEqual({ to: Q, text: 'hello', session: { key: 'sess-1', name: 'day' } })
})
