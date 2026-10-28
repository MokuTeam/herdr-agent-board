import { describe, expect, test } from 'bun:test'
import {
  folderFor,
  givenPath,
  joinPath,
  MAX_FOLDER,
  moved,
  type ProjectFact,
  pairProjects,
  pathKey,
  projectFolder,
  remoteKey,
  under,
  winPath,
} from '../../src/core/profile-sync/paths.ts'
import {
  areaOf,
  buildPreview,
  byArea,
  type Manifest,
  type ProfileFacts,
  sizeOf,
  targetRel,
  transferOf,
} from '../../src/core/profile-sync/plan.ts'
import {
  mergeClaudeJson,
  mergeHistory,
  mergeSettings,
  rewriteCwd,
  rewriteHistory,
} from '../../src/core/profile-sync/rewrite.ts'
import {
  type CarryTo,
  CUT,
  carried,
  cutSecrets,
  oneMachine,
  secretFile,
  secretName,
  shareClaudeJson,
  shareSettings,
} from '../../src/core/profile-sync/secrets.ts'

const TO_LINUX: CarryTo = { platform: 'linux', from: 'win32', fromHome: 'C:\\Users\\migo', toHome: '/home/agent' }
const TO_PC: CarryTo = { platform: 'win32', from: 'linux', fromHome: '/home/agent', toHome: 'C:\\Users\\migo' }
const GH = `ghp_${'a1B2'.repeat(9)}`

describe('Claude’s folder names under projects/', () => {
  test('as Claude names them on this PC and on a server', () => {
    // the owner's own folders, as Claude made them
    expect(projectFolder('C:\\migo\\development\\projects\\external\\mokuhub\\herdr-agent-board')).toBe(
      'C--migo-development-projects-external-mokuhub-herdr-agent-board',
    )
    expect(projectFolder('C:\\Users\\migo')).toBe('C--Users-migo')
    expect(
      projectFolder(
        'C:\\Users\\migo\\AppData\\Local\\Temp\\claude\\C--migo-development-projects-external-mokuhub-herdr-agent-board\\6b3353f4-54e2-4520-8d23-6d8f04ce61b7\\scratchpad\\wake-probe',
      ),
    ).toBe(
      'C--Users-migo-AppData-Local-Temp-claude-C--migo-development-projects-external-mokuhub-herdr-agent-board-6b3353f4-54e2-4520-8d23-6d8f04ce61b7-scratchpad-wake-probe',
    )
    expect(projectFolder('/home/agent/work/my project')).toBe('-home-agent-work-my-project')
    // another alphabet, and %: each character a '-'
    expect(projectFolder('C:\\migo\\001 Проект%')).toBe('C--migo-001--------')
  })

  test('a long one cut at 200 with a hash after it; one already there is kept', () => {
    const long = `/home/agent/${'x'.repeat(250)}`
    const name = projectFolder(long)
    expect(name.length).toBeGreaterThan(MAX_FOLDER)
    expect(name.slice(0, MAX_FOLDER)).toBe(`-home-agent-${'x'.repeat(188)}`)
    expect(projectFolder(long)).toBe(name)
    const there = `${name.slice(0, MAX_FOLDER)}-otherhash`
    expect(folderFor(long, [there])).toBe(there)
    expect(folderFor('/home/agent/x', [])).toBe('-home-agent-x')
  })
})

