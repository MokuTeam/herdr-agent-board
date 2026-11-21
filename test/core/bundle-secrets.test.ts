// The secrets a node's bundle gives it when its owner lets it (#604): the values the translation took
// out, by the names it refers to them as, and the secret files beside a sent script. Pure, on
// fixtures; canary values that must be in the secrets and in no manifest or report.
import { describe, expect, test } from 'bun:test'
import {
  type BundleContext,
  buildManifest,
  bundleSecrets,
  classifyMcp,
  type ProfileParts,
} from '../../src/core/bundle.ts'

const LINUX: BundleContext = { from: 'linux', to: 'linux', profileDir: '/home/owner/.claude', home: '/home/owner' }
const CANARY = 'canary-secrets-0b9e'
const ref = (name: string): string => ['$', '{', name, '}'].join('')
const sha = (n: number): string => n.toString(16).padStart(64, '0')
const parts = (over: Partial<ProfileParts> = {}): ProfileParts => ({
  files: [],
  skipped: [],
  followed: [],
  settings: {},
  mcpServers: {},
  ...over,
})

describe('bundleSecrets (#604)', () => {
  test('each value an MCP reference stands for, by its name, and the settings env held back for its name', () => {
    const p = parts({
      settings: { env: { PLAIN: '1', GITHUB_TOKEN: `${CANARY}-gh`, EMPTY_TOKEN: '' } },
      mcpServers: {
        mempalace: { type: 'http', url: 'https://m.example/mcp', headers: { Authorization: `Bearer ${CANARY}-m` } },
        telegram: {
          type: 'http',
          url: `https://bot:${CANARY}-pw@t.example/mcp?api_key=${CANARY}-q`,
        },
        tool: { command: 'npx', args: ['-y', 'tool', `--token=${CANARY}-arg`], env: { TOOL_SECRET: `${CANARY}-env` } },
      },
    })
    const s = bundleSecrets(p, LINUX)
    expect(s.env).toEqual({
      GITHUB_TOKEN: `${CANARY}-gh`,
      MCP_MEMPALACE_AUTHORIZATION: `Bearer ${CANARY}-m`,
      MCP_TELEGRAM_USER: 'bot',
      MCP_TELEGRAM_PASSWORD: `${CANARY}-pw`,
      MCP_TELEGRAM_API_KEY: `${CANARY}-q`,
      MCP_TOOL_TOKEN: `${CANARY}-arg`,
      MCP_TOOL_TOOL_SECRET: `${CANARY}-env`,
    })
    // The manifest has the references and the report the names: no value in either.
    const m = buildManifest(p, { config: {}, sinks: {} }, LINUX)
    expect(JSON.stringify(m)).not.toContain(CANARY)
    for (const name of Object.keys(s.env))
      expect(m.report.some(e => e.name === name && e.verdict === 'needs-secret')).toBe(true)
  })

  test('the secret files beside a sent script, not the state files, not one a command names itself', () => {
    const s = bundleSecrets(
      parts({
        files: [{ path: 'mem/save.py', sha256: sha(1), mode: 0o644 }],
        settings: {
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python3 /home/owner/.claude/mem/save.py' }] }] },
        },
        beside: [
          { path: 'mem/config.json', script: 'mem/save.py', secret: true },
          { path: 'mem/offsets.json', script: 'mem/save.py', secret: false },
        ],
      }),
      LINUX,
    )
    expect(s).toEqual({ env: {}, files: ['mem/config.json'] })
  })

  test('nothing to give: empty', () => {
    expect(bundleSecrets(parts({ settings: { env: { PLAIN: '1' } } }), LINUX)).toEqual({ env: {}, files: [] })
  })
})

describe('a reference with a default needs nothing (#604)', () => {
  test('not said as a secret to give, and never in the secrets', () => {
    const servers = {
      telegram: {
        command: 'npx',
        args: ['-y', 'tg-mcp'],
        env: { TG_KEY: ref('TG_KEY:-'), TG_CHANNEL: ref('TG_CHANNEL:-0'), HOST: ref('COMPUTERNAME:-') },
      },
      docs: { type: 'http', url: 'https://d.example/mcp', headers: { 'X-Team': ref('TEAM_ID') } },
    }
    const mcp = classifyMcp(servers, LINUX)
    expect(mcp.report.filter(e => e.why === 'reference').map(e => e.name)).toEqual(['TEAM_ID'])
    expect(JSON.stringify(mcp.report)).not.toContain('TG_KEY')
    expect(JSON.stringify(mcp.report)).not.toContain('COMPUTERNAME')
    // The server goes with its references as they are.
    expect((mcp.mcp.telegram as { env: Record<string, string> }).env.TG_KEY).toBe(ref('TG_KEY:-'))
    expect(bundleSecrets(parts({ mcpServers: servers }), LINUX).env).toEqual({})
  })

  test('a name used with a default and without one is still to be given', () => {
    const mcp = classifyMcp({ a: { command: 'npx', args: ['x', ref('TOKEN_A:-'), ref('TOKEN_A')] } }, LINUX)
    expect(mcp.report.filter(e => e.why === 'reference').map(e => e.name)).toEqual(['TOKEN_A'])
  })
})
