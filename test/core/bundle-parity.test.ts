// What a node needs of its profile beyond 9.1's first table (#602, #603): the owner's answers to
// notices a setting the bundle sends turns on, a hook's program by the programs the node has, and
// the data files a hook's script names beside it, held back and said. Pure, on fixtures of a
// Windows and a Linux master's profile with a Linux node.
import { describe, expect, test } from 'bun:test'
import {
  ACKNOWLEDGMENTS,
  acknowledgmentsOf,
  type BundleContext,
  buildManifest,
  bundleHash,
  classifySettings,
  dataFile,
  manifestOf,
  namedIn,
  PROFILE_DIR,
  type ProfileParts,
  programRule,
  type ReportEntry,
  secretKeysIn,
} from '../../src/core/bundle.ts'

const WIN: BundleContext = {
  from: 'win32',
  to: 'linux',
  profileDir: 'C:\\Users\\Owner\\.claude',
  home: 'C:\\Users\\Owner',
}
const LINUX: BundleContext = { from: 'linux', to: 'linux', profileDir: '/home/owner/.claude', home: '/home/owner' }
const CANARY = 'canary-parity-51d0'
const sha = (n: number): string => n.toString(16).padStart(64, '0')

const hook = (command: string, event = 'SessionStart') => ({
  hooks: { [event]: [{ hooks: [{ type: 'command', command }] }] },
})
const commands = (part: { hooks: Record<string, unknown[]> }): string[] =>
  Object.values(part.hooks).flatMap(list =>
    (list as { hooks: { command?: string }[] }[]).flatMap(e => e.hooks.map(h => h.command ?? '')),
  )
const lines = (report: ReportEntry[], why: string): ReportEntry[] => report.filter(e => e.why === why)
const parts = (over: Partial<ProfileParts> = {}): ProfileParts => ({
  files: [],
  skipped: [],
  followed: [],
  settings: {},
  mcpServers: {},
  ...over,
})
const board = { config: {}, sinks: {} }

describe("acknowledgments from the profile's .claude.json (#602)", () => {
  test('only the named keys, only when true', () => {
    const state = {
      codeModeCaveatsAcceptedV1: true,
      codeModeAutoModeCaveatAcceptedV1: true,
      bypassPermissionsModeAccepted: false,
      hasCompletedOnboarding: true,
      fullscreenUpsellSeenCount: 3,
      oauthAccount: { emailAddress: CANARY },
    }
    expect(acknowledgmentsOf(state)).toEqual(['codeModeAutoModeCaveatAcceptedV1', 'codeModeCaveatsAcceptedV1'])
    expect(acknowledgmentsOf({ codeModeCaveatsAcceptedV1: 'true' })).toEqual([])
    expect(acknowledgmentsOf(null)).toEqual([])
    expect(acknowledgmentsOf(JSON.parse('{"__proto__": {"codeModeCaveatsAcceptedV1": true}}'))).toEqual([])
  })

  test('carried in the manifest with a line each, saying what turns the notice on', () => {
    const m = buildManifest(
      parts({ acks: ['codeModeCaveatsAcceptedV1', 'codeModeAutoModeCaveatAcceptedV1'] }),
      board,
      LINUX,
    )
    expect(m.acks).toEqual(['codeModeAutoModeCaveatAcceptedV1', 'codeModeCaveatsAcceptedV1'])
    expect(lines(m.report, 'acknowledged')).toEqual([
      {
        kind: 'ack',
        name: 'codeModeAutoModeCaveatAcceptedV1',
        verdict: 'sent',
        why: 'acknowledged',
        detail: 'env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
      },
      {
        kind: 'ack',
        name: 'codeModeCaveatsAcceptedV1',
        verdict: 'sent',
        why: 'acknowledged',
        detail: 'env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE',
      },
    ])
  })

  test('a key the list does not name never travels, whatever the walk said', () => {
    const m = buildManifest(parts({ acks: ['hasCompletedOnboarding', 'codeModeCaveatsAcceptedV1'] }), board, LINUX)
    expect(m.acks).toEqual(['codeModeCaveatsAcceptedV1'])
  })

  test('a bundle without them has no acks and hashes as before; one with them hashes otherwise', () => {
    const plain = buildManifest(parts(), board, LINUX)
    expect('acks' in plain).toBe(false)
    const { acks: _none, ...without } = plain
    expect(bundleHash(plain)).toBe(bundleHash(without))
    const withAcks = buildManifest(parts({ acks: ['codeModeCaveatsAcceptedV1'] }), board, LINUX)
    expect(bundleHash(withAcks)).not.toBe(bundleHash(plain))
  })

  test("the node takes only keys of its own list from a commit's manifest", () => {
    const raw = {
      format: 1,
      files: [],
      settings: {},
      hooks: {},
      mcp: {},
      board: { sinks: {} },
      acks: ['codeModeCaveatsAcceptedV1', 'oauthAccount', '__proto__', 7, 'codeModeCaveatsAcceptedV1'],
    }
    expect(manifestOf(raw)?.acks).toEqual(['codeModeCaveatsAcceptedV1'])
    expect('acks' in (manifestOf({ ...raw, acks: undefined }) ?? {})).toBe(false)
    expect(Object.keys(ACKNOWLEDGMENTS).sort()).toEqual([
      'bypassPermissionsModeAccepted',
      'codeModeAutoModeCaveatAcceptedV1',
      'codeModeCaveatsAcceptedV1',
    ])
  })
})

