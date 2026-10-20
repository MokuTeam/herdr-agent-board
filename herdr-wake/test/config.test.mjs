import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.mjs'

const telegramServer = {
  mcpServers: { telegram: { url: 'http://127.0.0.1:8787/mcp', headers: { Authorization: 'Bearer t' } } },
}

test('without tg-mcp the router runs without Telegram, on the defaults', () => {
  const c = resolveConfig({}, {})
  assert.equal(c.telegram, false)
  assert.equal(c.port, 12421)
  assert.equal(c.wakeCommand, 'claude --resume {session}')
  assert.deepEqual(c.reaper, { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3 })
})

test('the telegram MCP server in ~/.claude.json gives the url and token, as before', () => {
  const c = resolveConfig({}, telegramServer)
  assert.equal(c.telegram, true)
  assert.equal(c.url, 'http://127.0.0.1:8787')
  assert.equal(c.authorization, 'Bearer t')
})

test('config.json wins over ~/.claude.json, and its reaper over the defaults', () => {
  const c = resolveConfig(
    { url: 'http://box:1', authorization: 'Bearer own', reaper: { enabled: true, idleMinutes: 30 } },
    telegramServer,
  )
  assert.equal(c.url, 'http://box:1')
  assert.equal(c.authorization, 'Bearer own')
  assert.equal(c.telegram, true)
  assert.deepEqual(c.reaper, { enabled: true, idleMinutes: 30, exclude: [], maxPerRound: 3 })
})

test('a url without a token is no Telegram', () => {
  assert.equal(resolveConfig({ url: 'http://box:1' }, {}).telegram, false)
})
