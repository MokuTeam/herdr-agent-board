// Checking that the board is set up on this computer: what the install action writes (the board
// and spawn-agent commands on PATH, the Claude Code hooks, the status line, desktop notifications
// on Windows; core/install-plan.ts) and what `board doctor`, the install action and the web board
// check (those, herdr's key for the board, herdr-wake, how new sessions start).
//
// Pure: adapters/setup-facts.ts reads this computer into SetupFacts, and tests hand in fixtures.
import { join } from 'node:path'
import { translator } from './i18n/translator.ts'
import { BOARD_EVENTS, commandsOf, normPath, ourCommands, TOAST_EVENTS } from './install-plan.ts'
import type { MokupilotLauncher } from './mokupilot.ts'
import type { Translator } from './types.ts'

export const WAKE_REPO = 'https://github.com/Eithery-rc/tg-mcp/tree/main/herdr-wake'
const english = translator('en')

/** The files of a copy of the board that other programs run. */
export interface BoardFiles {
  cli: string
  spawn: string
  hook: string
  statusline: string
  toast: string
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
  }
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

/** A shown Claude profile's settings.json (core/profiles.ts): its folder, and whether it is there. */
export interface ProfileSettings {
  id: string
  title: string
  dir: string
  exists: boolean
  settingsFile: string
  /** settings.json parsed; null when there is none or it does not parse. */
  settings: unknown
  settingsError: string
}

/** Everything the checks look at (adapters/setup-facts.ts gatherFacts). */
export interface SetupFacts {
  platform: string
  root: string
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
  /** Every shown profile's settings.json, the first one's as above; with more than one, the hooks and the status line are checked in each. */
  profiles?: ProfileSettings[]
  herdrConfigFile: string
  herdrConfig: string | null
  wakeUrl: string | null
  wake: { ok: boolean; status?: number; error?: string } | null
  launcher: LauncherFacts | null
  /** How the board would start MokuPilot (adapters/setup-facts.ts mokupilotCommand); none: not looked for. */
  mokupilot?: MokupilotLauncher | null
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
    if (!missing.length)
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

  // herdr-wake: putting sessions to sleep and waking them. Optional: no mark on the board for it.
  if (!facts.wakeUrl)
    add(
      'wake',
      'off',
      t('setup.wake.off'),
      both(t('setup.wake.offDetail'), t('setup.wake.without')),
      t('setup.wake.fix'),
      WAKE_REPO,
    )
  else if (facts.wake?.ok) add('wake', 'ok', t('setup.wake.ok'), t('setup.wake.okDetail', { url: facts.wakeUrl }))
  else
    add(
      'wake',
      'off',
      t('setup.wake.down', { url: facts.wakeUrl }),
      t('setup.wake.without'),
      t('setup.wake.fix'),
      WAKE_REPO,
    )

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
    if (mp.state === 'ok') add('mokupilot', 'ok', t('setup.mokupilot.ok'), [mp.file, ...(mp.args ?? [])].join(' '))
    else if (mp.state === 'off')
      add('mokupilot', 'off', t('setup.mokupilot.disabled'), t('setup.mokupilot.disabledDetail'))
    else if (mp.configured)
      add(
        'mokupilot',
        'warn',
        t('setup.mokupilot.missing', { file: mp.file || '?' }),
        both(mp.error ?? '', t('setup.mokupilot.missingDetail')),
        t('setup.mokupilot.missingFix'),
        snippet,
      )
    else
      add(
        'mokupilot',
        'off',
        t('setup.mokupilot.off'),
        t('setup.mokupilot.offDetail'),
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
