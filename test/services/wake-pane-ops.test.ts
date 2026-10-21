// Waking a session in its pane and putting one to sleep there (src/services/wake/pane-ops.ts),
// against the in-memory fake herdr and a fake clock: the one line typed (board resume with the
// profile, no cd), the key that clears the prompt first by the pane's shell, the dialogs answered
// or left to the user, and the panes never typed into.
import { describe, expect, test } from 'bun:test'
import { putToSleep, type SleepMarks, waitReady, wakeInPane, withPane } from '../../src/services/wake/pane-ops.ts'
import { type FakePane, type FakeWakeHerdr, fakeWakeHerdr } from '../support/fake-wake-herdr.ts'

const SID = '0f3c9a7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b'
const SID2 = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d'
const NAME = 'Счёт 50% fix'

/** A clock that moves on at once by what is slept, with the log lines kept. */
function fakeClock() {
  const c = {
    at: 1_000_000,
    lines: [] as string[],
    now: () => c.at,
    sleep: (ms: number) => {
      c.at += ms
      return Promise.resolve()
    },
    log: (text: string) => {
      c.lines.push(text)
    },
  }
  return c
}

/** A pane at a shell prompt, in a folder with spaces, Cyrillic and %. */
const shellPane = (): FakePane => ({ pane_id: 'p1', tab_id: 't1', workspace_id: 'w1', cwd: 'C:\\Work\\Проект x 50%' })
const claudePane = (session = SID, status = 'idle'): FakePane => ({
  ...shellPane(),
  agent: 'claude',
  agent_status: status,
  agent_session: { value: session },
})

// Claude Code's input box as `herdr agent read --ansi` captures it.
const RULE = `\x1b[38;2;136;136;136m${'─'.repeat(60)}\x1b[0m`
const box = (input: string): string => ['● done', '', RULE, input, RULE, '  ⏵⏵ bypass permissions on'].join('\n')
const EMPTY_BOX = box(`❯ \x1b[2mTry "fix the tests"\x1b[0m`)

const CHANNELS =
  '  WARNING: Loading development channels\n\n  Channels: server:telegram\n\n  ❯ 1. I am using this for local development\n    2. Exit'
const TRUST =
  ' Accessing workspace:\n\n C:/Work/Проект x 50%\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel'
const EXIT_TASKS =
  '   The following will stop when you exit:\n\n   shell · node watch-wait\n\n   ❯ 1. Exit and stop tasks\n     2. Move to background and exit\n     3. Stay'

const is =
  (...words: string[]) =>
  (argv: string[]) =>
    words.every((w, i) => argv[i] === w)
const indexOf = (io: FakeWakeHerdr, argv: string[]): number =>
  io.calls.findIndex(c => JSON.stringify(c) === JSON.stringify(argv))
const typed = (io: FakeWakeHerdr): string[][] =>
  io.calls.filter(c => ['run', 'send-keys', 'send-text', 'prompt'].includes(c[1] ?? ''))

/** Claude comes up in the pane once the line is run, `status` at first. */
function startsOnRun(io: FakeWakeHerdr, pane: FakePane, status = 'idle', screen = ''): void {
  io.on(is('pane', 'run'), () => {
    pane.agent = 'claude'
    pane.agent_status = status
    pane.agent_session = { value: SID }
    io.screens[pane.pane_id] = screen
  })
}

function recorder() {
  const seen: string[] = []
  const marks: SleepMarks = {
    going: now => {
      seen.push(`going ${now}`)
    },
    slept: now => {
      seen.push(`slept ${now}`)
    },
    stayed: () => {
      seen.push('stayed')
    },
  }
  return { seen, marks }
}

