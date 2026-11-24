import { describe, expect, test } from 'bun:test'
import { doorRefusal } from '../../src/core/node-door.ts'
import {
  CODE_MODE_SETTINGS,
  claudePilotArgs,
  claudePilotEnv,
  extractClaudeError,
  failureSummary,
  isCodeModeTranscriptLine,
  isSafeCallFileName,
  NO_HOOKS_SETTINGS,
  parseBridgeRequest,
  parseBridgeResponse,
  parseBridgeStreamChunk,
  parseCallFilesRequest,
  parseCheckRequest,
  parseMcpReply,
  parseOpenRequest,
  parseReportRequest,
  parseStartRequest,
  parseStdinRequest,
  profileHasCodeMode,
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

    const plainExplicit = claudePilotArgs({ session: SID, fork: true, fullAccess: false, codeMode: false })
    expect(plainExplicit).toEqual(claudePilotArgs({ session: SID, fork: true, fullAccess: false }))
    expect(plainExplicit).toContain(NO_HOOKS_SETTINGS)

    const codeModeArgs = claudePilotArgs({
      session: SID,
      fork: true,
      fullAccess: false,
      codeMode: true,
    })
    const settingsIdx = codeModeArgs.indexOf('--settings')
    expect(settingsIdx).toBeGreaterThan(-1)
    expect(codeModeArgs[settingsIdx + 1]).toBe(CODE_MODE_SETTINGS)
    expect(JSON.parse(codeModeArgs[settingsIdx + 1] ?? '{}')).toEqual({
      disableAllHooks: true,
      env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' },
    })
  })

  test('isCodeModeTranscriptLine and profileHasCodeMode detect Code Mode markers accurately', () => {
    expect(isCodeModeTranscriptLine(JSON.stringify({ type: 'repl-mode', replMode: true, sessionId: SID }))).toBe(true)
    expect(isCodeModeTranscriptLine(`\uFEFF${JSON.stringify({ type: 'repl-mode', replMode: true })}`)).toBe(true)
    expect(isCodeModeTranscriptLine(JSON.stringify({ type: 'repl-mode', replMode: false, sessionId: SID }))).toBe(false)
    expect(
      isCodeModeTranscriptLine(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'line {"type":"repl-mode","replMode":true}' },
        }),
      ),
    ).toBe(false)
    expect(isCodeModeTranscriptLine('{"type":"repl-mode"')).toBe(false)

    expect(profileHasCodeMode({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' } })).toBe(true)
    expect(profileHasCodeMode({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: 'true' } })).toBe(true)
    expect(profileHasCodeMode({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: true } })).toBe(true)
    expect(profileHasCodeMode({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: 1 } })).toBe(true)
    expect(profileHasCodeMode({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '0' } })).toBe(false)
    expect(profileHasCodeMode({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: 'false' } })).toBe(false)
    expect(profileHasCodeMode({ disableAllHooks: true })).toBe(false)
    expect(profileHasCodeMode(null)).toBe(false)
  })

  test('extractClaudeError and failureSummary surface CLI errors in plain words', () => {
    expect(
      extractClaudeError(
        JSON.stringify({
          type: 'result',
          is_error: true,
          errors: ['\x1b[31mFailed to resume session\x1b[0m', 'details'],
        }),
      ),
    ).toEqual({ kind: 'error', text: 'Failed to resume session; details' })
    expect(extractClaudeError(JSON.stringify({ type: 'result', is_error: true, result: 'session locked' }))).toEqual({
      kind: 'error',
      text: 'session locked',
    })
    expect(
      extractClaudeError(JSON.stringify({ type: 'result', is_error: true, errors: [], result: 'fallback error' })),
    ).toEqual({ kind: 'error', text: 'fallback error' })
    expect(extractClaudeError(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }))).toEqual({
      kind: 'clear',
      text: '',
    })
    expect(
      extractClaudeError(
        JSON.stringify({
          type: 'system',
          subtype: 'notification',
          color: 'warning',
          text: 'Code Mode unavailable',
        }),
      ),
    ).toEqual({ kind: 'notice', text: 'Code Mode unavailable' })
    expect(extractClaudeError('\x1b[31mplain fatal failure\x1b[0m')).toEqual({
      kind: 'plain',
      text: 'plain fatal failure',
    })
    expect(failureSummary('line1\n\x1b[31mline2\x1b[0m\nline3\nline4')).toBe('line2; line3; line4')
    expect(failureSummary('a'.repeat(50), 20)).toBe(`${'a'.repeat(17)}...`)
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
    // Node-to-master pilot-bridge door routes (#700).
    expect(doorRefusal('GET', '/api/node/pilot-bridge', '/api/node/pilot-bridge')).toBeNull()
    expect(
      doorRefusal(
        'GET',
        '/api/node/pilot-bridge/req/abcdefgh1234/body',
        '/api/node/pilot-bridge/req/abcdefgh1234/body',
      ),
    ).toBeNull()
    expect(
      doorRefusal('POST', '/api/node/pilot-bridge/res/abcdefgh1234', '/api/node/pilot-bridge/res/abcdefgh1234'),
    ).toBeNull()
    expect(
      doorRefusal('POST', '/api/node/pilot-bridge/stream/abcdefgh1234', '/api/node/pilot-bridge/stream/abcdefgh1234'),
    ).toBeNull()
    expect(doorRefusal('POST', '/api/node/pilot-bridge', '/api/node/pilot-bridge')).not.toBeNull()
    expect(
      doorRefusal('GET', '/api/node/pilot-bridge/res/abcdefgh1234', '/api/node/pilot-bridge/res/abcdefgh1234'),
    ).not.toBeNull()
    // Master bridge is strictly localOnly (never exposed over tunnel or remote phones).
    expect(localOnly('/api/mokupilot/node-call/abcdefgh1234/start')).toBe(true)
    expect(localOnly('/api/mokupilot/node-call/open')).toBe(true)
    expect(localOnly('/api/mokupilot/node-call/sessions')).toBe(true)
  })

  test('parseOpenRequest, parseBridgeRequest, parseBridgeResponse, and parseBridgeStreamChunk (#700)', () => {
    expect(parseOpenRequest({ session: SID, cwd: '/srv/atlas' })).toEqual({
      session: SID,
      device: '',
      cwd: '/srv/atlas',
    })
    expect(parseOpenRequest({ key: `@server-2:${SID}` })).toEqual({
      session: SID,
      device: 'server-2',
      cwd: '',
    })
    expect(parseOpenRequest({ session: `@server-2:${SID}`, device: 'local' })).toEqual({
      error: 'conflicting device id',
    })
    expect(parseOpenRequest({ session: SID, device: 'BAD_DEVICE' })).toEqual({
      error: 'invalid device id',
    })

    expect(parseBridgeRequest({ id: 'req12345678', op: 'start', grantId: 'grant12345', body: '{}' })).toEqual({
      id: 'req12345678',
      op: 'start',
      grantId: 'grant12345',
      body: '{}',
    })
    expect(parseBridgeRequest({ id: 'req12345678', op: 'bogus' })).toBeNull()
    expect(parseBridgeRequest({ id: 'bad', op: 'open' })).toBeNull()

    expect(parseBridgeResponse({ status: 200, contentType: 'application/json', body: '{"ok":true}' })).toEqual({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
    })
    expect(parseBridgeResponse({ status: 99, body: '' })).toBeNull()

    expect(
      parseBridgeStreamChunk({
        events: [{ name: 'line', data: '{"line":"ok"}' }],
        done: true,
      }),
    ).toEqual({
      events: [{ name: 'line', data: '{"line":"ok"}' }],
      done: true,
    })
    expect(parseBridgeStreamChunk({ events: [{ name: 'bad', data: 'x' }] })).toBeNull()
  })
})
