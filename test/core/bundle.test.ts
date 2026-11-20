// The profile bundle (design: docs/design/nodes, 9 and 14, T10): what of a profile folder a node
// gets, classified row by row of 9.1's table, for a Windows, a Linux and a macOS master and a
// Linux node; the hash; what the node owns.
import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  type BundleContext,
  type BundleManifest,
  behindBy,
  boardSlice,
  buildManifest,
  bundleHash,
  classifyCommand,
  classifyMcp,
  classifySettings,
  hookKey,
  nextVersion,
  owned,
  ownedAfter,
  PROFILE_DIR,
  type ProfileParts,
  type ReportEntry,
  recorded,
  toRemove,
} from '../../src/core/bundle.ts'
import { isBoardCommand } from '../../src/core/install-plan.ts'

const WIN: BundleContext = {
  from: 'win32',
  to: 'linux',
  profileDir: 'C:\\Users\\Roma\\.claude',
  home: 'C:\\Users\\Roma',
}
const LINUX: BundleContext = { from: 'linux', to: 'linux', profileDir: '/home/roma/.claude', home: '/home/roma' }
const MAC: BundleContext = { from: 'darwin', to: 'linux', profileDir: '/Users/roma/.claude', home: '/Users/roma' }
const PAIRS = [
  {
    pair: 'Windows to Linux',
    ctx: WIN,
    inProfile: 'C:\\Users\\Roma\\.claude\\hooks\\lint.sh',
    elsewhere: 'C:\\tools\\lint.sh',
  },
  {
    pair: 'Linux to Linux',
    ctx: LINUX,
    inProfile: '/home/roma/.claude/hooks/lint.sh',
    elsewhere: '/opt/tools/lint.sh',
  },
  {
    pair: 'macOS to Linux',
    ctx: MAC,
    inProfile: '/Users/roma/.claude/hooks/lint.sh',
    elsewhere: '/usr/local/bin/lint.sh',
  },
] as const

const hookSettings = (...commands: string[]) => ({
  hooks: {
    PostToolUse: [{ matcher: 'Edit', hooks: commands.map(command => ({ type: 'command', command, timeout: 5 })) }],
  },
})
const sentCommands = (part: { hooks: Record<string, unknown[]> }): string[] =>
  Object.values(part.hooks).flatMap(list =>
    (list as { hooks: { command?: string }[] }[]).flatMap(e => e.hooks.map(h => h.command ?? '')),
  )
/** A `${NAME}` reference, as Claude Code expands it in an MCP server's settings. */
const ref = (name: string): string => ['$', '{', name, '}'].join('')
const entry = (report: ReportEntry[], kind: string, name: string): ReportEntry | undefined =>
  report.find(e => e.kind === kind && e.name === name)

describe('9.1 settings.json: plain keys', () => {
  test('permissions, model, effort, enabledPlugins and extraKnownMarketplaces are copied as keys', () => {
    const settings = {
      permissions: { allow: ['Bash(git status)'], deny: ['Read(./.env)'] },
      model: 'opus',
      effortLevel: 'high',
      enabledPlugins: { 'superpowers@market': true },
      extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'a/b' } } },
    }
    const part = classifySettings(settings, WIN)
    assert.deepEqual(part.settings, settings)
    assert.deepEqual(part.hooks, {})
  })

  test('the input is not changed', () => {
    const settings = {
      model: 'opus',
      env: { API_TOKEN: 'x', A: '1' },
      ...hookSettings('bash C:/Users/Roma/.claude/a.sh'),
    }
    const before = JSON.stringify(settings)
    classifySettings(settings, WIN)
    assert.equal(JSON.stringify(settings), before)
  })

  test('a key named __proto__ stays a key of its own', () => {
    const part = classifySettings(JSON.parse('{"__proto__": {"polluted": true}, "model": "opus"}'), WIN)
    assert.equal(Object.getPrototypeOf(part.settings), Object.prototype)
    assert.deepEqual(Object.keys(part.settings), ['__proto__', 'model'])
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  })
})

