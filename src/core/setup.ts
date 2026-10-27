// Checking that the board is set up on this computer: what the install action writes (the board
// and spawn-agent commands on PATH, the Claude Code hooks, the status line, desktop notifications
// on Windows; core/install-plan.ts; the agents' skill and herdr's own Claude hook, below) and what
// `board doctor`, the install action and the web board check (those, herdr's key for the board,
// sleep and wake, how new sessions start).
//
// Pure: adapters/setup-facts.ts reads this computer into SetupFacts, and tests hand in fixtures.
import { join } from 'node:path'
import type { CardStore } from './card-store.ts'
import { translator } from './i18n/translator.ts'
import {
  BOARD_EVENTS,
  commandsOf,
  normPath,
  ourCommands,
  QUESTION_HOOK,
  TOAST_EVENTS,
  wakeHooksState,
} from './install-plan.ts'
import type { MokupilotLauncher } from './mokupilot.ts'
import type { MokupilotMode } from './mokupilot-mode.ts'
import type { Translator } from './types.ts'
import type { WakeState } from './wake/status.ts'

const english = translator('en')

/** The files of a copy of the board that other programs run, and the skill install copies. */
export interface BoardFiles {
  cli: string
  spawn: string
  hook: string
  statusline: string
  toast: string
  /** Wake's ListAgents and SendMessage hooks (#119), which install writes while wake is on. */
  wakeHook: string
  /** The agents' skill (skills/herdr-agents/SKILL.md), which install copies into each shown profile. */
  skill: string
}

/** The files of the copy of the board at `root`. */
export function boardFiles(root: string): BoardFiles {
  const entrypoint = (name: string): string => join(root, 'src', 'entrypoints', name)
  return {
    cli: entrypoint('cli.ts'),
    spawn: entrypoint('spawn-agent.ts'),
    hook: entrypoint('hook.ts'),
    statusline: entrypoint('statusline.ts'),
    toast: join(root, 'src', 'integrations', 'toast.ps1'),
    wakeHook: entrypoint('wake-hook.ts'),
    skill: join(root, 'skills', SKILL, 'SKILL.md'),
  }
}

// ------------------------------------------------------------------ the agents' skill

// What sessions in herdr read on demand (skills/herdr-agents): install copies it into Claude
// Code's user skills, in every shown profile's folder (~/.claude/skills with one); the marker in
// it tells a copy of ours from someone else's skill of that name.
export const SKILL = 'herdr-agents'
const SKILL_MARK = 'agent-board: installed by'

/** The skill's file in the Claude profile folder `dir` (~/.claude: ~/.claude/skills/herdr-agents/SKILL.md). */
export const skillFile = (dir: string): string => join(dir, 'skills', SKILL, 'SKILL.md')

export type SkillAction = 'write' | 'same' | 'foreign'

/** What install does with the skill: 'write' (missing, or an older copy of ours), 'same', or 'foreign'. */
export function skillAction(installed: string | null | undefined, source: string | null | undefined): SkillAction {
  if (installed === null || installed === undefined) return 'write'
  if (!installed.includes(SKILL_MARK)) return 'foreign'
  return installed.replace(/\r\n/g, '\n') === String(source ?? '').replace(/\r\n/g, '\n') ? 'same' : 'write'
}

// ------------------------------------------------------------------ herdr's config.toml

