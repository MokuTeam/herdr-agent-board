// Wake's herdr calls (src/adapters/wake-herdr.ts): each one the herdr command herdr-wake's
// router.mjs made, run against the compiled fake herdr; and the pane's shell as herdr reports it.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { asProcessInfo } from '../../src/adapters/wake-herdr.ts'
import { clearKeyFor } from '../../src/core/wake/rules.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(30_000)

const SID = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'

describe('the pane’s shell', () => {
  test('the foreground process that is the shell, by name lower-cased without .exe', () => {
    const foreground = [
      { pid: 10, name: 'PWSH.EXE' },
      { pid: 11, name: 'claude' },
    ]
    expect(asProcessInfo({ process_info: { shell_pid: 10, foreground_processes: foreground } })).toEqual({
      shellPid: 10,
      foreground,
      shell: 'pwsh',
    })
    expect(asProcessInfo({ process_info: { shell_pid: 12, foreground_processes: foreground } })).toEqual({
      shellPid: 12,
      foreground,
      shell: null,
    })
    expect(asProcessInfo({ process_info: { shell_pid: null, foreground_processes: foreground } }).shell).toBe(null)
  })

  test('a path or a login shell’s dash is not part of the name, so the line is cleared by the shell it is', () => {
    const shellOf = (name: string): string | null =>
      asProcessInfo({ process_info: { shell_pid: 7, foreground_processes: [{ pid: 7, name }] } }).shell
    expect(shellOf('C:\\Program Files\\Git\\usr\\bin\\bash.exe')).toBe('bash')
    expect(shellOf('-bash')).toBe('bash')
    expect(shellOf('-zsh')).toBe('zsh')
    expect(shellOf('/usr/bin/zsh')).toBe('zsh')
    expect(shellOf('C:\\Windows\\System32\\cmd.exe')).toBe('cmd')
    expect(shellOf('C:/Program Files/PowerShell/7/pwsh.exe')).toBe('pwsh')
    expect(shellOf('powershell.exe')).toBe('powershell')
    expect(shellOf('')).toBe(null)
    expect(shellOf('-')).toBe(null)
    // Esc on a bash prompt would type the line after an escape: the clear key goes by the shell.
    expect(clearKeyFor(shellOf('C:\\Program Files\\Git\\usr\\bin\\bash.exe'), 'win32')).toBe('ctrl+u')
    expect(clearKeyFor(shellOf('-bash'), 'win32')).toBe('ctrl+u')
    expect(clearKeyFor(shellOf('C:\\Windows\\System32\\cmd.exe'), 'linux')).toBe('esc')
  })

  test('foreground processes without a number pid are left out, extra fields too; one without a name is kept as ""', () => {
    const info = asProcessInfo({
      process_info: {
        shell_pid: '10',
        foreground_processes: [
          { pid: 10, name: 'bash', cmdline: 'bash -l' },
          { pid: '11', name: 'x' },
          { pid: 12 },
          { pid: 13, name: null },
          null,
        ],
        extra: true,
      },
    })
    expect(info).toEqual({
      shellPid: null,
      foreground: [
        { pid: 10, name: 'bash' },
        { pid: 12, name: '' },
        { pid: 13, name: '' },
      ],
      shell: null,
    })
    expect(asProcessInfo({ process_info: {} })).toEqual({ shellPid: null, foreground: [], shell: null })
  })

  test('a program herdr gives no name is still a program in the foreground, beside the shell', () => {
    const info = asProcessInfo({
      process_info: { shell_pid: 10, foreground_processes: [{ pid: 10, name: 'bash' }, { pid: 11 }] },
    })
    expect(info).toEqual({
      shellPid: 10,
      foreground: [
        { pid: 10, name: 'bash' },
        { pid: 11, name: '' },
      ],
      shell: 'bash',
    })
    // The shell itself without a name: its pid is still the shell's, its name not known.
    expect(asProcessInfo({ process_info: { shell_pid: 10, foreground_processes: [{ pid: 10 }] } })).toEqual({
      shellPid: 10,
      foreground: [{ pid: 10, name: '' }],
      shell: null,
    })
  })

  test('an answer without process_info is an error, never a pane taken for free', () => {
    expect(() => asProcessInfo(null)).toThrow(/process_info/)
    expect(() => asProcessInfo({ process_info: [] })).toThrow(/process_info/)
    expect(() => asProcessInfo({ result: {} })).toThrow(/process_info/)
  })
})

/** One method of cliWakeHerdr in a child against the fake herdr: its exit code and the result it printed. */
async function call(box: Sandbox, method: string, ...args: unknown[]): Promise<{ code: number | null; out: unknown }> {
  const done = await box.run('wake-io', { method, args }).exited
  return { code: done.code, out: done.code === 0 ? JSON.parse(done.stdout) : done.stderr }
}