describe('9.1 settings.json: env', () => {
  test('copied, except names that look like a secret, which are reported as needs-secret', () => {
    const part = classifySettings(
      { env: { DISABLE_TELEMETRY: '1', GITHUB_TOKEN: 'a', OPENAI_API_KEY: 'b', MY_SECRET: 'c', DB_Password: 'd' } },
      WIN,
    )
    assert.deepEqual(part.settings.env, { DISABLE_TELEMETRY: '1' })
    assert.equal(entry(part.report, 'env', 'DISABLE_TELEMETRY')?.verdict, 'sent')
    for (const name of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'MY_SECRET', 'DB_Password'])
      assert.deepEqual(entry(part.report, 'env', name), {
        kind: 'env',
        name,
        verdict: 'needs-secret',
        why: 'secret-name',
      })
  })

  test('an env of nothing but secrets leaves no env key', () => {
    assert.equal('env' in classifySettings({ env: { API_TOKEN: 'a' } }, WIN).settings, false)
  })
})

describe('9.1 settings.json: hooks', () => {
  test("the board's own hooks are never sent, from any copy, and are not differences", () => {
    const ours = [
      '"C:/Users/Roma/.bun/bin/bun.exe" "C:/Work/Personal/herdr/agent-board/src/entrypoints/hook.ts"',
      'node "C:\\Work\\agent-board\\src\\hook.mjs"',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Work\\agent-board\\integrations\\toast.ps1"',
      '"/usr/bin/bun" "/home/roma/agent-board/src/entrypoints/wake-hook.ts" pre-send',
    ]
    const part = classifySettings(
      {
        ...hookSettings(...ours),
        statusLine: { type: 'command', command: '"bun" "/x/agent-board/src/entrypoints/statusline.ts"' },
      },
      WIN,
    )
    assert.deepEqual(part.hooks, {})
    assert.equal('statusLine' in part.settings, false)
    assert.deepEqual(part.report, [])
  })

  test("a copy of the board in a folder of another name is the board's when boardDir names it", () => {
    const command = '"bun" "D:/apps/board-copy/src/entrypoints/hook.ts"'
    assert.equal(isBoardCommand(command), false)
    assert.deepEqual(classifySettings(hookSettings(command), { ...WIN, boardDir: 'D:\\apps\\board-copy' }).hooks, {})
  })

  for (const { pair, ctx, inProfile, elsewhere } of PAIRS) {
    describe(pair, () => {
      test('a hook inside the profile folder is translated: the folder becomes the placeholder', () => {
        const part = classifySettings(hookSettings(`bash "${inProfile}" --fix`), ctx)
        assert.deepEqual(sentCommands(part), [`bash "${PROFILE_DIR}/hooks/lint.sh" --fix`])
        assert.deepEqual(entry(part.report, 'hook', 'lint'), {
          kind: 'hook',
          name: 'lint',
          verdict: 'translated',
          why: 'profile-path',
          detail: 'PostToolUse',
        })
        const sent = part.hooks.PostToolUse as { matcher: string; hooks: { timeout: number }[] }[]
        assert.equal(sent[0]?.matcher, 'Edit')
        assert.equal(sent[0]?.hooks[0]?.timeout, 5)
      })

      test('a bare command the node finds on its PATH is sent as it is', () => {
        const part = classifySettings(hookSettings('jq -r .tool_input.file_path | xargs prettier --write'), ctx)
        assert.deepEqual(sentCommands(part), ['jq -r .tool_input.file_path | xargs prettier --write'])
        assert.equal(entry(part.report, 'hook', 'jq')?.verdict, 'sent')
      })

      test('a hook naming another path of this computer is not sent, reported with its command', () => {
        const command = `bash ${elsewhere}`
        const part = classifySettings(hookSettings(command), ctx)
        assert.deepEqual(part.hooks, {})
        assert.deepEqual(entry(part.report, 'hook', 'lint'), {
          kind: 'hook',
          name: 'lint',
          verdict: 'not-sent',
          why: 'local-path',
          detail: command,
        })
      })

      test('a folder that only starts like the profile folder is another folder', () => {
        const command = `bash ${inProfile.replace('.claude', '.claude-work')}`
        assert.deepEqual(classifyCommand(command, ctx), { ok: false, why: 'local-path' })
      })

      test('/dev/null and /usr/bin/env are on every node', () => {
        assert.deepEqual(classifyCommand(`/usr/bin/env bash ${inProfile} 2>/dev/null`, ctx), {
          ok: true,
          command: `/usr/bin/env bash ${PROFILE_DIR}/hooks/lint.sh 2>/dev/null`,
          translated: true,
        })
      })
    })
  }

  test('Windows: any form of the profile folder is rewritten, case and slashes aside', () => {
    for (const form of [
      'C:\\Users\\Roma\\.claude',
      'C:/Users/Roma/.claude',
      'c:/users/roma/.CLAUDE',
      '/c/Users/Roma/.claude',
      '~/.claude',
      '$HOME/.claude',
      '%USERPROFILE%\\.claude',
    ])
      assert.deepEqual(classifyCommand(`bash "${form}\\hooks\\a.sh"`, WIN), {
        ok: true,
        command: `bash "${PROFILE_DIR}/hooks/a.sh"`,
        translated: true,
      })
  })

  test('Linux: case matters; macOS: it does not', () => {
    assert.deepEqual(classifyCommand('bash /home/roma/.CLAUDE/a.sh', LINUX), { ok: false, why: 'local-path' })
    assert.equal(classifyCommand('bash /users/ROMA/.claude/a.sh', MAC).ok, true)
  })

  test('PowerShell, cmd or a Windows script on the way to a Linux node is not sent', () => {
    const toast = 'powershell -NoProfile -File "C:\\Users\\Roma\\.claude\\hooks\\notify-toast.ps1"'
    for (const command of [toast, 'pwsh -c Write-Host hi', 'cmd /c echo hi', 'C:/Users/Roma/.claude/hooks/x.bat'])
      assert.deepEqual(classifyCommand(command, WIN), { ok: false, why: 'windows-shell' })
    const part = classifySettings(hookSettings(toast), WIN)
    assert.deepEqual(entry(part.report, 'hook', 'notify-toast'), {
      kind: 'hook',
      name: 'notify-toast',
      verdict: 'not-sent',
      why: 'windows-shell',
      detail: toast,
    })
  })

  test('a hook in ~ outside the profile folder is a path of this computer', () => {
    assert.deepEqual(classifyCommand('bash ~/bin/notify.sh', LINUX), { ok: false, why: 'local-path' })
  })

  test('one entry keeps the hooks that travel and loses the rest; a prompt hook travels', () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'say done' },
              { type: 'command', command: 'C:/tools/beep.exe' },
              { type: 'prompt', prompt: 'Check the tests ran.' },
            ],
          },
        ],
        Notification: [{ hooks: [{ type: 'command', command: 'C:/tools/beep.exe' }] }],
      },
    }
    const part = classifySettings(settings, WIN)
    assert.deepEqual(part.hooks, {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'say done' },
            { type: 'prompt', prompt: 'Check the tests ran.' },
          ],
        },
      ],
    })
  })

  test('a status line of the owner travels by the same rule; a credentials helper never', () => {
    const part = classifySettings(
      {
        statusLine: { type: 'command', command: 'bash ~/.claude/statusline.sh', padding: 0 },
        apiKeyHelper: 'C:/Users/Roma/.claude/key.sh',
      },
      WIN,
    )
    assert.deepEqual(part.settings, {
      statusLine: { type: 'command', command: `bash ${PROFILE_DIR}/statusline.sh`, padding: 0 },
    })
    assert.equal(entry(part.report, 'hook', 'statusLine')?.verdict, 'translated')
    assert.deepEqual(entry(part.report, 'hook', 'apiKeyHelper'), {
      kind: 'hook',
      name: 'apiKeyHelper',
      verdict: 'not-sent',
      why: 'credentials',
    })
  })

  test('accept marks a difference as accepted, and leaves what was sent unmarked', () => {
    const part = classifySettings(hookSettings('powershell -File "C:\\x\\notify-toast.ps1"', 'jq .'), {
      ...WIN,
      accept: ['hook:notify-toast', 'hook:jq'],
    })
    assert.equal(entry(part.report, 'hook', 'notify-toast')?.accepted, true)
    assert.equal(entry(part.report, 'hook', 'jq')?.accepted, undefined)
  })
})