/** The value of `key` in a [section] of a TOML text, as written (strings unquoted), or undefined. */
export function tomlValue(text: unknown, section: string, key: string): string | undefined {
  let inside = false
  const own = new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s*(.+)$`)
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (/^\[\[?[^\]]+\]\]?$/.test(line)) {
      inside = line === `[${section}]`
      continue
    }
    const m = inside ? own.exec(line) : null
    if (m) return (m[1] ?? '').trim().replace(/^"(.*)"$|^'(.*)'$/, (_, a, b) => a ?? b)
  }
  return undefined
}

/** The key bound to the board in herdr ("prefix+a"), '' when one is bound without a readable key, or null. */
export function boardKey(text: unknown): string | null {
  for (const block of String(text ?? '')
    .split(/^\s*\[\[keys\.command\]\]\s*$/m)
    .slice(1)) {
    const body = block.split(/^\s*\[/m)[0] ?? ''
    if (/^\s*command\s*=\s*["']agent-board\.open["']/m.test(body))
      return /^\s*key\s*=\s*["']([^"']+)["']/m.exec(body)?.[1] ?? ''
  }
  return null
}

export const KEY_SNIPPET =
  '[[keys.command]]\nkey = "prefix+a"\ntype = "plugin_action"\ncommand = "agent-board.open"\ndescription = "agent board"'

// ------------------------------------------------------------------ herdr's own Claude hook

// herdr learns which Claude session a pane runs only from its own SessionStart hook, which
// `herdr integration install claude` writes into one profile folder (the one CLAUDE_CONFIG_DIR
// names, else ~/.claude): hooks/herdr-agent-state.ps1 on Windows, registered in that folder's
// settings.json. Without it a pane running Claude in that profile has no session in herdr's
// snapshot: its card shows no conversation and no profile. The install action has herdr write it
// into every shown profile.
const HERDR_HOOK = /(["'])([^"']*herdr-agent-state[^"']*)\1|(\S*herdr-agent-state\S*)/

/** The script herdr's own Claude hook runs at SessionStart in these settings, or null when none does. */
export function herdrHookScript(settings: unknown): string | null {
  for (const { command } of commandsOf(settings, 'SessionStart')) {
    const m = HERDR_HOOK.exec(command)
    if (m) return m[2] ?? m[3] ?? null
  }
  return null
}

// ------------------------------------------------------------------ what the checks look at

/** Where a shell finds a command: the file, and for one of ours the script it runs (`gone`: no longer there). */
export interface CommandHit {
  file: string
  target: string | null
  gone?: true
}

/** Per shell: PowerShell (`ps`, Windows only) and Git Bash or the Unix shell (`sh`); null where none. */
export type CommandFinds = { ps?: CommandHit | null; sh?: CommandHit | null }

/** A program a launcher runs: the file found (or the name), and whether it was. */
export interface ProgramFound {
  file: string
  found: boolean
}

/** How new sessions start, from `launch` in config.json. */
export type LauncherFacts =
  | { kind: 'command'; name: string; program: ProgramFound | null; script: ProgramFound | null }
  | { kind: 'herdr'; agent: string }
  | { kind: 'builtin'; claude: string[] | null; error: string; program: ProgramFound | null }

/** The agents' skill in a Claude profile folder: its file, the text there (null: none), and this copy's (null: none). */
export interface SkillFacts {
  file: string
  installed: string | null
  source: string | null
}

/** herdr's own Claude hook in a profile folder: the script its SessionStart entry runs (null: no entry), and whether that file is there. */
export interface HerdrHookFacts {
  script: string | null
  found: boolean
}

/** A shown Claude profile's settings.json and skill (core/profiles.ts): its folder, and whether it is there. */
export interface ProfileSettings {
  id: string
  title: string
  dir: string
  exists: boolean
  settingsFile: string
  /** settings.json parsed; null when there is none or it does not parse. */
  settings: unknown
  settingsError: string
  /** The agents' skill in this folder; none: not looked at, no check. */
  skill?: SkillFacts | undefined
  /** herdr's own Claude hook in this folder; none: not looked at, no check. */
  herdrHook?: HerdrHookFacts | undefined
}

/** Everything the checks look at (adapters/setup-facts.ts gatherFacts). */
export interface SetupFacts {
  platform: string
  root: string
  /** Effective paths of this process; other writers' environments are not guessed. */
  cardStore?: CardStore | { error: string }
  /** The Node version the runtime reports (Bun: the Node version it is compatible with). */
  node: string
  binDir: string
  path: string
  files: BoardFiles
  commands: { board?: CommandFinds; 'spawn-agent'?: CommandFinds }
  /** The first shown profile's settings.json (~/.claude's with one profile). */
  settingsFile: string
  /** settings.json parsed; null when there is none or it does not parse. */
  settings: unknown
  settingsError: string
  /** Every shown profile's settings.json, the first one's as above; with more than one, the hooks, the status line and the skill are checked in each. */
  profiles?: ProfileSettings[]
  /** The first shown profile's agents' skill (~/.claude's with one profile); none: not looked at, no check. */
  skill?: SkillFacts | undefined
  /** The first shown profile's herdr hook (~/.claude's with one profile); none: not looked at, no check. */
  herdrHook?: HerdrHookFacts | undefined
  herdrConfigFile: string
  herdrConfig: string | null
  wakeUrl: string | null
  wake: { ok: boolean; status?: number; error?: string } | null
  /**
   * Sleep and wake (#119), once it ships or while config.json turns it on: its state
   * (core/wake/status.ts), port, last error, sessions asleep, log file, and whether wakeUrl is set to
   * another address than the default; `router`: its port is held by the separate herdr-wake
   * plugin's router, this process; `takenOver`: the takeover at wake's first start (nobody asked)
   * took that many sleeping sessions over, and the panel has not shown it yet. Null or none:
   * herdr-wake's line at wakeUrl, as before.
   */
  wakeNew?: {
    state: WakeState
    port: number
    error?: string
    router?: number
    asleep: number
    log: string
    wakeUrlSet: boolean
    takenOver?: number
  } | null
  launcher: LauncherFacts | null
  /** How the board would start MokuPilot (adapters/setup-facts.ts mokupilotCommand); none: not looked for. */
  mokupilot?: MokupilotLauncher | null
  /** Where a call starts (core/mokupilot-mode.ts mokupilotMode); none: `auto`. */
  mokupilotMode?: MokupilotMode
}

export type SetupLevel = 'ok' | 'error' | 'warn' | 'off' | 'na'

/** One check: `code` is a command or a snippet to copy. */
export interface SetupCheck {
  id: string
  level: SetupLevel
  title: string
  detail: string
  fix: string
  code: string
}

/** What the board payload says of the checks: how many need a look, and which (in English, so a language switch is no news). */
export interface SetupSummary {
  todo: number
  sig: string
}

// ------------------------------------------------------------------ the checks

const INSTALL = 'herdr plugin action invoke agent-board.install'
const NOTIFICATIONS = 'herdr plugin action invoke agent-board.notifications'

const samePath = (a: unknown, b: unknown): boolean => !!a && !!b && normPath(a) === normPath(b)

/**
 * What is set up and what is not, from the facts: a list of checks in the language of `t`. level:
 * ok; error (the board misses something it needs); warn (a part of it does not work); off
 * (optional and not set up: what it would give); na (not on this platform).
 */
export function checkSetup(facts: SetupFacts, t: Translator = english): SetupCheck[] {
  const out: SetupCheck[] = []
  const add = (id: string, level: SetupLevel, title: string, detail = '', fix = '', code = ''): void => {
    out.push({ id, level, title, detail, fix, code })
  }
  const f = facts.files
  const win = facts.platform === 'win32'
  const both = (...parts: string[]): string => parts.filter(Boolean).join(' ')

  const major = Number(String(facts.node ?? '').split('.')[0])
  if (major && major < 20) add('node', 'error', t('setup.node', { version: facts.node }), t('setup.node.detail'))

  const store = facts.cardStore
  if (store) {
    if ('error' in store) add('cards', 'error', t('setup.cards.invalid'), store.error, t('setup.cards.fix'))
    else {
      const uncertain = store.customState && !store.explicit
      add(
        'cards',
        uncertain ? 'warn' : 'ok',
        t(uncertain ? 'setup.cards.check' : 'setup.cards.title'),
        t('setup.cards.detail', {
          cards: store.cards,
          schedule: store.schedule,
          source: store.explicit ? 'HERDR_BOARD_CARDS_DIR' : 'LOCALAPPDATA / ~/.local/state',
        }),
        t(uncertain ? 'setup.cards.preview' : 'setup.cards.writers'),
      )
    }
  }

  // A command: where each shell finds it, and whether that is this copy's.
  const command = (name: 'board' | 'spawn-agent', file: string, level: SetupLevel, without: string) => {
    const shells = Object.entries(facts.commands?.[name] ?? {}) as [string, CommandHit | null | undefined][]
    const shell = (sh: string): string =>
      t(sh === 'ps' ? 'setup.shell.ps' : win ? 'setup.shell.gitBash' : 'setup.shell.sh')
    const missing = shells.filter(([, hit]) => !hit).map(([sh]) => sh)
    const foreign = shells.flatMap(([sh, hit]) => (hit && !hit.target ? [`${hit.file} (${shell(sh)})`] : []))
    const stale = shells.find(([, hit]) => hit?.target && !samePath(hit.target, file))?.[1]
    if (!missing.length && !foreign.length && !stale)
      return add(name, 'ok', t('setup.cmd.ok', { name }), shells.map(([, hit]) => hit?.file ?? '').join(', '))
    if (foreign.length)
      return add(
        name,
        level,
        t('setup.cmd.foreign', { name }),
        both(t('setup.cmd.foreignDetail', { files: foreign.join(', ') }), without),
        t('setup.cmd.foreignFix'),
        INSTALL,
      )
    if (stale?.gone)
      return add(
        name,
        level,
        t('setup.cmd.gone', { name }),
        both(t('setup.cmd.goneDetail', { file: stale.target ?? '' }), without),
        t('setup.runInstall'),
        INSTALL,
      )
    if (stale)
      return add(
        name,
        'warn',
        t('setup.cmd.stale', { name }),
        t('setup.cmd.staleDetail', { file: stale.target ?? '' }),
        t('setup.runInstall'),
        INSTALL,
      )
    const onPath = facts.path.split(win ? ';' : ':').some(d => samePath(d, facts.binDir))
    if (!onPath)
      return add(
        name,
        level,
        t('setup.cmd.path', { name }),
        both(t('setup.cmd.pathDetail', { dir: facts.binDir }), without),
        t(win ? 'setup.cmd.pathFixWin' : 'setup.cmd.pathFix', { dir: facts.binDir }),
      )
    const title =
      missing.length < shells.length
        ? t('setup.cmd.missingFor', { name, shells: missing.map(shell).join(', ') })
        : t('setup.cmd.missing', { name })
    return add(name, level, title, without, t('setup.runInstall'), INSTALL)
  }
  command('board', f.cli, 'error', t('setup.board.without'))

  // Claude Code hooks: how sessions learn about the board. With more than one profile shown, in
  // each, by its name (ids hooks:<id>, statusline:<id>); with one, as before.
  const ours = ourCommands(f)
  const settingsChecks = (
    s: Pick<SetupFacts, 'settingsFile' | 'settings' | 'settingsError'>,
    id: (check: string) => string = check => check,
    named: (title: string) => string = title => title,
  ): void => {
    const own = (check: string, level: SetupLevel, title: string, detail = '', fix = '', code = ''): void =>
      add(id(check), level, named(title), detail, fix, code)
    if (s.settingsError) {
      own(
        'hooks',
        'error',
        t('setup.hooks.unreadable'),
        `${s.settingsFile}: ${s.settingsError}`,
        t('setup.hooks.unreadableFix'),
      )
      return
    }
    const per = BOARD_EVENTS.map(event => {
      const hooks = commandsOf(s.settings, event).filter(c => ours.hook(c.command))
      const here = (c: { command: string }): boolean => normPath(c.command).includes(normPath(f.hook))
      return { event, here: hooks.some(here), other: hooks.find(c => !here(c))?.command }
    })
    const missing = per.filter(p => !p.here)
    // The question form's hook came later: hooks of an install from before it work as they did.
    const [asked, matcher] = QUESTION_HOOK
    const asks = commandsOf(s.settings, asked).some(
      c => c.matcher === matcher && ours.hook(c.command) && normPath(c.command).includes(normPath(f.hook)),
    )
    if (!missing.length && !asks)
      own(
        'hooks',
        'warn',
        t('setup.hooks.question'),
        t('setup.hooks.questionDetail', { file: s.settingsFile }),
        t('setup.runInstall'),
        INSTALL,
      )
    else if (!missing.length)
      own(
        'hooks',
        'ok',
        t('setup.hooks.ok'),
        t('setup.hooks.okDetail', { events: BOARD_EVENTS.join(', '), file: s.settingsFile }),
      )
    else if (missing.every(p => p.other))
      own('hooks', 'warn', t('setup.hooks.stale'), missing[0]?.other ?? '', t('setup.runInstall'), INSTALL)
    else
      own(
        'hooks',
        'error',
        t('setup.hooks.missing', { events: missing.map(p => p.event).join(', ') }),
        t('setup.hooks.without'),
        t('setup.runInstall'),
        INSTALL,
      )

    const line = statusLineCommand(s.settings)
    if (line && ours.line(line)) {
      if (normPath(line).includes(normPath(f.statusline)))
        own('statusline', 'ok', t('setup.line.ok'), t('setup.line.okDetail'))
      else own('statusline', 'warn', t('setup.line.stale'), line, t('setup.runInstall'), INSTALL)
    } else if (line) own('statusline', 'ok', t('setup.line.own'), t('setup.line.ownDetail'))
    else own('statusline', 'warn', t('setup.line.none'), t('setup.line.noneDetail'), t('setup.runInstall'), INSTALL)
  }
  const profiles = facts.profiles ?? []
  if (profiles.length <= 1) settingsChecks(facts)
  else
    for (const p of profiles) {
      if (!p.exists) add(`profile:${p.id}`, 'warn', t('setup.profile.missing', { profile: p.title, dir: p.dir }))
      else
        settingsChecks(
          p,
          check => `${check}:${p.id}`,
          check => t('setup.inProfile', { profile: p.title, check }),
        )
    }

  command('spawn-agent', f.spawn, 'warn', t('setup.spawn.without'))

  // The skill sessions in herdr read on demand (the brief points to it). With more than one
  // profile shown, in each whose folder is there, by its name (id skill:<id>); with one, as upstream.
  const skillCheck = (
    s: SkillFacts | undefined,
    id = 'skill',
    named: (title: string) => string = title => title,
  ): void => {
    if (!s) return
    const state = skillAction(s.installed, s.source)
    const name = SKILL
    if (state === 'same') add(id, 'ok', named(t('setup.skill.ok', { name })), t('setup.skill.okDetail'))
    else if (state === 'foreign')
      add(
        id,
        'warn',
        named(t('setup.skill.foreign', { name })),
        t('setup.skill.foreignDetail', { file: s.file }),
        t('setup.skill.foreignFix'),
        INSTALL,
      )
    else if (s.installed !== null)
      add(id, 'warn', named(t('setup.skill.stale', { name })), t('setup.skill.without'), t('setup.runInstall'), INSTALL)
    else
      add(
        id,
        'warn',
        named(t('setup.skill.missing', { name })),
        t('setup.skill.without'),
        t('setup.runInstall'),
        INSTALL,
      )
  }
  if (profiles.length <= 1) skillCheck(facts.skill)
  else
    for (const p of profiles)
      if (p.exists) skillCheck(p.skill, `skill:${p.id}`, check => t('setup.inProfile', { profile: p.title, check }))

  // herdr's own Claude hook, from which herdr learns the session a pane runs. With more than one
  // profile shown, in each whose folder is there, by its name (id herdr:<id>); with one, once.
  const herdrCheck = (
    h: HerdrHookFacts | undefined,
    id = 'herdr',
    named: (title: string) => string = title => title,
  ): void => {
    if (!h) return
    if (h.script && h.found) add(id, 'ok', named(t('setup.herdr.ok')), t('setup.herdr.okDetail'))
    else add(id, 'warn', named(t('setup.herdr.missing')), t('setup.herdr.without'), t('setup.runInstall'), INSTALL)
  }
  if (profiles.length <= 1) herdrCheck(facts.herdrHook)
  else
    for (const p of profiles)
      if (p.exists) herdrCheck(p.herdrHook, `herdr:${p.id}`, check => t('setup.inProfile', { profile: p.title, check }))

  // herdr's key for the board.
  const key = boardKey(facts.herdrConfig)
  if (key !== null)
    add('key', 'ok', t('setup.key.ok'), t('setup.key.okDetail', { key: key || '?', file: facts.herdrConfigFile }))
  else
    add(
      'key',
      'warn',
      t('setup.key.none'),
      t('setup.key.noneDetail'),
      t('setup.key.noneFix', { file: facts.herdrConfigFile }),
      KEY_SNIPPET,
    )

  // Sleep and wake: the board's own (#119), on, off or held by the old plugin; herdr-wake's line
  // only for facts without it. Optional: a mark on the board only when it is on and does not work.
  const w = facts.wakeNew
  if (w) {
    const port = { port: w.port }
    const log = { file: w.log }
    if (w.state === 'running' || w.state === 'starting')
      add(
        'wake',
        'ok',
        t(w.state === 'running' ? 'setup.wake.running' : 'setup.wake.starting'),
        t('setup.wake.runningDetail', { ...port, n: w.asleep }),
      )
    else if (w.state === 'off') add('wake', 'off', t('setup.wake.newOff'), '', t('setup.wake.newOffFix'))
    else if (w.state === 'crashed')
      add('wake', 'error', t('setup.wake.crashed'), w.error ?? '', t('setup.wake.crashedFix', log))
    else if (w.state === 'held') add('wake', 'warn', t('setup.wake.held'), '', t('setup.wake.heldFix'))
    else if (w.state === 'portTaken' && w.router !== undefined)
      // Another port would run two wakes: the router goes, and wake takes its port again.
      add(
        'wake',
        'error',
        t('setup.wake.portRouter', { ...port, pid: w.router }),
        '',
        t('setup.wake.portRouterFix', { pid: w.router }),
      )
    else if (w.state === 'portTaken')
      add('wake', 'error', t('setup.wake.portTaken', port), '', t('setup.wake.portTakenFix'))
    else add('wake', 'warn', t('setup.wake.notAnswering', port), w.error ?? '', t('setup.wake.notAnsweringFix', log))
    // On (and not held), the board talks to wake on its port, not at wakeUrl.
    const on = w.state !== 'off' && w.state !== 'held'
    if (on && w.wakeUrlSet) add('wakeUrl', 'na', t('setup.wake.urlUnused'))
    // The takeover at wake's first start, which nobody asked for: said until the panel has shown it.
    if (w.takenOver !== undefined)
      add(
        'wakeTakeover',
        'off',
        t('setup.wake.takenOver'),
        t('setup.wake.takenOverDetail', { n: w.takenOver }),
        t('setup.wake.takenOverFix'),
      )
    // Its ListAgents and SendMessage hooks, in each shown profile (as the board's hooks are checked).
    const wakeHooks = (
      s: Pick<SetupFacts, 'settingsFile' | 'settings' | 'settingsError'>,
      id = 'wakeHooks',
      named: (title: string) => string = title => title,
    ): void => {
      if (s.settingsError) return // the hooks check says the file does not read
      const state = wakeHooksState(s.settings, f.wakeHook)
      if (state === 'in')
        add(id, 'ok', named(t('setup.wake.hooks.ok')), t('setup.wake.hooks.okDetail', { file: s.settingsFile }))
      else if (state === 'old')
        add(id, 'warn', named(t('setup.wake.hooks.old')), t('setup.wake.hooks.oldDetail'), t('setup.wake.heldFix'))
      else
        add(
          id,
          'warn',
          named(t('setup.wake.hooks.missing')),
          t('setup.wake.hooks.without'),
          t('setup.runInstall'),
          INSTALL,
        )
    }
    if (on && profiles.length <= 1) wakeHooks(facts)
    else if (on)
      for (const p of profiles)
        if (p.exists) wakeHooks(p, `wakeHooks:${p.id}`, check => t('setup.inProfile', { profile: p.title, check }))
  } else if (!facts.wakeUrl)
    // Facts without the board's own wake (an older gatherFacts): herdr-wake's line, its fix the
    // board's Sleep and wake, with nothing to install and no Node.
    add(
      'wake',
      'off',
      t('setup.wake.off'),
      both(t('setup.wake.offDetail'), t('setup.wake.without')),
      t('setup.wake.newOffFix'),
    )
  else if (facts.wake?.ok) add('wake', 'ok', t('setup.wake.ok'), t('setup.wake.okDetail', { url: facts.wakeUrl }))
  else
    add('wake', 'off', t('setup.wake.down', { url: facts.wakeUrl }), t('setup.wake.without'), t('setup.wake.heldFix'))

  // How new sessions start.
  const l = facts.launcher
  if (l?.kind === 'command') {
    const bad = [l.program && !l.program.found && l.program.file, l.script && !l.script.found && l.script.file].filter(
      (s): s is string => !!s,
    )
    if (bad.length)
      add(
        'launch',
        'warn',
        t('setup.launch.commandBad', { name: l.name }),
        t('setup.launch.commandBadDetail', { what: bad.join(', ') }),
        t('setup.launch.commandBadFix'),
      )
    else add('launch', 'ok', t('setup.launch.command', { name: l.name }))
  } else if (l?.kind === 'herdr') {
    add('launch', 'ok', t('setup.launch.herdr', { agent: l.agent }), t('setup.launch.herdrDetail'))
  } else if (l?.kind === 'builtin') {
    const program = l.claude?.[0] ?? ''
    if (l.error) add('launch', 'warn', t('setup.launch.claudeBad'), l.error, t('setup.launch.claudeBadFix'))
    else if (!l.program?.found)
      add(
        'launch',
        'warn',
        t('setup.launch.notFound', { program }),
        t('setup.launch.notFoundDetail', { program }),
        t('setup.launch.notFoundFix'),
      )
    else
      add(
        'launch',
        'ok',
        t('setup.launch.builtin', { claude: program }),
        l.claude?.length === 1 && program === 'claude' ? t('setup.launch.builtinDetail') : '',
      )
  }

  // MokuPilot: calls with a fork of a session. Optional: a mark only when config.json names one that is not there.
  const mp = facts.mokupilot
  if (mp) {
    const snippet = `"mokupilot": { "dir": "${win ? 'C:\\Users\\you\\MokuPilot' : '~/MokuPilot'}" }`
    // Where a call starts (core/mokupilot-mode.ts): `link` needs nothing here, `local` MokuPilot here.
    const mode = facts.mokupilotMode ?? 'auto'
    if (mp.state === 'ok')
      add(
        'mokupilot',
        'ok',
        t('setup.mokupilot.ok'),
        both([mp.file, ...(mp.args ?? [])].join(' '), mode === 'auto' ? t('setup.mokupilot.autoDetail') : ''),
      )
    else if (mp.state === 'link') add('mokupilot', 'ok', t('setup.mokupilot.link'), t('setup.mokupilot.linkDetail'))
    else if (mp.state === 'off')
      add('mokupilot', 'off', t('setup.mokupilot.disabled'), t('setup.mokupilot.disabledDetail'))
    else if (mp.configured || mode === 'local')
      add(
        'mokupilot',
        'warn',
        t('setup.mokupilot.missing', { file: mp.file || '?' }),
        both(
          mp.error ?? '',
          t(
            mode === 'local'
              ? 'setup.mokupilot.localMissingDetail'
              : mode === 'auto'
                ? 'setup.mokupilot.autoMissingDetail'
                : 'setup.mokupilot.missingDetail',
          ),
        ),
        t('setup.mokupilot.missingFix'),
        snippet,
      )
    else
      add(
        'mokupilot',
        'off',
        t('setup.mokupilot.off'),
        both(t('setup.mokupilot.offDetail'), t('setup.mokupilot.linkHint')),
        t('setup.mokupilot.offFix'),
        snippet,
      )
  }

  // Desktop notifications with the agent's words. Optional too, until they are on.
  if (!win) {
    add('toast', 'na', t('setup.toast.na'), t('setup.toast.naDetail'))
  } else {
    const per = TOAST_EVENTS.map(([event]) => commandsOf(facts.settings, event).filter(c => ours.toast(c.command)))
    const here = per.every(list => list.some(c => normPath(c.command).includes(normPath(f.toast))))
    const delivery = tomlValue(facts.herdrConfig, 'ui.toast', 'delivery') ?? 'off'
    const theirs = TOAST_EVENTS.flatMap(([event]) => commandsOf(facts.settings, event)).find(
      c => /toast/i.test(c.command) && !ours.toast(c.command),
    )?.command
    if (per.every(list => !list.length)) {
      if (theirs) add('toast', 'ok', t('setup.toast.own'), theirs)
      else add('toast', 'off', t('setup.toast.off'), t('setup.toast.offDetail'), t('setup.toast.offFix'), NOTIFICATIONS)
    } else if (theirs)
      add(
        'toast',
        'warn',
        t('setup.toast.twice'),
        t('setup.toast.theirs', { command: theirs }),
        t('setup.toast.theirsFix', { file: facts.settingsFile }),
      )
    else if (!here)
      add('toast', 'warn', t('setup.toast.stale'), per.flat()[0]?.command ?? '', t('setup.run'), NOTIFICATIONS)
    else if (delivery !== 'off')
      add(
        'toast',
        'warn',
        t('setup.toast.twice'),
        t('setup.toast.twiceDetail', { delivery, file: facts.herdrConfigFile }),
        t('setup.toast.twiceFix'),
      )
    else add('toast', 'ok', t('setup.toast.ok'), t('setup.toast.okDetail'))
  }
  return out
}

/** The status line's command in settings.json, or ''. */
function statusLineCommand(settings: unknown): string {
  if (!settings || typeof settings !== 'object') return ''
  const line: unknown = (settings as { statusLine?: unknown }).statusLine
  if (!line || typeof line !== 'object') return ''
  const command: unknown = (line as { command?: unknown }).command
  return typeof command === 'string' ? command : ''
}

/** Problems worth a mark on the web board: what does not work, not what is merely off. */
export const todo = (checks: readonly SetupCheck[]): SetupCheck[] =>
  checks.filter(c => c.level === 'error' || c.level === 'warn')

/** The summary the board payload carries; its sig names the problems in English. */
export function setupSummary(englishChecks: readonly SetupCheck[]): SetupSummary {
  const open = todo(englishChecks)
  return { todo: open.length, sig: open.map(c => `${c.id}:${c.level}:${c.title}`).join('|') }
}

const MARKS: Record<SetupLevel, string> = { ok: 'ok', error: '!!', warn: '! ', off: '- ', na: '- ' }

/** The checks as text for a terminal. */
export function report(checks: readonly SetupCheck[], t: Translator = english): string {
  const lines: string[] = []
  for (const c of checks) {
    lines.push(`${MARKS[c.level]} ${c.title}${c.level === 'ok' && c.detail ? ` · ${c.detail}` : ''}`)
    if (c.level === 'ok') continue
    for (const part of [c.detail, c.fix, c.code]) if (part) lines.push(...part.split('\n').map(l => `     ${l}`))
  }
  const n = todo(checks).length
  lines.push(n ? t('setup.todo', { n }) : t('setup.allSet'))
  return lines.join('\n')
}