describe('paths on each side', () => {
  test('Windows paths in any of their forms, compared and moved', () => {
    expect(winPath('/c/migo/x')).toBe('C:\\migo\\x')
    expect(winPath('C:/migo/x')).toBe('C:\\migo\\x')
    expect(pathKey('C:\\Migo\\X\\', 'win32')).toBe('c:/migo/x')
    expect(under('/c/migo/x/sub/dir', 'C:\\migo\\x', 'win32')).toBe('sub/dir')
    expect(under('C:\\migo\\x', 'C:/migo/x', 'win32')).toBe('')
    expect(under('C:\\migo\\xy', 'C:\\migo\\x', 'win32')).toBeNull()
    expect(joinPath('/home/agent/x', 'sub/dir', 'linux')).toBe('/home/agent/x/sub/dir')
    expect(joinPath('C:\\migo\\x', 'sub/dir', 'win32')).toBe('C:\\migo\\x\\sub\\dir')
    const moves = [{ from: 'C:\\migo\\x', to: '/home/agent/x' }]
    expect(moved('/c/migo/x/a', moves, 'win32', 'linux')).toBe('/home/agent/x/a')
    expect(moved('C:\\other', moves, 'win32', 'linux')).toBeNull()
    expect(moved('/home/agent/x/a', [{ from: '/home/agent/x', to: 'C:\\migo\\x' }], 'linux', 'win32')).toBe(
      'C:\\migo\\x\\a',
    )
  })

  test('remotes compared whatever their form; one on a disk names nothing', () => {
    const one = 'github.com/mokuteam/herdr-agent-board'
    expect(remoteKey('git@github.com:MokuTeam/herdr-agent-board.git')).toBe(one)
    expect(remoteKey('https://github.com/MokuTeam/herdr-agent-board')).toBe(one)
    expect(remoteKey('ssh://git@github.com:22/MokuTeam/herdr-agent-board.git/')).toBe(one)
    expect(remoteKey('https://user@github.com/MokuTeam/herdr-agent-board.git')).toBe(one)
    expect(remoteKey('file:///opt/board.git')).toBeNull()
    expect(remoteKey('C:\\repos\\x')).toBeNull()
    expect(remoteKey('/srv/x.git')).toBeNull()
    expect(remoteKey('')).toBeNull()
  })

  test('a path the owner gives, as the target writes one', () => {
    expect(givenPath(' /home/agent/work/x/ ', 'linux')).toBe('/home/agent/work/x')
    expect(givenPath('work/x', 'linux')).toBeNull()
    expect(givenPath('C:\\x', 'linux')).toBeNull()
    expect(givenPath('C:/migo/x', 'win32')).toBe('C:\\migo\\x')
    expect(givenPath('/home/x', 'win32')).toBeNull()
  })
})

const project = (p: Partial<ProjectFact> & { folder: string }): ProjectFact => ({
  profile: 'default',
  path: null,
  state: 'git',
  remote: null,
  top: null,
  worktree: false,
  files: 1,
  bytes: 10,
  ...p,
})

