import { describe, expect, test } from 'bun:test'
import { doorRefusal } from '../../src/core/node-door.ts'
import {
  claudePilotArgs,
  claudePilotEnv,
  isSafeCallFileName,
  NO_HOOKS_SETTINGS,
  parseCallFilesRequest,
  parseCheckRequest,
  parseMcpReply,
  parseReportRequest,
  parseStartRequest,
  parseStdinRequest,
} from '../../src/core/pilot-call.ts'
import { localOnly } from '../../src/core/remote.ts'
import { extractInitSessionId } from '../../src/services/nodes/pilot-call.ts'

const SID = '11111111-2222-3333-4444-555555555555'
const FORK_SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('core/pilot-call', () => {
  test('parseCheckRequest validates UUID and cleans fields', () => {
    expect(parseCheckRequest({ session: SID, cwd: '/srv/proj', profile: 'work' })).toEqual({
      session: SID,
      cwd: '/srv/proj',
      profile: 'work',
      profileFolder: '',
    })
    expect('error' in parseCheckRequest({ session: 'not-a-uuid' })).toBe(true)
    expect('error' in parseCheckRequest(null)).toBe(true)
  })

  test('parseStartRequest validates model, effort, fork, and mcp spec', () => {
    const ok = parseStartRequest({
      session: SID,
      cwd: '/srv/proj',
      model: 'claude-sonnet-5',
      effort: 'high',
      fullAccess: true,
      fork: true,
      mcp: { name: 'mokupilot', tools: ['say', 'clear', 'board'] },
    })
    expect(ok).toEqual({
      session: SID,
      cwd: '/srv/proj',
      profile: '',
      profileFolder: '',
      model: 'claude-sonnet-5',
      effort: 'high',
      fullAccess: true,
      fork: true,
      mcp: { name: 'mokupilot', tools: ['say', 'clear', 'board'] },
    })
    expect('error' in parseStartRequest({ session: SID, model: 'bad;rm -rf /' })).toBe(true)
    expect('error' in parseStartRequest({ session: SID, mcp: { name: 'bad name', tools: [] } })).toBe(true)
    expect('error' in parseStartRequest({ session: SID, mcp: { name: 'mokupilot', tools: ['ok', 'bad tool'] } })).toBe(
      true,
    )
  })

  test('parseStdinRequest rejects multi-line strings', () => {
    expect(parseStdinRequest({ line: '{"type":"user"}' })).toEqual({ line: '{"type":"user"}' })
    expect('error' in parseStdinRequest({ line: 'a\nb' })).toBe(true)
    expect('error' in parseStdinRequest({ line: '' })).toBe(true)
  })

  test('parseMcpReply validates id, status, and contentType', () => {
    expect(parseMcpReply({ id: 'abcdefgh1234', status: 200, contentType: 'application/json', body: '{}' })).toEqual({
      id: 'abcdefgh1234',
      status: 200,
      contentType: 'application/json',
      body: '{}',
    })
    expect('error' in parseMcpReply({ id: 'bad', status: 200, body: '{}' })).toBe(true)
    expect('error' in parseMcpReply({ id: 'abcdefgh1234', status: 999, body: '{}' })).toBe(true)
  })

  test('parseCallFilesRequest validates kinds and filenames', () => {
    expect(isSafeCallFileName('meeting_123.md')).toBe(true)
    expect(isSafeCallFileName('../secret.txt')).toBe(false)
    expect(isSafeCallFileName('.hidden')).toBe(false)
    expect(isSafeCallFileName('dir/file.md')).toBe(false)

    const ok = parseCallFilesRequest({
      files: [{ kind: 'protocol', name: 'meeting_1.md', contentBase64: Buffer.from('# Summary').toString('base64') }],
    })
    expect('error' in ok).toBe(false)
    if (!('error' in ok)) {
      expect(ok.files[0]?.bytes.toString('utf8')).toBe('# Summary')
    }
    expect(
      'error' in
        parseCallFilesRequest({
          files: [{ kind: 'protocol', name: '../evil.md', contentBase64: 'QQ==' }],
        }),
    ).toBe(true)
  })

  test('parseReportRequest normalizes BOM and line endings', () => {
    const ok = parseReportRequest({ session: SID, report: '\uFEFFline1\r\nline2\r\n', reportId: 'call-123' })
    expect(ok).toEqual({ session: SID, report: 'line1\nline2', reportId: 'call-123' })
    expect('error' in parseReportRequest({ session: SID, report: '   ' })).toBe(true)
    expect('error' in parseReportRequest({ session: SID, report: 'ok', reportId: '../bad' })).toBe(true)
  })

  test('claudePilotArgs matches headless stream-json contract', () => {
    const args = claudePilotArgs({
      session: SID,
      fork: true,
      model: 'sonnet',
      effort: 'medium',
      fullAccess: false,
      mcpConfigPath: '/tmp/mcp-1.json',
      mcpName: 'mokupilot',
      mcpTools: ['say', 'board'],
    })
    expect(args).toEqual([
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--model',
      'sonnet',
      '--effort',
      'medium',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      SID,
      '--fork-session',
      '--settings',
      NO_HOOKS_SETTINGS,
      '--mcp-config',
      '/tmp/mcp-1.json',
      '--allowedTools',
      'mcp__mokupilot__say,mcp__mokupilot__board',
    ])
  })

  test('claudePilotEnv strips herdr and nested-claude vars and applies CLAUDE_CONFIG_DIR', () => {
    const base = {
      PATH: '/usr/bin',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_TAB_ID: 'w1:t1',
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: 'sk-test',
      CLAUDE_CONFIG_DIR: '/old',
    }
    const unsetDefault = claudePilotEnv(base, null)
    expect(unsetDefault.PATH).toBe('/usr/bin')
    expect(unsetDefault.HERDR_PANE_ID).toBeUndefined()
    expect(unsetDefault.CLAUDECODE).toBeUndefined()
    expect(unsetDefault.ANTHROPIC_API_KEY).toBeUndefined()
    expect(unsetDefault.CLAUDE_CONFIG_DIR).toBeUndefined()

    const custom = claudePilotEnv(base, '/profiles/work')
    expect(custom.CLAUDE_CONFIG_DIR).toBe('/profiles/work')
  })

  test('extractInitSessionId reads fork session_id from SSE line events', () => {
    const inner = JSON.stringify({ type: 'system', subtype: 'init', session_id: FORK_SID })
    const chunk = `event: line\ndata: ${JSON.stringify({ line: inner })}\n\n`
    expect(extractInitSessionId(chunk)).toBe(FORK_SID)
    expect(extractInitSessionId('event: stderr\ndata: {"line":"hi"}\n\n')).toBeNull()
  })

  test('node door allowlist and localOnly rules cover pilot-call routes', () => {
    expect(doorRefusal('POST', '/api/node/pilot-call/check', '/api/node/pilot-call/check')).toBeNull()
    expect(doorRefusal('POST', '/api/node/pilot-call/start', '/api/node/pilot-call/start')).toBeNull()
    expect(
      doorRefusal('GET', '/api/node/pilot-call/abcdefgh1234/events', '/api/node/pilot-call/abcdefgh1234/events'),
    ).toBeNull()
    expect(
      doorRefusal('POST', '/api/node/pilot-call/abcdefgh1234/stdin', '/api/node/pilot-call/abcdefgh1234/stdin'),
    ).toBeNull()
    expect(
      doorRefusal('POST', '/api/node/pilot-call/abcdefgh1234/mcp-reply', '/api/node/pilot-call/abcdefgh1234/mcp-reply'),
    ).toBeNull()
    expect(
      doorRefusal('POST', '/api/node/pilot-call/abcdefgh1234/close', '/api/node/pilot-call/abcdefgh1234/close'),
    ).toBeNull()
    expect(doorRefusal('POST', '/api/node/pilot-call/files', '/api/node/pilot-call/files')).toBeNull()
    expect(doorRefusal('POST', '/api/node/pilot-call/report', '/api/node/pilot-call/report')).toBeNull()
    // /api/session/<key>/mokupilot is never exposed on the node door: master runs MokuPilot locally.
    expect(doorRefusal('POST', `/api/session/${SID}/mokupilot`, `/api/session/${SID}/mokupilot`)).not.toBeNull()
    // Master bridge is strictly localOnly (never exposed over tunnel or remote phones).
    expect(localOnly('/api/mokupilot/node-call/abcdefgh1234/start')).toBe(true)
  })
})
