// An in-memory herdr for wake's tests: its panes, workspaces and tabs as plain objects, each call
// recorded as the argv cliWakeHerdr (src/adapters/wake-herdr.ts) runs for it, each answer read
// through the same narrowing (asSnapshot, asPane, asAgent, asProcessInfo). The state is the very
// objects the test gave, changed in place, so a test moves the pane on itself, or through on():
// an effect run on each matching call right after it is recorded and before the call reads or
// changes anything (Claude leaving on /exit, the screen a wake brings, herdr failing).
import { asAgent, asPane, asSnapshot, HerdrError, type HerdrPane } from '../../src/adapters/herdr.ts'
import { asProcessInfo, type WakeHerdr } from '../../src/adapters/wake-herdr.ts'

/** A pane as herdr's snapshot shows it; `label` is what `pane rename` set. */
export interface FakePane {
  pane_id: string
  tab_id?: string
  workspace_id?: string
  agent?: string | null
  agent_status?: string
  agent_session?: { value: string } | null
  cwd?: string
  terminal_title_stripped?: string
  focused?: boolean
  label?: string
}

export interface FakeWakeHerdr extends WakeHerdr {
  /** Each call as herdr's argv. */
  calls: string[][]
  panes: FakePane[]
  workspaces: { workspace_id: string; label?: string }[]
  tabs: { tab_id: string; workspace_id: string; label?: string; number?: number }[]
  /**
   * Pane → its shell's process name as herdr reports it (`pwsh.exe`, `-bash`, a path); none: herdr
   * lists no foreground process, so a pane with no entry and not in `busy` counts as at the prompt
   * (cleared by the OS's key).
   */
  shells: Record<string, string>
  /** Panes whose foreground runs another program than their shell. */
  busy: Set<string>
  /** Pane → its visible screen (`pane read`); none: ''. */
  screens: Record<string, string>
  /** Pane → its ANSI capture (`agent read --ansi`); none: '' (no input box to read). */
  inputBoxes: Record<string, string>
  on(match: (argv: string[]) => boolean, effect: (argv: string[]) => void): void
}

/** Every pane's shell pid; a busy pane's foreground program has the next one. */
const SHELL_PID = 4000

export function fakeWakeHerdr(
  init: Partial<Pick<FakeWakeHerdr, 'panes' | 'workspaces' | 'tabs' | 'shells' | 'screens' | 'inputBoxes'>> = {},
): FakeWakeHerdr {
  const effects: { match: (argv: string[]) => boolean; effect: (argv: string[]) => void }[] = []

  /** Records the call, then runs the effects that match it. */
  const call = (...argv: string[]): void => {
    fake.calls.push(argv)
    for (const e of effects) if (e.match(argv)) e.effect(argv)
  }
  const find = (pane: string): FakePane | undefined => fake.panes.find(p => p.pane_id === pane)
  /** The pane, or herdr's error for one it does not have. */
  const need = (pane: string, argv: string[]): FakePane => {
    const p = find(pane)
    if (!p) throw new HerdrError(argv, 'pane_not_found', `pane ${pane} not found`)
    return p
  }
  const asHerdr = (p: FakePane): HerdrPane | null => asPane(structuredClone(p))

  const fake: FakeWakeHerdr = {
    calls: [],
    panes: init.panes ?? [],
    workspaces: init.workspaces ?? [],
    tabs: init.tabs ?? [],
    shells: init.shells ?? {},
    busy: new Set(),
    screens: init.screens ?? {},
    inputBoxes: init.inputBoxes ?? {},
    on(match, effect) {
      effects.push({ match, effect })
    },

    async snapshot() {
      call('api', 'snapshot')
      const focused = fake.panes.find(p => p.focused)?.pane_id
      return asSnapshot({
        snapshot: structuredClone({
          workspaces: fake.workspaces,
          tabs: fake.tabs,
          panes: fake.panes,
          ...(focused && { focused_pane_id: focused }),
        }),
      })
    },
    async pane(pane) {
      call('pane', 'get', pane)
      const p = find(pane)
      return p ? asHerdr(p) : null
    },
    async agent(pane) {
      call('agent', 'get', pane)
      const p = find(pane)
      if (!p?.agent) return null
      return asAgent({
        agent: { pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status, agent_session: p.agent_session },
      })
    },
    async processInfo(pane) {
      const argv = ['pane', 'process-info', '--pane', pane]
      call(...argv)
      need(pane, argv)
      const shell = fake.shells[pane]
      const foreground = fake.busy.has(pane)
        ? [{ pid: SHELL_PID + 1, name: 'node' }]
        : shell === undefined
          ? []
          : [{ pid: SHELL_PID, name: shell }]
      return asProcessInfo({ process_info: { shell_pid: SHELL_PID, foreground_processes: foreground } })
    },
    async run(pane, line) {
      const argv = ['pane', 'run', pane, line]
      call(...argv)
      need(pane, argv)
    },
    async sendKeys(pane, key) {
      const argv = ['pane', 'send-keys', pane, key]
      call(...argv)
      need(pane, argv)
    },
    async sendText(pane, text) {
      const argv = ['pane', 'send-text', pane, text]
      call(...argv)
      need(pane, argv)
    },
    async rename(pane, label) {
      const argv = ['pane', 'rename', pane, label ?? '--clear']
      call(...argv)
      const p = need(pane, argv)
      if (label === null) delete p.label
      else p.label = label
    },
    async prompt(pane, text) {
      const argv = ['agent', 'prompt', pane, /^-/.test(text) ? ` ${text}` : text]
      call(...argv)
      need(pane, argv)
    },
    async screen(pane) {
      const argv = ['pane', 'read', pane, '--source', 'visible']
      call(...argv)
      need(pane, argv)
      return fake.screens[pane] ?? ''
    },
    async inputBox(pane) {
      const argv = ['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi']
      call(...argv)
      need(pane, argv)
      return fake.inputBoxes[pane] ?? ''
    },
  }
  return fake
}