describe('waking in a pane', () => {
  test('wake types board resume with the profile into the pane, after clearing the line by its shell', async () => {
    // The OS is the other one each time: the key goes by the shell. Git Bash on Windows as herdr names it.
    const cases: [string, string, string][] = [
      ['pwsh', 'esc', 'linux'],
      ['cmd', 'esc', 'linux'],
      ['bash', 'ctrl+u', 'win32'],
      ['zsh', 'ctrl+u', 'win32'],
      ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'ctrl+u', 'win32'],
    ]
    for (const [shell, key, platform] of cases) {
      const pane = shellPane()
      const io = fakeWakeHerdr({ panes: [pane], shells: { p1: shell } })
      startsOnRun(io, pane)
      const out = await wakeInPane(
        io,
        { pane: 'p1', session: SID, profile: 'work' },
        { ...fakeClock(), timeoutMs: 120_000, platform },
      )
      expect(out).toEqual({ ok: true })
      const clear = indexOf(io, ['pane', 'send-keys', 'p1', key])
      const run = indexOf(io, ['pane', 'run', 'p1', `board resume ${SID} --profile work`])
      expect(clear).toBeGreaterThanOrEqual(0)
      expect(run).toBeGreaterThan(clear)
      expect(typed(io)).toHaveLength(2)
      expect(io.calls.some(argv => argv.some(word => word.includes('cd ')))).toBe(false)
    }
  })

  test('without a profile id the line has no --profile; an unknown shell is cleared by the OS, as today', async () => {
    for (const [platform, key] of [
      ['win32', 'esc'],
      ['linux', 'ctrl+u'],
    ] as const) {
      const pane = shellPane()
      const io = fakeWakeHerdr({ panes: [pane], shells: { p1: 'nu' } })
      startsOnRun(io, pane)
      const out = await wakeInPane(io, { pane: 'p1', session: SID }, { ...fakeClock(), timeoutMs: 10_000, platform })
      expect(out).toEqual({ ok: true })
      expect(typed(io)).toEqual([
        ['pane', 'send-keys', 'p1', key],
        ['pane', 'run', 'p1', `board resume ${SID}`],
      ])
    }
  })

  test('a pane running another program is not typed into', async () => {
    const io = fakeWakeHerdr({ panes: [shellPane()], shells: { p1: 'bash' } })
    io.busy.add('p1')
    const out = await wakeInPane(io, { pane: 'p1', session: SID, profile: 'work' }, { ...fakeClock(), timeoutMs: 1000 })
    expect(out).toEqual({ ok: false, why: 'busy', error: 'its pane runs another program' })
    expect(io.calls).toEqual([['pane', 'process-info', '--pane', 'p1']])
  })

  test('a pane whose shell herdr does not show is not typed into either', async () => {
    const io = fakeWakeHerdr({ panes: [shellPane()] })
    const unknown: FakeWakeHerdr = {
      ...io,
      processInfo: async pane => {
        await io.processInfo(pane)
        return { shellPid: null, foreground: [], shell: null }
      },
    }
    const out = await wakeInPane(unknown, { pane: 'p1', session: SID }, { ...fakeClock(), timeoutMs: 1000 })
    expect(out).toMatchObject({ ok: false, why: 'busy' })
    expect(typed(io)).toEqual([])
  })

  test('pi’s and Codex’s keys never reach board resume', async () => {
    const io = fakeWakeHerdr({ panes: [shellPane()], shells: { p1: 'pwsh' } })
    const out = await wakeInPane(io, { pane: 'p1', session: 'pane-p1' }, { ...fakeClock(), timeoutMs: 1000 })
    expect(out).toMatchObject({ ok: false, why: 'line' })
    expect(io.calls).toEqual([])
  })

  test('a profile id the line cannot carry is not woken at all, rather than in the default profile', async () => {
    for (const profile of ['my work', 'Работа', 'work;rm', '']) {
      const io = fakeWakeHerdr({ panes: [shellPane()], shells: { p1: 'pwsh' } })
      const out = await wakeInPane(io, { pane: 'p1', session: SID, profile }, { ...fakeClock(), timeoutMs: 1000 })
      expect(out).toMatchObject({ ok: false, why: 'line' })
      expect(io.calls).toEqual([])
    }
  })

  test('the development-channels warning is answered, the trust question is left to the user', async () => {
    // The warning: Enter, then Claude is ready.
    const pane = shellPane()
    const io = fakeWakeHerdr({ panes: [pane], shells: { p1: 'pwsh' } })
    startsOnRun(io, pane, 'blocked', CHANNELS)
    io.on(is('pane', 'send-keys', 'p1', 'enter'), () => {
      pane.agent_status = 'idle'
      io.screens.p1 = ''
    })
    const c = fakeClock()
    expect(await wakeInPane(io, { pane: 'p1', session: SID }, { ...c, timeoutMs: 120_000 })).toEqual({ ok: true })
    expect(io.calls.filter(is('pane', 'send-keys', 'p1', 'enter'))).toHaveLength(1)
    expect(c.lines).toContain('confirming the development channels warning in p1')

    // The trust question: no key pressed, the user is told to answer it.
    const pane2 = shellPane()
    const io2 = fakeWakeHerdr({ panes: [pane2], shells: { p1: 'pwsh' } })
    startsOnRun(io2, pane2, 'blocked', TRUST)
    expect(await wakeInPane(io2, { pane: 'p1', session: SID }, { ...fakeClock(), timeoutMs: 120_000 })).toEqual({
      ok: false,
      why: 'trust',
      error: 'it asks whether to trust the folder: answer in its terminal',
    })
    expect(io2.calls.filter(is('pane', 'send-keys', 'p1', 'enter'))).toEqual([])

    // Any other question: left to the user too.
    const pane3 = shellPane()
    const io3 = fakeWakeHerdr({ panes: [pane3], shells: { p1: 'pwsh' } })
    startsOnRun(io3, pane3, 'blocked', 'Do you want to proceed?\n❯ 1. Yes\n  2. No')
    expect(await wakeInPane(io3, { pane: 'p1', session: SID }, { ...fakeClock(), timeoutMs: 120_000 })).toEqual({
      ok: false,
      why: 'blocked',
      error: 'it waits for an answer in its terminal',
    })
    expect(io3.calls.filter(is('pane', 'send-keys', 'p1', 'enter'))).toEqual([])
  })

  test('a warning that does not go away gets Enter at most 3 times, 5 s apart', async () => {
    const io = fakeWakeHerdr({ panes: [claudePane(SID, 'blocked')], screens: { p1: CHANNELS } })
    const c = fakeClock()
    const at: number[] = []
    io.on(is('pane', 'send-keys', 'p1', 'enter'), () => at.push(c.at))
    expect(await waitReady(io, 'p1', 120_000, c)).toBe('blocked')
    expect(at).toHaveLength(3)
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(5000)
    expect((at[2] ?? 0) - (at[1] ?? 0)).toBeGreaterThanOrEqual(5000)
  })

  test('Claude that does not come up in time: the wake times out, polled every 1.5 s', async () => {
    const io = fakeWakeHerdr({ panes: [shellPane()], shells: { p1: 'pwsh' } })
    const c = fakeClock()
    const start = c.at
    const out = await wakeInPane(io, { pane: 'p1', session: SID }, { ...c, timeoutMs: 15_000 })
    expect(out).toEqual({ ok: false, why: 'timeout', error: 'it did not start in time' })
    expect(c.at - start).toBe(15_000)
    expect(io.calls.filter(is('pane', 'get', 'p1'))).toHaveLength(10)
  })
})