const PANE = { pane_id: 'w1:p1', tab_id: 't1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' }

describe('cliWakeHerdr', () => {
  test('each call is the herdr command herdr-wake made', async () => {
    const box = await sandbox()
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            workspaces: [{ workspace_id: 'w1', label: 'Счета 100%' }],
            tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
            panes: [{ ...PANE, agent_session: { value: SID }, cwd: 'C:\\Work\\Проект x 50%' }],
            agents: [{ pane_id: 'w1:p1', agent: 'claude' }],
          },
        },
      },
      'pane get': { result: { pane: { ...PANE, agent_status: 7 } } },
      'agent get': {
        result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: SID }, name: 'billing' } },
      },
      'pane process-info': {
        result: {
          process_info: {
            shell_pid: 10,
            foreground_processes: [{ pid: 10, name: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' }],
          },
        },
      },
      'pane run': {},
      'pane send-keys': {},
      'pane send-text': {},
      'pane rename': {},
      'agent prompt': {},
      'pane read': { text: 'the visible screen\n' },
      'agent read': { text: '❯ a draft\n' },
    })

    const line = `board resume ${SID} --profile work`
    const results = [
      await call(box, 'snapshot'),
      await call(box, 'pane', 'w1:p1'),
      await call(box, 'agent', 'w1:p1'),
      await call(box, 'processInfo', 'w1:p1'),
      await call(box, 'sendKeys', 'w1:p1', 'ctrl+u'),
      await call(box, 'run', 'w1:p1', line),
      await call(box, 'sendText', 'w1:p1', line),
      await call(box, 'rename', 'w1:p1', '💤 Счета 100% "x"'),
      await call(box, 'rename', 'w1:p1', null),
      await call(box, 'prompt', 'w1:p1', '/exit'),
      await call(box, 'prompt', 'w1:p1', '-x'),
      await call(box, 'screen', 'w1:p1'),
      await call(box, 'inputBox', 'w1:p1'),
    ]
    expect(box.calls()).toEqual([
      ['api', 'snapshot'],
      ['pane', 'get', 'w1:p1'],
      ['agent', 'get', 'w1:p1'],
      ['pane', 'process-info', '--pane', 'w1:p1'],
      ['pane', 'send-keys', 'w1:p1', 'ctrl+u'],
      ['pane', 'run', 'w1:p1', line],
      ['pane', 'send-text', 'w1:p1', line],
      ['pane', 'rename', 'w1:p1', '💤 Счета 100% "x"'],
      ['pane', 'rename', 'w1:p1', '--clear'],
      ['agent', 'prompt', 'w1:p1', '/exit'],
      ['agent', 'prompt', 'w1:p1', ' -x'],
      ['pane', 'read', 'w1:p1', '--source', 'visible'],
      ['agent', 'read', 'w1:p1', '--source', 'recent', '--lines', '40', '--ansi'],
    ])
    expect(results.map(r => r.code)).toEqual(results.map(() => 0))
    expect(results.map(r => r.out)).toEqual([
      {
        workspaces: [{ workspace_id: 'w1', label: 'Счета 100%' }],
        tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
        panes: [{ ...PANE, agent_session: { value: SID }, cwd: 'C:\\Work\\Проект x 50%' }],
        agents: [{ pane_id: 'w1:p1', agent: 'claude' }],
      },
      { pane_id: 'w1:p1', tab_id: 't1', workspace_id: 'w1', agent: 'claude' },
      { kind: 'claude', status: 'idle', session: SID, name: 'billing' },
      { shellPid: 10, foreground: [{ pid: 10, name: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' }], shell: 'bash' },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'the visible screen\n',
      '❯ a draft\n',
    ])
  })

  test('a pane herdr no longer has is none; another herdr error is passed on', async () => {
    const box = await sandbox()
    box.state({
      'pane get': { error: 'pane w1:p9 not found', code: 'pane_not_found' },
      'agent get': { error: 'pane w1:p9 not found', code: 'pane_not_found' },
      'pane process-info': { error: 'herdr is busy', code: 'internal' },
      'pane read': { error: 'pane w1:p9 not found', code: 'pane_not_found' },
    })
    expect(await call(box, 'pane', 'w1:p9')).toEqual({ code: 0, out: null })
    expect(await call(box, 'agent', 'w1:p9')).toEqual({ code: 0, out: null })
    const busy = await call(box, 'processInfo', 'w1:p9')
    expect(busy.code).not.toBe(0)
    expect(String(busy.out)).toContain('herdr is busy')
    // Reading a screen that is gone is an error: there is no empty screen to take for it.
    expect((await call(box, 'screen', 'w1:p9')).code).not.toBe(0)
  })
})