describe("a hook's program against the node's (#603)", () => {
  const script = '/home/owner/.claude/mempalace-memory/save.py'
  const at = (programs?: readonly string[], ctx: BundleContext = LINUX): BundleContext =>
    programs ? { ...ctx, programs } : ctx

  test('python on a node with python3 and no python: written as python3, and said', () => {
    const part = classifySettings(hook(`python "${script}"`), at(['python3', 'bash']))
    expect(commands(part)).toEqual([`python3 "${PROFILE_DIR}/mempalace-memory/save.py"`])
    expect(lines(part.report, 'program-renamed')).toEqual([
      { kind: 'hook', name: 'save', verdict: 'translated', why: 'program-renamed', detail: 'python → python3' },
    ])
    expect(part.scripts).toEqual(['mempalace-memory/save.py'])
  })

  test('the same from a Windows master, with variables before it and the program quoted', () => {
    const part = classifySettings(
      hook('PYTHONUTF8=1 "python" "C:\\Users\\Owner\\.claude\\mempalace-memory\\save.py" --quiet'),
      at(['python3'], WIN),
    )
    expect(commands(part)).toEqual([`PYTHONUTF8=1 python3 "${PROFILE_DIR}/mempalace-memory/save.py" --quiet`])
  })

  test('a variable before it with a quoted value that holds a space', () => {
    const part = classifySettings(hook(`MSG="a b" PY='x y' python "${script}"`), at(['python3']))
    expect(commands(part)).toEqual([`MSG="a b" PY='x y' python3 "${PROFILE_DIR}/mempalace-memory/save.py"`])
  })

  test('a node that has python: sent as it is, no line about the program', () => {
    const part = classifySettings(hook(`python "${script}"`), at(['python', 'python3']))
    expect(commands(part)).toEqual([`python "${PROFILE_DIR}/mempalace-memory/save.py"`])
    expect(part.report.filter(e => e.why.startsWith('program-'))).toEqual([])
  })

  test('a program the node does not have at all: not sent, with the program, and its script stays', () => {
    const part = classifySettings(hook(`python "${script}"`), at(['bash']))
    expect(commands(part)).toEqual([])
    expect(part.report).toEqual([
      { kind: 'hook', name: 'save', verdict: 'not-sent', why: 'program-missing', detail: 'python' },
    ])
    expect(part.scripts).toEqual([])
  })

  test('py on a POSIX node is not renamed: not sent when the node lacks it', () => {
    const part = classifySettings(hook(`py "${script}"`), at(['python3']))
    expect(lines(part.report, 'program-missing')).toEqual([
      { kind: 'hook', name: 'save', verdict: 'not-sent', why: 'program-missing', detail: 'py' },
    ])
  })

  test('a node that did not say: sent as it is, and the report says the node may lack it', () => {
    const part = classifySettings(hook(`python "${script}"`), LINUX)
    expect(commands(part)).toEqual([`python "${PROFILE_DIR}/mempalace-memory/save.py"`])
    expect(lines(part.report, 'program-unchecked')).toEqual([
      { kind: 'hook', name: 'save', verdict: 'sent', why: 'program-unchecked', detail: 'python' },
    ])
    // A Windows node has python by that name, as the master does: nothing to say.
    const toWin = classifySettings(hook(`python "${script}"`), { ...LINUX, to: 'win32' })
    expect(lines(toWin.report, 'program-unchecked')).toEqual([])
  })

  test("a program in the profile's own folder, or one not in the list, is not this rule's", () => {
    const venv = classifySettings(hook(`/home/owner/.claude/venv/bin/python "${script}"`), at([]))
    expect(commands(venv)).toEqual([`${PROFILE_DIR}/venv/bin/python "${PROFILE_DIR}/mempalace-memory/save.py"`])
    expect(programRule('jq . x.json', at([]))).toEqual({ ok: true, command: 'jq . x.json' })
  })

  test('the status line goes by the same rule', () => {
    const part = classifySettings({ statusLine: { type: 'command', command: `python "${script}"` } }, at(['python3']))
    expect((part.settings.statusLine as { command: string }).command).toBe(
      `python3 "${PROFILE_DIR}/mempalace-memory/save.py"`,
    )
  })
})