describe('projects paired by git remote', () => {
  const board = project({
    folder: 'C--migo-board',
    path: 'C:\\migo\\board',
    remote: 'git@github.com:MokuTeam/board.git',
    top: 'C:\\migo\\board',
  })
  const sub = project({
    folder: 'C--migo-board-web',
    path: 'C:\\migo\\board\\web',
    remote: 'git@github.com:MokuTeam/board.git',
    top: 'C:\\migo\\board',
  })
  const tree = project({
    folder: 'C--migo-board--claude-worktrees-x',
    path: 'C:\\migo\\board\\.claude\\worktrees\\x',
    remote: 'git@github.com:MokuTeam/board.git',
    top: 'C:\\migo\\board\\.claude\\worktrees\\x',
    worktree: true,
  })
  const plain = project({ folder: 'C--notes', path: 'C:\\notes', state: 'plain' })
  const gone = project({ folder: 'C--old', path: 'C:\\old', state: 'gone' })
  const lonely = project({
    folder: 'C--lonely',
    path: 'C:\\lonely',
    remote: 'https://github.com/a/lonely',
    top: 'C:\\lonely',
  })
  const server = {
    platform: 'linux',
    projects: [],
    clones: [{ path: '/home/agent/work/board', remote: 'https://github.com/MokuTeam/board' }],
    folders: {},
  }

  test('by remote, a subfolder kept; a worktree, a plain folder, a gone one and one with no clone listed', () => {
    const r = pairProjects({
      source: { platform: 'win32', projects: [tree, board, sub, plain, gone, lonely] },
      target: server,
      given: {},
    })
    expect(r.pairs).toEqual([
      {
        profile: 'default',
        folder: 'C--migo-board',
        from: 'C:\\migo\\board',
        to: '/home/agent/work/board',
        toFolder: '-home-agent-work-board',
        how: 'remote',
      },
      {
        profile: 'default',
        folder: 'C--migo-board-web',
        from: 'C:\\migo\\board\\web',
        to: '/home/agent/work/board/web',
        toFolder: '-home-agent-work-board-web',
        how: 'remote',
      },
    ])
    expect(Object.fromEntries(r.unpaired.map(u => [u.folder, u.why]))).toEqual({
      'C--migo-board--claude-worktrees-x': 'worktree',
      'C--notes': 'noRemote',
      'C--old': 'gone',
      'C--lonely': 'noClone',
    })
  })

  test('the owner’s path, or left out; two projects for one folder: the first keeps it', () => {
    const r = pairProjects({
      source: { platform: 'win32', projects: [board, tree, plain] },
      target: server,
      given: { 'default/C--notes': '/home/agent/notes', 'default/C--migo-board--claude-worktrees-x': null },
    })
    expect(r.pairs.map(p => [p.folder, p.to, p.how])).toEqual([
      ['C--migo-board', '/home/agent/work/board', 'remote'],
      ['C--notes', '/home/agent/notes', 'owner'],
    ])
    expect(r.unpaired.map(u => [u.folder, u.why])).toEqual([['C--migo-board--claude-worktrees-x', 'left']])
    const taken = pairProjects({
      source: { platform: 'win32', projects: [board, plain] },
      target: server,
      given: { 'default/C--notes': '/home/agent/work/board' },
    })
    expect(taken.unpaired.map(u => [u.folder, u.why])).toEqual([['C--notes', 'taken']])
  })

  test('the server to a PC: its clones paired with the PC’s projects; the same path between two Linux machines', () => {
    const there = project({
      folder: '-home-agent-work-board',
      path: '/home/agent/work/board',
      remote: 'https://github.com/MokuTeam/board',
      top: '/home/agent/work/board',
    })
    const r = pairProjects({
      source: { platform: 'linux', projects: [there] },
      target: { platform: 'win32', projects: [board], clones: [], folders: { default: ['C--migo-board'] } },
      given: {},
    })
    expect(r.pairs.map(p => [p.to, p.toFolder])).toEqual([['C:\\migo\\board', 'C--migo-board']])
    const same = project({ folder: '-srv-notes', path: '/srv/notes', state: 'plain' })
    const r2 = pairProjects({
      source: { platform: 'linux', projects: [same] },
      target: { platform: 'linux', projects: [same], clones: [], folders: {} },
      given: {},
    })
    expect(r2.pairs.map(p => p.how)).toEqual(['same'])
  })
})