describe('9.1 MCP servers of the user scope', () => {
  test('http and sse are copied; a header that holds a value becomes a reference asked for as a secret', () => {
    const part = classifyMcp(
      {
        docs: { type: 'http', url: 'https://docs.example.com/mcp' },
        linear: {
          type: 'sse',
          url: 'https://mcp.linear.app/sse',
          headers: { Authorization: 'Bearer abc', 'X-Ref': ref('ALREADY') },
        },
      },
      WIN,
    )
    assert.deepEqual(part.mcp, {
      docs: { type: 'http', url: 'https://docs.example.com/mcp' },
      linear: {
        type: 'sse',
        url: 'https://mcp.linear.app/sse',
        headers: { Authorization: ref('MCP_LINEAR_AUTHORIZATION'), 'X-Ref': ref('ALREADY') },
      },
    })
    assert.deepEqual(entry(part.report, 'mcp', 'docs'), { kind: 'mcp', name: 'docs', verdict: 'sent', why: 'copied' })
    assert.deepEqual(entry(part.report, 'mcp', 'linear'), {
      kind: 'mcp',
      name: 'linear',
      verdict: 'translated',
      why: 'secret-value',
    })
    assert.deepEqual(entry(part.report, 'mcp', 'MCP_LINEAR_AUTHORIZATION'), {
      kind: 'mcp',
      name: 'MCP_LINEAR_AUTHORIZATION',
      verdict: 'needs-secret',
      why: 'secret-value',
      detail: 'linear',
    })
  })

  test("a key in the URL's query becomes a reference too; a server on this computer's loopback is bound to it", () => {
    const part = classifyMcp(
      {
        search: { type: 'http', url: 'https://s.example.com/mcp?api_key=abc&region=eu' },
        local: { type: 'http', url: 'http://127.0.0.1:8080/mcp?token=abc' },
      },
      WIN,
    )
    assert.deepEqual(part.mcp, {
      search: { type: 'http', url: `https://s.example.com/mcp?api_key=${ref('MCP_SEARCH_API_KEY')}&region=eu` },
    })
    assert.deepEqual(entry(part.report, 'mcp', 'local'), {
      kind: 'mcp',
      name: 'local',
      verdict: 'bound',
      why: 'local-url',
      detail: 'http://127.0.0.1:8080/mcp',
    })
  })

  for (const { pair, ctx, elsewhere } of PAIRS) {
    describe(pair, () => {
      test('stdio run by a launcher with no local path in its arguments is sent', () => {
        const servers = {
          ctx7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
          fetch: { command: 'uvx', args: ['mcp-server-fetch'], env: { LOG: 'info' } },
          gh: { command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'] },
        }
        const part = classifyMcp(servers, ctx)
        assert.deepEqual(part.mcp, servers)
        for (const name of Object.keys(servers))
          assert.deepEqual(entry(part.report, 'mcp', name), { kind: 'mcp', name, verdict: 'sent', why: 'launcher' })
      })

      test('a launcher with an absolute path of this computer in its arguments is bound', () => {
        const part = classifyMcp(
          { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', elsewhere] } },
          ctx,
        )
        assert.deepEqual(part.mcp, {})
        assert.deepEqual(entry(part.report, 'mcp', 'fs'), {
          kind: 'mcp',
          name: 'fs',
          verdict: 'bound',
          why: 'local-path',
          detail: elsewhere,
        })
      })

      test('a program that is not a launcher is bound to this computer', () => {
        const part = classifyMcp(
          { own: { command: elsewhere.replace('lint.sh', 'server'), args: [] }, bare: { command: 'my-server' } },
          ctx,
        )
        assert.deepEqual(part.mcp, {})
        assert.equal(entry(part.report, 'mcp', 'own')?.verdict, 'bound')
        assert.deepEqual(entry(part.report, 'mcp', 'bare'), {
          kind: 'mcp',
          name: 'bare',
          verdict: 'bound',
          why: 'local-command',
          detail: 'my-server',
        })
      })
    })
  }

  test('Windows: cmd /c npx and npx.cmd become the launcher; a secret in a stdio env becomes a reference', () => {
    const part = classifyMcp(
      {
        a: { command: 'cmd', args: ['/c', 'npx', '-y', 'pkg-a'] },
        b: {
          command: 'C:\\Program Files\\nodejs\\npx.cmd',
          args: ['-y', 'pkg-b'],
          env: { GITHUB_TOKEN: 'ghp_x', MODE: 'ro' },
        },
      },
      WIN,
    )
    assert.deepEqual(part.mcp, {
      a: { command: 'npx', args: ['-y', 'pkg-a'] },
      b: { command: 'npx', args: ['-y', 'pkg-b'], env: { GITHUB_TOKEN: ref('GITHUB_TOKEN'), MODE: 'ro' } },
    })
    assert.deepEqual(entry(part.report, 'mcp', 'a'), {
      kind: 'mcp',
      name: 'a',
      verdict: 'translated',
      why: 'unwrapped',
    })
    assert.equal(entry(part.report, 'mcp', 'GITHUB_TOKEN')?.verdict, 'needs-secret')
  })

  test('docker with a volume of this computer is bound', () => {
    const part = classifyMcp({ d: { command: 'docker', args: ['run', '-v', 'C:\\data:/data', 'img'] } }, WIN)
    assert.equal(entry(part.report, 'mcp', 'd')?.why, 'local-path')
  })

  test("the device's entry wins: false switches a server off, { command, args, env } replaces it", () => {
    const part = classifyMcp(
      {
        desk: { command: 'C:\\tools\\desk.exe' },
        docs: { type: 'http', url: 'https://docs.example.com/mcp' },
      },
      { ...WIN, mcp: { desk: { command: 'desk-server', args: ['--port', '1'], env: { MODE: 'node' } }, docs: false } },
    )
    assert.deepEqual(part.mcp, {
      desk: { type: 'stdio', command: 'desk-server', args: ['--port', '1'], env: { MODE: 'node' } },
    })
    assert.deepEqual(entry(part.report, 'mcp', 'desk'), {
      kind: 'mcp',
      name: 'desk',
      verdict: 'translated',
      why: 'override',
    })
    assert.deepEqual(entry(part.report, 'mcp', 'docs'), { kind: 'mcp', name: 'docs', verdict: 'not-sent', why: 'off' })
  })

  test('accept marks a bound server as accepted', () => {
    const part = classifyMcp({ desk: { command: 'C:\\tools\\desk.exe' } }, { ...WIN, accept: ['mcp:desk'] })
    assert.equal(entry(part.report, 'mcp', 'desk')?.accepted, true)
  })
})

describe("9.1 the board's slice", () => {
  test('categories, language, models and the sinks travel; launch.claude with plain claude travels with its flags', () => {
    const config = {
      categories: [{ id: 'atlas', color: 'blue', paths: [] }],
      language: 'ru',
      models: { default: 'opus' },
      launch: { claude: ['claude', '--model', 'opus'] },
      port: 12422,
      team: { hub: 'wss://x' },
    }
    const { board, report } = boardSlice(config, { demo: { kind: 'file' } })
    assert.deepEqual(board, {
      categories: config.categories,
      language: 'ru',
      models: { default: 'opus' },
      sinks: { demo: { kind: 'file' } },
      launch: { claude: ['claude', '--model', 'opus'] },
    })
    assert.deepEqual(report, [])
  })

  test("a launcher of the owner's own stays on the master and the report says so", () => {
    const { board, report } = boardSlice({ launch: { claude: ['C:\\tools\\claude-wrap.cmd', '--x'] } }, undefined)
    assert.deepEqual(board, { sinks: {} })
    assert.deepEqual(report, [
      {
        kind: 'launcher',
        name: 'launch.claude',
        verdict: 'not-sent',
        why: 'own-launcher',
        detail: 'C:\\tools\\claude-wrap.cmd',
      },
    ])
  })
})

const CANARY = 'canary-7f3a9c'

const parts = (o: Partial<ProfileParts> = {}): ProfileParts => ({
  files: [
    { path: 'skills/review/SKILL.md', sha256: 'a'.repeat(64), mode: 0o644 },
    { path: 'skills/review/check.sh', sha256: 'b'.repeat(64), mode: 0o755 },
    { path: 'agents/fixer.md', sha256: 'c'.repeat(64), mode: 0o644 },
    { path: 'CLAUDE.md', sha256: 'd'.repeat(64), mode: 0o644 },
  ],
  skipped: [
    { path: 'skills/big/model.bin', why: 'too-big' },
    { path: 'skills/tool/node_modules', why: 'skipped-folder' },
  ],
  followed: [],
  settings: { model: 'opus', env: { API_TOKEN: CANARY, MODE: 'x' } },
  mcpServers: {
    remote: {
      type: 'http',
      url: `https://m.example.com/mcp?key=${CANARY}`,
      headers: { Authorization: `Bearer ${CANARY}` },
    },
    local: { command: 'npx', args: ['-y', 'pkg'], env: { SERVICE_PASSWORD: CANARY } },
  },
  ...o,
})

describe('9.1 files and the whole manifest', () => {
  test('skills by folder, other files by path, and every file left out is a line of the report', () => {
    const m = buildManifest(parts(), { config: {}, sinks: {} }, WIN)
    assert.deepEqual(
      m.files.map(f => f.path),
      ['CLAUDE.md', 'agents/fixer.md', 'skills/review/SKILL.md', 'skills/review/check.sh'],
    )
    const files = m.report.filter(e => e.kind === 'skill' || e.kind === 'file')
    assert.deepEqual(files, [
      { kind: 'file', name: 'CLAUDE.md', verdict: 'sent', why: 'copied' },
      { kind: 'file', name: 'agents/fixer.md', verdict: 'sent', why: 'copied' },
      { kind: 'skill', name: 'review', verdict: 'sent', why: 'copied' },
      { kind: 'skill', name: 'skills/big/model.bin', verdict: 'not-sent', why: 'too-big' },
      { kind: 'skill', name: 'skills/tool/node_modules', verdict: 'not-sent', why: 'skipped-folder' },
    ])
  })

  test('a secret is never in the manifest: canaries in env, a header, a query and a stdio env', () => {
    const m = buildManifest(parts(), { config: {}, sinks: {} }, WIN)
    expect(JSON.stringify(m)).not.toContain(CANARY)
    assert.deepEqual(
      m.report.filter(e => e.verdict === 'needs-secret').map(e => e.name),
      ['API_TOKEN', 'MCP_REMOTE_KEY', 'MCP_REMOTE_AUTHORIZATION', 'SERVICE_PASSWORD'],
    )
  })

  test('every verdict of the report is reachable', () => {
    const m = buildManifest(
      parts({
        mcpServers: {
          a: { command: 'C:\\x.exe' },
          b: { type: 'http', url: 'https://b.example.com', headers: { K: 'v' } },
        },
        settings: hookSettings('bash ~/.claude/a.sh', 'jq .', 'C:/x/y.sh'),
      }),
      { config: {}, sinks: {} },
      WIN,
    )
    assert.deepEqual(
      new Set(m.report.map(e => e.verdict)),
      new Set(['sent', 'translated', 'not-sent', 'needs-secret', 'bound']),
    )
  })
})

describe('9.2 the hash and the version', () => {
  const base = buildManifest(parts(), { config: { language: 'en' }, sinks: {} }, WIN)

  test('the same whatever order the files were walked in, and whatever order the keys came in', () => {
    const shuffled = buildManifest(
      parts({ files: [...parts().files].reverse() }),
      { config: { language: 'en' }, sinks: {} },
      WIN,
    )
    assert.equal(bundleHash(shuffled), bundleHash(base))
    const unsorted: BundleManifest = {
      ...base,
      files: [...base.files].reverse(),
      settings: { env: base.settings.env, model: base.settings.model },
    }
    assert.equal(bundleHash(unsorted), bundleHash(base))
    assert.match(bundleHash(base), /^[0-9a-f]{64}$/)
  })

  test('a file, a setting or the slice that changes changes it; the report does not', () => {
    const h = bundleHash(base)
    assert.notEqual(
      bundleHash({ ...base, files: base.files.map((f, i) => (i ? f : { ...f, sha256: 'e'.repeat(64) })) }),
      h,
    )
    assert.notEqual(bundleHash({ ...base, files: base.files.map((f, i) => (i ? f : { ...f, mode: 0o755 })) }), h)
    assert.notEqual(bundleHash({ ...base, settings: { ...base.settings, model: 'sonnet' } }), h)
    assert.notEqual(bundleHash({ ...base, board: { ...base.board, language: 'ru' } }), h)
    const unreported: BundleManifest = { ...base, report: [] }
    assert.equal(bundleHash(unreported), h)
  })

  test('seq counts the hashes the master has seen; behind is how many changes', () => {
    const v1 = nextVersion(null, 'a')
    assert.deepEqual(v1, { hash: 'a', seq: 1 })
    assert.equal(nextVersion(v1, 'a'), v1)
    const v3 = nextVersion(nextVersion(v1, 'b'), 'a')
    assert.deepEqual(v3, { hash: 'a', seq: 3 })
    assert.equal(behindBy(v3, v1), 0)
    assert.equal(behindBy(v3, { hash: 'b', seq: 2 }), 1)
    assert.equal(behindBy({ hash: 'c', seq: 4 }, { hash: 'a', seq: 1 }), 3)
    assert.equal(behindBy(v3, null), 3)
  })
})

describe('9.3 what the node owns', () => {
  const file = (path: string) => ({ path, sha256: path.padEnd(64, '0').slice(0, 64), mode: 0o644 })
  const manifest = (o: Partial<BundleManifest>): BundleManifest => ({
    format: 1,
    files: [],
    settings: {},
    hooks: {},
    mcp: {},
    board: { sinks: {} },
    report: [],
    ...o,
  })
  const hook = { type: 'command', command: 'jq .' }
  const prev = manifest({
    files: [file('skills/a/SKILL.md'), file('agents/old.md')],
    settings: { model: 'opus', env: { A: '1', B: '2' } },
    hooks: { Stop: [{ hooks: [hook] }] },
    mcp: { docs: {}, old: {} },
  })
  const next = manifest({
    files: [file('skills/a/SKILL.md'), file('commands/new.md')],
    settings: { model: 'opus', env: { A: '1' } },
    mcp: { docs: {} },
  })

  test('owned: files, settings keys with env by variable, hooks by event and identity, server names', () => {
    assert.deepEqual(owned(prev), {
      files: ['agents/old.md', 'skills/a/SKILL.md'],
      settings: ['env.A', 'env.B', 'model'],
      hooks: [{ event: 'Stop', key: hookKey(undefined, hook) }],
      mcp: ['docs', 'old'],
    })
    assert.deepEqual(owned(null), { files: [], settings: [], hooks: [], mcp: [] })
  })

  test('toRemove: what was owned and is gone', () => {
    assert.deepEqual(toRemove(prev, next), {
      files: ['agents/old.md'],
      settings: ['env.B'],
      hooks: [{ event: 'Stop', key: hookKey(undefined, hook) }],
      mcp: ['old'],
    })
    assert.deepEqual(toRemove(null, next), { files: [], settings: [], hooks: [], mcp: [] })
    assert.deepEqual(toRemove(next, next), { files: [], settings: [], hooks: [], mcp: [] })
  })

  test("ownedAfter: a file kept as the node's own is not owned; one owned before stays owned", () => {
    assert.deepEqual(ownedAfter(prev, next, ['commands/new.md']).files, ['skills/a/SKILL.md'])
    assert.deepEqual(ownedAfter(prev, next, ['skills/a/SKILL.md']).files, ['commands/new.md', 'skills/a/SKILL.md'])
    const rec = recorded(prev, next, ['commands/new.md'])
    assert.deepEqual(owned(rec), ownedAfter(prev, next, ['commands/new.md']))
    // The kept file stays the node's on the next apply: nothing removes it.
    assert.deepEqual(toRemove(rec, manifest({ files: [file('skills/a/SKILL.md')] })).files, [])
  })
})
