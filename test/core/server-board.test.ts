// The board on the server as the local board's card sees it (core/server-board.ts): the round as
// root that reads what the install left, the Undo's plan in the install's own words, the version
// against the local checkout's, and the command that removes it.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  type BoardFacts,
  boardFactsScript,
  boardState,
  boardVersionOf,
  readBoardFacts,
  type UndoFacts,
  undoFactsOf,
  undoNothing,
  undoWill,
  versionLine,
} from '../../src/core/server-board.ts'
import { BOARD_SOCKET, REPO, removerScript } from '../../src/core/server-install.ts'

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const OTHER = 'ffeeddccbbaa99887766554433221100ffeeddcc'
const en = translator('en')
const ru = translator('ru')

const RECORD = {
  v: 1,
  user: 'agent',
  home: '/home/agent',
  domain: 'workbench.example.com',
  socket: BOARD_SOCKET,
  source: { kind: 'archive', commit: SHA, changes: true },
  sudo: false,
  at: '2026-10-28T14:02:00.000Z',
  desktop: ['chromium'],
}
const out = (...lines: string[]): string => ['@@facts 1', ...lines, '@@end'].join('\n')

describe('the round as root', () => {
  test('reads only: the record, the user it names, sudo and the service; nothing of the tunnel’s', () => {
    const s = boardFactsScript()
    expect(s.split('\n')[0]).toBe('# agent-board: board')
    expect(s).toContain("'/etc/agent-board-server/install.json'")
    expect(s).toContain('getent passwd "$u"')
    expect(s).toContain('/etc/sudoers.d/agent-board-$u')
    expect(s).toContain('/.config/systemd/user/herdr.service')
    // nothing written, removed or started; never the tunnel's record
    expect(s).not.toMatch(/\brm\b|\bmv\b|\bcp\b|systemctl|userdel|>\s*\/|tee /)
    expect(s).not.toContain('/etc/agent-board/')
  })

  test('the record’s user read in sh as JSON.stringify writes it', () => {
    const sh = Bun.which('sh')
    if (!sh) return
    const line = /u=\$\((sed -n '[^']+')/.exec(boardFactsScript())?.[1] ?? ''
    const r = Bun.spawnSync([sh, '-c', `${line}`], {
      stdin: new TextEncoder().encode(`${JSON.stringify({ ...RECORD, user: 'bob_2' })}\n`),
    })
    expect(r.stdout.toString().trim()).toBe('bob_2')
  })

  test('an install: its record, its user with the mark, sudo and the service', () => {
    const f = readBoardFacts(
      out(
        `@@record ${JSON.stringify(RECORD)}`,
        '@@user agent:x:1001:1001:agent-board server:/home/agent:/bin/bash',
        '@@service',
      ),
    )
    expect(f?.record?.source).toEqual({ kind: 'archive', commit: SHA, changes: true })
    expect(f?.user).toEqual({ name: 'agent', home: '/home/agent', ours: true })
    expect(f?.sudo).toBe(false)
    expect(f?.service).toBe(true)
  })

  test('nothing there, a user that is not the installer’s, a garbled record, a cut answer', () => {
    expect(readBoardFacts(out('@@user '))).toEqual({ record: null, user: null, sudo: false, service: false })
    expect(readBoardFacts(out('@@user agent:x:1000:1000:Agent Smith:/home/agent:/bin/bash'))?.user).toEqual({
      name: 'agent',
      home: '/home/agent',
      ours: false,
    })
    expect(readBoardFacts(out('@@record {"v":1,', '@@user '))?.record).toBeNull()
    expect(readBoardFacts('@@facts 1\n@@record {}')).toBeNull()
    expect(readBoardFacts('')).toBeNull()
  })
})

describe('the Undo’s plan, the install’s own words', () => {
  const facts = (more: Partial<UndoFacts> = {}): UndoFacts => ({
    user: 'agent',
    home: '/home/agent',
    ours: true,
    record: true,
    sudo: false,
    service: true,
    desktop: ['chromium'],
    desktopLibs: [],
    ...more,
  })
  const WEB = ['Remove the board’s site from Caddy.']

  test('the user kept by default; with the tick, it goes, and the packages the install added with it', () => {
    expect(undoWill(facts(), false, WEB, en)).toEqual([
      'Stop herdr’s service of agent and its start with the server.',
      'Remove the board’s site from Caddy.',
      'The user agent and its home stay (with --remove-user they go too).',
    ])
    expect(undoWill(facts({ sudo: true }), true, null, en)).toEqual([
      'Stop herdr’s service of agent and its start with the server.',
      'Take agent’s sudo away.',
      'The web server has nothing of the board’s to remove.',
      'Remove the packages the install added for the agents’ browsers: chromium.',
      'Remove the user agent and its home (/home/agent): Bun, herdr, Claude Code, the board, everything in it.',
    ])
  })

  test('a user the installer did not make is never removed, nor its packages', () => {
    expect(undoWill(facts({ ours: false }), true, null, en)).toEqual([
      'Stop herdr’s service of agent and its start with the server.',
      'The web server has nothing of the board’s to remove.',
      'The user agent was not made by the board: kept.',
    ])
  })

  test('in Russian too', () => {
    expect(undoWill(facts(), false, null, ru)[0]).toBe(
      'Остановить службу herdr пользователя agent и её запуск вместе с сервером.',
    )
  })

  test('nothing to undo: no record, no web part, no service, no sudo, no user of its own to remove', () => {
    const none = facts({ record: false, service: false, home: null, ours: false })
    expect(undoNothing(none, true, false)).toBe(true)
    expect(undoNothing(none, false, true)).toBe(false)
    expect(undoNothing(facts({ record: false, service: false }), false, false)).toBe(true)
    expect(undoNothing(facts({ record: false, service: false }), true, false)).toBe(false)
  })

  test('the facts from the round: the record’s user and packages', () => {
    const b: BoardFacts = {
      record: null,
      user: { name: 'agent', home: '/home/agent', ours: true },
      sudo: true,
      service: false,
    }
    expect(undoFactsOf(b)).toEqual({
      user: 'agent',
      home: '/home/agent',
      ours: true,
      record: false,
      sudo: true,
      service: false,
      desktop: [],
      desktopLibs: [],
    })
  })
})

describe('the version on the server', () => {
  const copy = readBoardFacts(out(`@@record ${JSON.stringify(RECORD)}`, '@@user '))?.record
  const git = readBoardFacts(
    out(
      `@@record ${JSON.stringify({ ...RECORD, source: { kind: 'git', repo: 'https://user:token@example.com/x.git', ref: 'main', commit: SHA } })}`,
      '@@user ',
    ),
  )?.record

  test('what the record says, without the repository (a URL may carry a token)', () => {
    if (!copy || !git) throw new Error('no record')
    expect(boardVersionOf(copy)).toEqual({ commit: SHA, changes: true, ref: null, at: RECORD.at })
    expect(boardVersionOf(git)).toEqual({ commit: SHA, changes: false, ref: 'main', at: RECORD.at })
    expect(JSON.stringify(boardVersionOf(git))).not.toContain('token')
    expect(REPO).toBeTruthy()
  })

  test('the card’s four states: unknown, not installed, up to date, an update', () => {
    const v = { commit: SHA, changes: true, ref: null, at: RECORD.at }
    expect(boardState(undefined, null)).toBe('unknown')
    expect(boardState(null, { commit: SHA, changes: true })).toBe('unknown')
    expect(boardState({ version: null }, { commit: SHA, changes: true })).toBe('none')
    expect(boardState({ version: v }, { commit: SHA, changes: true })).toBe('current')
    // another commit, or the same one with or without local changes
    expect(boardState({ version: v }, { commit: OTHER, changes: true })).toBe('update')
    expect(boardState({ version: v }, { commit: SHA, changes: false })).toBe('update')
    // no checkout here: nothing to compare with
    expect(boardState({ version: v }, null)).toBe('current')
  })

  test('in words', () => {
    expect(versionLine({ commit: SHA, changes: true }, en)).toBe('version 1a2b3c4 (with local changes)')
    expect(versionLine({ commit: SHA, changes: false }, ru)).toBe('версия 1a2b3c4')
  })
})

describe('the command that removes it', () => {
  test('the pack received as the install’s, its bootstrap’s --undo without a question; the user only when ticked', () => {
    const r = removerScript({ removeUser: false, lang: 'en' })
    expect(r.split('\n')[0]).toBe('# agent-board: undo')
    expect(r).toContain('umask 077')
    expect(r).toContain('base64 -d > "$d/pack.tar.gz"')
    expect(r).toContain('sh "$d/src/server-install.sh" --archive "$d/pack.tar.gz" --undo --lang en --yes </dev/null')
    expect(r).not.toContain('--remove-user')
    expect(removerScript({ removeUser: true, lang: 'ru' })).toContain(
      '--archive "$d/pack.tar.gz" --undo --remove-user --lang ru --yes </dev/null',
    )
  })
})

test('the flags the remover hands the install are ones it takes', async () => {
  const { installFlags } = await import('../../src/core/server-install.ts')
  const f = installFlags([
    '--archive',
    '/tmp/agent-board-undo.x/pack.tar.gz',
    '--undo',
    '--remove-user',
    '--lang',
    'ru',
    '--yes',
  ])
  expect(f).toMatchObject({ undo: true, removeUser: true, yes: true, lang: 'ru' })
})