describe('what never crosses', () => {
  test('one machine’s own files and the secret files', () => {
    for (const rel of [
      'cache/x',
      'shell-snapshots/s.sh',
      'session-env/a',
      'sessions/1.json',
      'ide/1.lock',
      'daemon/x',
      'daemon.lock',
      'telemetry/x',
      'debug/x',
      'backups/.claude.json.backup',
      'plugins/installed_plugins.json',
      'statsig/x',
      'stats-cache.json',
      'settings.json.bak-agent-board',
      'hooks/herdr-agent-state.ps1',
      'skills/herdr-agents/SKILL.md',
      'projects/x/a.jsonl.agent-board-sync',
    ])
      expect(oneMachine(rel)).toBe(true)
    for (const rel of [
      'projects/x/a.jsonl',
      'skills/a/SKILL.md',
      'CLAUDE.md',
      'hooks/mine.sh',
      'paste-cache/x',
      'todos/x',
    ])
      expect(oneMachine(rel)).toBe(false)
    expect(secretFile('.credentials.json')).toBe(true)
    expect(secretFile('.claude.json.pre-rename-bak')).toBe(true)
    expect(secretFile('.claude.json')).toBe(false)
    expect(secretFile('projects/x/.credentials.json')).toBe(true)
  })

  test('secrets cut from any text by kind, a JSON line still JSON', () => {
    const line = JSON.stringify({
      cwd: '/x',
      message: `token ${GH} and sk-ant-api03-${'x'.repeat(40)} and -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----, Authorization: Bearer ${'y'.repeat(30)}, AKIAABCDEFGHIJKLMNOP, 123456789:AA${'z'.repeat(33)}`,
    })
    const r = cutSecrets(line)
    expect(r.found).toEqual({
      'private key': 1,
      'Anthropic key': 1,
      'GitHub token': 1,
      'AWS key': 1,
      'Telegram bot token': 1,
      'bearer token': 1,
    })
    expect(r.text).not.toContain(GH)
    expect(r.text).toContain(`Bearer ${CUT}`)
    expect(() => JSON.parse(r.text)).not.toThrow()
    // nothing that only looks near one
    expect(cutSecrets('sha 1a2b3c4d, ghp_short, a sk- note, CLAUDE_CODE_MAX_OUTPUT_TOKENS').found).toEqual({})
  })

  test('env names that hold a key or a token', () => {
    for (const n of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'DB_PASSWORD', 'myApiKey'])
      expect(secretName(n)).toBe(true)
    for (const n of ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'BASH_DEFAULT_TIMEOUT_MS', 'DISABLE_TELEMETRY'])
      expect(secretName(n)).toBe(false)
  })

  test('a command carried: Windows ones stay off Linux, Linux ones off Windows, a home moved between Linux machines', () => {
    expect(carried('powershell -File "C:\\x\\a.ps1"', TO_LINUX)).toBeNull()
    expect(carried('C:/tools/x.exe --y', TO_LINUX)).toBeNull()
    expect(carried('npx -y @foo/bar', TO_LINUX)).toBe('npx -y @foo/bar')
    expect(carried('/home/agent/bin/x', TO_PC)).toBeNull()
    expect(carried('npx -y @foo/bar', TO_PC)).toBe('npx -y @foo/bar')
    expect(
      carried('/home/me/bin/x --c /home/me/c', {
        platform: 'linux',
        from: 'darwin',
        fromHome: '/home/me',
        toHome: '/home/agent',
      }),
    ).toBe('/home/agent/bin/x --c /home/agent/c')
  })

  test('settings.json: env keys, secret helpers, the board’s hooks, hooks with a secret or a Windows path', () => {
    const s = shareSettings(
      {
        env: { ANTHROPIC_API_KEY: 'k', DISABLE_TELEMETRY: '1', X: GH },
        apiKeyHelper: '~/bin/key.sh',
        permissions: { allow: ['Bash(git:*)'] },
        statusLine: { type: 'command', command: '"C:/bun.exe" "C:/agent-board/src/entrypoints/statusline.ts"' },
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: '"C:/bun.exe" "C:/agent-board/src/entrypoints/hook.ts"' }] },
            {
              hooks: [
                { type: 'command', command: 'powershell -File C:\\Users\\migo\\.claude\\hooks\\herdr-agent-state.ps1' },
              ],
            },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: 'notify-send done' }] },
            { hooks: [{ type: 'command', command: 'C:\\tools\\beep.exe' }] },
            { hooks: [{ type: 'command', command: `curl -H "Authorization: Bearer ${'q'.repeat(30)}" x` }] },
          ],
        },
      },
      TO_LINUX,
    )
    expect(s.value).toEqual({
      env: { DISABLE_TELEMETRY: '1' },
      permissions: { allow: ['Bash(git:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] },
    })
    expect(s.held).toEqual([
      'env ANTHROPIC_API_KEY',
      'env X',
      'apiKeyHelper',
      `hook Stop: curl -H "Authorization: Bearer ${CUT}" x`,
    ])
    expect(s.cantGo).toEqual(['hook Stop: C:\\tools\\beep.exe'])
  })

  test('.claude.json: the OAuth part held back, the machine’s state kept, MCP headers and env, projects as the target names them', () => {
    const cj = {
      oauthAccount: { emailAddress: 'a@b.c' },
      userID: 'u',
      numStartups: 9,
      cachedGrowthBookFeatures: {},
      hasSeenTasksHint: true,
      claudeCodeFirstTokenDate: 'x',
      theme: 'dark',
      mcpServers: {
        gh: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
        local: { command: 'C:\\tools\\mcp.exe', args: [] },
        npx: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 't' } },
      },
      projects: {
        'C:/migo/board': { allowedTools: [], mcpServers: { p: { command: 'node', args: ['C:\\x\\s.js'] } } },
        'C:/elsewhere': { allowedTools: [] },
      },
    }
    const s = shareClaudeJson(cj, TO_LINUX, p =>
      moved(p, [{ from: 'C:\\migo\\board', to: '/home/agent/board' }], 'win32', 'linux'),
    )
    expect(s.value).toEqual({
      theme: 'dark',
      mcpServers: { gh: { type: 'http', url: 'https://x/mcp' }, npx: { command: 'npx', args: ['-y', 'pkg'] } },
      projects: { '/home/agent/board': { allowedTools: [], mcpServers: {} } },
    })
    expect(s.held).toEqual(['oauthAccount', 'MCP gh: headers', 'MCP npx: env'])
    expect(s.cantGo).toEqual(['MCP local: C:\\tools\\mcp.exe', 'MCP p (/home/agent/board): node C:\\x\\s.js'])
  })
})