describe('putting to sleep in a pane', () => {
  test('put to sleep: /exit, the pane renamed 💤 <name>, the wake line typed at its prompt, not run', async () => {
    const pane = claudePane()
    const io = fakeWakeHerdr({ panes: [pane], shells: { p1: 'pwsh' }, inputBoxes: { p1: EMPTY_BOX } })
    const c = fakeClock()
    const when: number[] = []
    io.on(
      () => true,
      () => when.push(c.at),
    )
    // Claude shows for two more looks after /exit, then the shell has the pane.
    let looks = -1
    io.on(is('agent', 'prompt'), () => {
      looks = 0
    })
    io.on(is('pane', 'get', 'p1'), () => {
      if (looks >= 0 && ++looks > 2) pane.agent = null
    })
    const { seen, marks } = recorder()
    const start = c.at

    expect(await putToSleep(io, { pane: 'p1', session: SID, name: NAME, profile: 'work' }, marks, c)).toBe(true)

    const exit = indexOf(io, ['agent', 'prompt', 'p1', '/exit'])
    const rename = indexOf(io, ['pane', 'rename', 'p1', `💤 ${NAME}`])
    const line = indexOf(io, ['pane', 'send-text', 'p1', `board resume ${SID} --profile work`])
    expect(exit).toBeGreaterThan(0)
    expect(rename).toBeGreaterThan(exit)
    expect(line).toBeGreaterThan(rename)
    expect((when[line] ?? 0) - (when[rename] ?? 0)).toBe(500)
    expect(io.calls.filter(is('pane', 'run'))).toEqual([])
    expect(seen).toEqual([`going ${start}`, `slept ${start + 2000}`])
    expect(pane.label).toBe(`💤 ${NAME}`)
  })

  test('the line is not typed where another program took the pane after /exit; it is asleep all the same', async () => {
    const pane = claudePane()
    const io = fakeWakeHerdr({ panes: [pane], shells: { p1: 'bash' }, inputBoxes: { p1: EMPTY_BOX } })
    io.on(is('agent', 'prompt'), () => {
      pane.agent = null
      io.busy.add('p1')
    })
    const { seen, marks } = recorder()
    expect(await putToSleep(io, { pane: 'p1', session: SID, name: NAME }, marks, fakeClock())).toBe(true)
    expect(io.calls.filter(is('pane', 'send-text'))).toEqual([])
    expect(seen.map(s => s.split(' ')[0])).toEqual(['going', 'slept'])
  })

  test('a draft, a busy session, or another session in the pane is never put to sleep', async () => {
    const cases: [string, FakePane | null, string][] = [
      ['a draft', claudePane(), box('❯ half a thought')],
      ['an input box it cannot read (a dialog)', claudePane(), 'Do you want to proceed?\n❯ 1. Yes\n  2. No'],
      ['a box with a dialog under it', claudePane(), `${EMPTY_BOX}\n Enter to confirm · Esc to cancel`],
      ['nothing captured', claudePane(), ''],
      ['a busy session', claudePane(SID, 'working'), EMPTY_BOX],
      ['a session waiting for an answer', claudePane(SID, 'blocked'), EMPTY_BOX],
      ['another session in the pane', claudePane(SID2), EMPTY_BOX],
      ['pi in the pane', { ...claudePane(), agent: 'pi' }, EMPTY_BOX],
      ['a shell', shellPane(), EMPTY_BOX],
      ['no such pane', null, EMPTY_BOX],
    ]
    for (const [what, pane, inputBox] of cases) {
      const io = fakeWakeHerdr({ panes: pane ? [pane] : [], inputBoxes: { p1: inputBox } })
      const { seen, marks } = recorder()
      const slept = await putToSleep(io, { pane: 'p1', session: SID, name: NAME }, marks, fakeClock())
      expect({ what, slept, typed: typed(io), seen }).toEqual({ what, slept: false, typed: [], seen: [] })
    }
  })

  test('a session the wake line could not bring back in its profile is never put to sleep', async () => {
    for (const target of [
      { pane: 'p1', session: SID, name: NAME, profile: 'my work' },
      { pane: 'p1', session: 'pane-p1', name: NAME },
    ]) {
      const io = fakeWakeHerdr({
        panes: [claudePane(target.session)],
        inputBoxes: { p1: EMPTY_BOX },
      })
      const { seen, marks } = recorder()
      expect(await putToSleep(io, target, marks, fakeClock())).toBe(false)
      expect(io.calls).toEqual([])
      expect(seen).toEqual([])
    }
  })

  test('background tasks on /exit: Esc, and it stays up', async () => {
    const pane = claudePane()
    const io = fakeWakeHerdr({ panes: [pane], inputBoxes: { p1: EMPTY_BOX } })
    io.on(is('agent', 'prompt'), () => {
      pane.agent_status = 'blocked'
      io.screens.p1 = EXIT_TASKS
    })
    const { seen, marks } = recorder()
    const c = fakeClock()
    expect(await putToSleep(io, { pane: 'p1', session: SID, name: NAME }, marks, c)).toBe(false)
    expect(typed(io)).toEqual([
      ['agent', 'prompt', 'p1', '/exit'],
      ['pane', 'send-keys', 'p1', 'esc'],
    ])
    expect(io.calls.filter(is('pane', 'rename'))).toEqual([])
    expect(seen).toEqual([`going ${1_000_000}`, 'stayed'])
    expect(c.lines).toContain(`${NAME} in p1 has background tasks, left it running`)
  })

  test('Claude still there 30 s after /exit, or herdr failing on the way: it stays up', async () => {
    const io = fakeWakeHerdr({ panes: [claudePane()], inputBoxes: { p1: EMPTY_BOX } })
    const { seen, marks } = recorder()
    const c = fakeClock()
    expect(await putToSleep(io, { pane: 'p1', session: SID, name: NAME }, marks, c)).toBe(false)
    expect(c.at - 1_000_000).toBe(30_000)
    expect(seen).toEqual([`going ${1_000_000}`, 'stayed'])
    expect(io.calls.filter(is('pane', 'rename'))).toEqual([])

    const io2 = fakeWakeHerdr({ panes: [claudePane()], inputBoxes: { p1: EMPTY_BOX } })
    io2.on(is('agent', 'prompt'), () => {
      throw new Error('herdr went away')
    })
    const r2 = recorder()
    await expect(putToSleep(io2, { pane: 'p1', session: SID, name: NAME }, r2.marks, fakeClock())).rejects.toThrow(
      'herdr went away',
    )
    expect(r2.seen).toEqual([`going ${1_000_000}`, 'stayed'])
  })
})