describe('the data files a sent script names beside it (#603)', () => {
  test('which files are data files', () => {
    expect(['config.json', '.env', 'a.ini', 'b.toml', 'c.yaml', 'd.yml'].every(dataFile)).toBe(true)
    expect(['save.py', 'notes.md', 'json'].some(dataFile)).toBe(false)
  })

  test("named: the base name as a string in the script's text", () => {
    expect(namedIn('cfg = Path(__file__).parent / "config.json"', 'config.json')).toBe(true)
    expect(namedIn("open('./offsets.json')", 'offsets.json')).toBe(true)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a script's own template string
    expect(namedIn('read(`${dir}/config.json`)', 'config.json')).toBe(true)
    expect(namedIn('# reads config.json beside it', 'config.json')).toBe(false)
    expect(namedIn('open("myconfig.json")', 'config.json')).toBe(false)
    expect(namedIn('open("config.json.bak")', 'config.json')).toBe(false)
  })

  test('a secret: a key named like one that holds a value, in each format; names only', () => {
    expect(secretKeysIn(JSON.stringify({ user_name: 'o', url: 'https://m', token: CANARY }))).toEqual(['token'])
    expect(secretKeysIn(JSON.stringify({ server: { auth: { api_key: CANARY } } }))).toEqual(['api_key'])
    expect(secretKeysIn(`URL=https://m\nexport API_TOKEN="${CANARY}"\n`)).toEqual(['API_TOKEN'])
    expect(secretKeysIn(`[server]\npassword = ${CANARY}\n`)).toEqual(['password'])
    expect(secretKeysIn(`secret_key = "${CANARY}"\n`)).toEqual(['secret_key'])
    expect(secretKeysIn(`auth:\n  token: ${CANARY}\n`)).toEqual(['token'])
    expect(secretKeysIn(`servers:\n  - token: ${CANARY}\n`)).toEqual(['token'])
    expect(secretKeysIn(JSON.stringify({ token: CANARY })).join()).not.toContain(CANARY)
  })

  test('none: no such key, an empty value, a reference, a count of tokens', () => {
    expect(secretKeysIn(JSON.stringify({ offset: 42, last: 'abc' }))).toEqual([])
    expect(secretKeysIn(JSON.stringify({ token: '', password: null }))).toEqual([])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a reference in an env file
    expect(secretKeysIn('API_TOKEN=${API_TOKEN}\nMAX_THINKING_TOKENS=8000\n')).toEqual([])
    expect(secretKeysIn('# token = x\n; key = y\n')).toEqual([])
  })

  test('held back from the files and said: needs-secret with its path, or not-sent as maybe the script own state', () => {
    const files = [
      { path: 'mempalace-memory/save.py', sha256: sha(1), mode: 0o644 },
      { path: 'skills/memo/SKILL.md', sha256: sha(2), mode: 0o644 },
      { path: 'skills/memo/config.json', sha256: sha(3), mode: 0o644 },
    ]
    const m = buildManifest(
      parts({
        files,
        settings: hook('python3 "/home/owner/.claude/mempalace-memory/save.py"'),
        beside: [
          { path: 'mempalace-memory/config.json', script: 'mempalace-memory/save.py', secret: true },
          { path: 'mempalace-memory/offsets.json', script: 'mempalace-memory/save.py', secret: false },
          { path: 'skills/memo/config.json', script: 'skills/memo/run.py', secret: true },
        ],
      }),
      board,
      LINUX,
    )
    expect(m.files.map(f => f.path)).toEqual(['mempalace-memory/save.py', 'skills/memo/SKILL.md'])
    expect(m.report.filter(e => e.why === 'secret-file' || e.why === 'script-state')).toEqual([
      {
        kind: 'file',
        name: 'mempalace-memory/config.json',
        verdict: 'needs-secret',
        why: 'secret-file',
        detail: 'mempalace-memory/save.py',
      },
      {
        kind: 'file',
        name: 'mempalace-memory/offsets.json',
        verdict: 'not-sent',
        why: 'script-state',
        detail: 'mempalace-memory/save.py',
      },
      {
        kind: 'file',
        name: 'skills/memo/config.json',
        verdict: 'needs-secret',
        why: 'secret-file',
        detail: 'skills/memo/run.py',
      },
    ])
  })

  test("one the hook's command names itself is that hook's file and travels as before", () => {
    const files = [
      { path: 'hooks/run.py', sha256: sha(1), mode: 0o644 },
      { path: 'hooks/rules.json', sha256: sha(2), mode: 0o644 },
    ]
    const m = buildManifest(
      parts({
        files,
        settings: hook('python3 /home/owner/.claude/hooks/run.py /home/owner/.claude/hooks/rules.json'),
        beside: [{ path: 'hooks/rules.json', script: 'hooks/run.py', secret: false }],
      }),
      board,
      LINUX,
    )
    expect(m.files.map(f => f.path)).toEqual(['hooks/rules.json', 'hooks/run.py'])
    expect(m.report.some(e => e.why === 'script-state')).toBe(false)
  })

  test('one without a secret in a folder that travels whole goes with it, as before', () => {
    const files = [
      { path: 'skills/mem/SKILL.md', sha256: sha(1), mode: 0o644 },
      { path: 'skills/mem/hook.py', sha256: sha(2), mode: 0o644 },
      { path: 'skills/mem/patterns.json', sha256: sha(3), mode: 0o644 },
    ]
    const m = buildManifest(
      parts({
        files,
        settings: hook('python3 /home/owner/.claude/skills/mem/hook.py'),
        beside: [{ path: 'skills/mem/patterns.json', script: 'skills/mem/hook.py', secret: false }],
      }),
      board,
      LINUX,
    )
    expect(m.files.map(f => f.path)).toEqual(['skills/mem/SKILL.md', 'skills/mem/hook.py', 'skills/mem/patterns.json'])
    expect(m.report.some(e => e.why === 'script-state')).toBe(false)
  })
})