describe('merged on the target, by key', () => {
  test('settings.json keeps its own env secrets, helpers, board hooks and status line; shared hooks added once', () => {
    const own = {
      env: { ANTHROPIC_API_KEY: 'mine', A: '1' },
      apiKeyHelper: 'mine.sh',
      statusLine: { command: 'bun /home/agent/agent-board/src/entrypoints/statusline.ts' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] },
    }
    const shared = {
      env: { A: '2', B: '3' },
      statusLine: { command: 'echo hi' },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo c' }] }],
      },
      model: 'opus',
    }
    expect(mergeSettings(own, shared)).toEqual({
      env: { ANTHROPIC_API_KEY: 'mine', A: '2', B: '3' },
      apiKeyHelper: 'mine.sh',
      statusLine: own.statusLine,
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo c' }] }],
      },
      model: 'opus',
    })
  })

  test('.claude.json keeps its OAuth part, ids and MCP headers; projects merged entry by entry', () => {
    const own = {
      oauthAccount: { emailAddress: 'server@x' },
      userID: 's',
      mcpServers: { gh: { type: 'http', url: 'https://old', headers: { Authorization: 'mine' } } },
      projects: {
        '/home/agent/board': { hasTrustDialogAccepted: true, lastSessionId: 's1' },
        '/home/agent/own': { a: 1 },
      },
    }
    const shared = {
      theme: 'dark',
      mcpServers: { gh: { type: 'http', url: 'https://new' } },
      projects: { '/home/agent/board': { allowedTools: ['Bash'] } },
    }
    expect(mergeClaudeJson(own, shared)).toEqual({
      oauthAccount: { emailAddress: 'server@x' },
      userID: 's',
      theme: 'dark',
      mcpServers: { gh: { type: 'http', url: 'https://new', headers: { Authorization: 'mine' } } },
      projects: {
        '/home/agent/board': { hasTrustDialogAccepted: true, lastSessionId: 's1', allowedTools: ['Bash'] },
        '/home/agent/own': { a: 1 },
      },
    })
  })

  test('history.jsonl: both sides’ lines, each once, in time order', () => {
    const a = '{"display":"a","timestamp":1}\n{"display":"c","timestamp":3}\n'
    const b = '{"display":"b","timestamp":2}\n{"display":"a","timestamp":1}\n'
    expect(mergeHistory(a, b)).toBe(
      '{"display":"a","timestamp":1}\n{"display":"b","timestamp":2}\n{"display":"c","timestamp":3}\n',
    )
  })
})