describe('one operation per pane', () => {
  test('two operations on one pane run one after the other', async () => {
    const order: string[] = []
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const first = withPane('lock-a', async () => {
      order.push('first in')
      await gate
      order.push('first out')
      throw new Error('first failed')
    })
    const second = withPane('lock-a', async () => {
      order.push('second')
      return 2
    })
    const other = withPane('lock-b', async () => {
      order.push('other pane')
      return 3
    })
    expect(await other).toBe(3)
    expect(order).toEqual(['first in', 'other pane'])
    release()
    await expect(first).rejects.toThrow('first failed')
    expect(await second).toBe(2)
    expect(order).toEqual(['first in', 'other pane', 'first out', 'second'])

    // Putting to sleep holds the pane too: nothing is asked of herdr while another operation has it.
    const io = fakeWakeHerdr({ panes: [claudePane()], inputBoxes: { p1: EMPTY_BOX } })
    let free = () => {}
    const held = withPane(
      'p1',
      () =>
        new Promise<void>(resolve => {
          free = resolve
        }),
    )
    const sleeping = putToSleep(io, { pane: 'p1', session: SID, name: NAME }, recorder().marks, fakeClock())
    await Bun.sleep(5)
    expect(io.calls).toEqual([])
    free()
    await held
    expect(await sleeping).toBe(false) // Claude never leaves in this fake: what matters is that it ran after
    expect(io.calls[0]).toEqual(['pane', 'get', 'p1'])
  })
})