describe('paths rewritten both ways', () => {
  const up = [{ from: 'C:\\migo\\board', to: '/home/agent/work/board' }]
  test('a transcript’s cwd inside a pair, another left as it is', () => {
    const text = `{"cwd":"/c/migo/board","x":1}\n{"cwd":"C:\\\\migo\\\\board\\\\web"}\n{"cwd":"C:\\\\other"}\n`
    const r = rewriteCwd(text, up, 'win32', 'linux')
    expect(r.n).toBe(2)
    expect(r.text).toBe(
      '{"cwd":"/home/agent/work/board","x":1}\n{"cwd":"/home/agent/work/board/web"}\n{"cwd":"C:\\\\other"}\n',
    )
    const down = rewriteCwd(
      '{"cwd":"/home/agent/work/board/web"}',
      [{ from: '/home/agent/work/board', to: 'C:\\migo\\board' }],
      'linux',
      'win32',
    )
    expect(JSON.parse(down.text).cwd).toBe('C:\\migo\\board\\web')
  })

  test('history.jsonl follows the pairs; a line of another project is left out', () => {
    const text = `${JSON.stringify({ display: 'a', timestamp: 1, project: 'C:\\migo\\board' })}\n${JSON.stringify({ display: 'b', timestamp: 2, project: 'C:\\x' })}\n`
    const r = rewriteHistory(text, up, 'win32', 'linux')
    expect(r).toEqual({
      text: `${JSON.stringify({ display: 'a', timestamp: 1, project: '/home/agent/work/board' })}\n`,
      n: 1,
      dropped: 1,
    })
  })
})

const facts = (
  name: string,
  dir: string,
  files: ProfileFacts['files'],
  synced: ProfileFacts['synced'] = {},
): ProfileFacts => ({
  name,
  dir,
  files,
  synced,
  secretFiles: [],
})

const manifest = (
  platform: string,
  home: string,
  profiles: ProfileFacts[],
  projects: ProjectFact[] = [],
  more: Partial<Manifest> = {},
): Manifest => ({
  v: 1,
  platform,
  home,
  profiles,
  projects,
  clones: [],
  findings: [],
  held: [],
  cantGo: [],
  ...more,
})

describe('the preview', () => {
  const pcProject = project({
    folder: 'C--migo-board',
    path: 'C:\\migo\\board',
    remote: 'https://github.com/MokuTeam/board',
    top: 'C:\\migo\\board',
  })
  const pc = (files: ProfileFacts['files'], synced: ProfileFacts['synced'] = {}) =>
    manifest(
      'win32',
      'C:\\Users\\migo',
      [
        { ...facts('default', 'C:\\Users\\migo\\.claude', files, synced), secretFiles: ['.credentials.json'] },
        facts('work', 'C:\\Users\\migo\\.claude-work', { 'CLAUDE.md': ['w', 1] }),
      ],
      [pcProject],
      {
        findings: [{ profile: 'default', rel: 'projects/C--migo-board/s1.jsonl', kinds: ['GitHub token'] }],
        held: [{ profile: 'default', what: 'oauthAccount' }],
        cantGo: [{ profile: 'default', what: 'hook Stop: C:\\x.exe' }],
      },
    )
  const server = (files: ProfileFacts['files'], synced: ProfileFacts['synced'] = {}) =>
    manifest('linux', '/home/agent', [facts('default', '/home/agent/.claude', files, synced)], [], {
      clones: [{ path: '/home/agent/work/board', remote: 'git@github.com:MokuTeam/board.git' }],
    })

  test('the first sync up: added, merged, the same, a conflict, a profile made, folders renamed', () => {
    const p = buildPreview({
      id: 'p1',
      at: 1,
      direction: 'up',
      source: pc({
        'CLAUDE.md': ['c1', 10],
        'settings.json': ['s1', 5],
        'skills/a/SKILL.md': ['k1', 7],
        'agents/x.md': ['x1', 3],
        'projects/C--migo-board/s1.jsonl': ['t1', 100],
        'projects/C--other/s2.jsonl': ['t2', 50],
      }),
      target: server({ 'settings.json': ['ss', 5], 'skills/a/SKILL.md': ['k1', 7], 'agents/x.md': ['x2', 4] }),
      given: {},
    })
    expect(p.profiles).toEqual([
      { name: 'default', create: false, dir: '/home/agent/.claude' },
      { name: 'work', create: true, dir: '/home/agent/.claude-work' },
    ])
    expect(p.items.map(i => [i.profile, i.from, i.to, i.kind])).toEqual([
      ['default', 'CLAUDE.md', 'CLAUDE.md', 'add'],
      ['default', 'settings.json', 'settings.json', 'merge'],
      ['default', 'projects/C--migo-board/s1.jsonl', 'projects/-home-agent-work-board/s1.jsonl', 'add'],
      ['work', 'CLAUDE.md', 'CLAUDE.md', 'add'],
    ])
    expect(p.same.map(s => s.from)).toEqual(['skills/a/SKILL.md'])
    expect(p.conflicts.map(c => [c.from, c.thereSize, c.key])).toEqual([['agents/x.md', 4, 'default:agents/x.md']])
    expect(p.unpaired).toEqual([])
    expect(p.moves).toEqual([{ from: 'C:\\migo\\board', to: '/home/agent/work/board' }])
    expect(p.held).toEqual([
      { profile: 'default', what: '.credentials.json' },
      { profile: 'default', what: 'oauthAccount' },
      { profile: 'default', what: 'projects/C--migo-board/s1.jsonl: GitHub token' },
    ])
    expect(p.cantGo).toEqual([{ profile: 'default', what: 'hook Stop: C:\\x.exe' }])
    expect(p.bytes).toBe(10 + 5 + 100 + 1)
    // the unpaired folder's files never go: C--other has no project fact, so it is not even listed
    expect(p.items.some(i => i.from.includes('C--other'))).toBe(false)
  })

  test('after a sync: only what changed goes; changed on both sides is a conflict; deletions; gone on both forgotten', () => {
    const synced = {
      'CLAUDE.md': 'c1',
      'agents/x.md': 'x1',
      'agents/gone.md': 'g1',
      'agents/both.md': 'b1',
      'skills/a/SKILL.md': 'k1',
    }
    const there = {
      'CLAUDE.md': 'c1',
      'agents/x.md': 'x1',
      'agents/gone.md': 'g1',
      'agents/both.md': 'b1',
      'skills/a/SKILL.md': 'k1',
    }
    const p = buildPreview({
      id: 'p2',
      at: 2,
      direction: 'up',
      source: pc({ 'CLAUDE.md': ['c2', 11], 'agents/x.md': ['x3', 3], 'skills/a/SKILL.md': ['k1', 7] }, synced),
      target: server(
        {
          'CLAUDE.md': ['c1', 10],
          'agents/x.md': ['x9', 9],
          'agents/gone.md': ['g2', 2],
          'skills/a/SKILL.md': ['k1', 7],
        },
        there,
      ),
      given: {},
    })
    expect(p.items.filter(i => i.profile === 'default').map(i => [i.from, i.kind])).toEqual([['CLAUDE.md', 'change']])
    expect(p.conflicts.map(c => c.from)).toEqual(['agents/x.md'])
    expect(p.deletions).toEqual([
      {
        profile: 'default',
        from: 'agents/gone.md',
        to: 'agents/gone.md',
        changedThere: true,
        key: 'default:agents/gone.md',
      },
    ])
    expect(p.forget).toEqual([{ profile: 'default', from: 'agents/both.md', to: 'agents/both.md' }])
    expect(p.same).toEqual([])
  })

  test('Apply’s choices: a conflict given the source’s goes, the target’s by default; deletions only ticked; a profile made only when used', () => {
    const p = buildPreview({
      id: 'p3',
      at: 3,
      direction: 'up',
      source: pc({ 'agents/x.md': ['x3', 3] }, { 'agents/x.md': 'x1', 'agents/gone.md': 'g1' }),
      target: server(
        { 'agents/x.md': ['x9', 9], 'agents/gone.md': ['g1', 2] },
        { 'agents/x.md': 'x1', 'agents/gone.md': 'g1' },
      ),
      given: {},
    })
    const none = transferOf(p, { conflicts: {}, deletions: [] })
    expect(none.send.filter(s => s.profile === 'default')).toEqual([])
    expect(none.deletions).toEqual([])
    const all = transferOf(p, { conflicts: { 'default:agents/x.md': 'source' }, deletions: ['default:agents/gone.md'] })
    expect(all.send.filter(s => s.profile === 'default')).toEqual([
      { profile: 'default', from: 'agents/x.md', to: 'agents/x.md', merge: false },
    ])
    expect(all.deletions).toEqual([{ profile: 'default', from: 'agents/gone.md', to: 'agents/gone.md' }])
    expect(all.profiles.map(x => x.name)).toEqual(['default', 'work'])
    const onlyDefault = transferOf(
      { ...p, items: p.items.filter(i => i.profile !== 'work') },
      { conflicts: {}, deletions: [] },
    )
    expect(onlyDefault.profiles.map(x => x.name)).toEqual(['default'])
  })

  test('down: the server’s files to this PC, folders named as Windows names them', () => {
    const srvProject = project({
      folder: '-home-agent-work-board',
      path: '/home/agent/work/board',
      remote: 'git@github.com:MokuTeam/board.git',
      top: '/home/agent/work/board',
    })
    const p = buildPreview({
      id: 'p4',
      at: 4,
      direction: 'down',
      source: manifest(
        'linux',
        '/home/agent',
        [facts('default', '/home/agent/.claude', { 'projects/-home-agent-work-board/s9.jsonl': ['t9', 9] })],
        [srvProject],
      ),
      target: pc({}),
      given: {},
    })
    expect(p.items.map(i => i.to)).toEqual(['projects/C--migo-board/s9.jsonl'])
    expect(p.moves).toEqual([{ from: '/home/agent/work/board', to: 'C:\\migo\\board' }])
    expect(p.profiles).toEqual([{ name: 'default', create: false, dir: 'C:\\Users\\migo\\.claude' }])
  })

  test('grouped for the page: by area, a project’s folder its own; sizes in words', () => {
    expect(areaOf('projects/C--x/a/b.jsonl')).toBe('projects/C--x')
    expect(areaOf('skills/a/SKILL.md')).toBe('skills')
    expect(areaOf('CLAUDE.md')).toBe('.')
    const g = byArea([
      { from: 'skills/a', size: 1 },
      { from: 'CLAUDE.md', size: 2 },
      { from: 'skills/b', size: 3 },
    ])
    expect(g.map(x => [x.area, x.list.length, x.bytes])).toEqual([
      ['.', 1, 2],
      ['skills', 2, 4],
    ])
    expect(sizeOf(512)).toBe('512 B')
    expect(sizeOf(1.7 * 1024 ** 3)).toBe('1.7 GB')
    expect(targetRel('projects/a/x.jsonl', new Map([['a', 'b']]))).toBe('projects/b/x.jsonl')
    expect(targetRel('projects/c/x.jsonl', new Map())).toBeNull()
  })
})
