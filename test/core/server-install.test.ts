// The board on a server of the owner's (core/server-install.ts): the installer's flags, herdr's
// service, where the code came from and what `board update` makes of it, the install's own plan
// lines, its record; and the bootstrap (server-install.sh) agreeing with them.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  archiveMark,
  BOARD_SOCKET,
  BOARD_USER_COMMENT,
  BUN_VERSION,
  INSTALL_HOME,
  installFlags,
  installRecord,
  installWill,
  REPO,
  type Source,
  serviceUnit,
  sourceLine,
  sourceOf,
  updateRef,
} from '../../src/core/server-install.ts'
import { SUPPORTED } from '../../src/core/server-look.ts'
import { USER_COMMENT } from '../../src/core/server-texts.ts'

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const GIT: Source = { kind: 'git', repo: REPO, ref: 'main', commit: SHA }
const PACK: Source = { kind: 'archive', commit: SHA, changes: true }
const en = translator('en')
const ru = translator('ru')
const BOOTSTRAP = readFileSync(join(import.meta.dir, '..', '..', 'server-install.sh'), 'utf8').replaceAll('\r', '')

describe('the flags', () => {
  test('defaults: main, the repository, agent, no sudo', () => {
    expect(installFlags(['--domain', 'Workbench.Example.com.'])).toEqual({
      domain: 'workbench.example.com',
      ref: 'main',
      repo: REPO,
      user: 'agent',
      sudo: false,
      undo: false,
      removeUser: false,
      yes: false,
      archive: null,
      lang: null,
    })
  })

  test('every flag', () => {
    const f = installFlags([
      '--domain',
      'w.example.com',
      '--ref',
      'feature/x',
      '--repo',
      'file:///opt/board.git',
      '--user',
      'bob',
      '--sudo',
      '--archive',
      '/tmp/x/pack.tar.gz',
      '--yes',
      '--lang',
      'ru',
    ])
    expect(f).toMatchObject({
      domain: 'w.example.com',
      ref: 'feature/x',
      repo: 'file:///opt/board.git',
      user: 'bob',
      sudo: true,
      archive: '/tmp/x/pack.tar.gz',
      yes: true,
      lang: 'ru',
    })
    expect(installFlags(['--undo', '--remove-user'])).toMatchObject({ undo: true, removeUser: true, domain: null })
  })

  test('refused: what would reach a shell or a config unchecked', () => {
    for (const argv of [
      ['--domain', 'a;b.example.com'],
      ['--domain'],
      ['--ref', '-x'],
      ['--ref', 'a..b'],
      ['--ref', 'main; rm -rf /'],
      ['--repo', "https://x/'y"],
      ['--user', 'root'],
      ['--user', 'a b'],
      // sudo skips /etc/sudoers.d/agent-board-a.b: --sudo would do nothing
      ['--user', 'a.b'],
      ['--user', 'agent.'],
      ['--archive', 'relative.tar.gz'],
      ['--lang', 'de'],
      ['--remove-user'],
      ['--what'],
    ])
      expect('error' in installFlags(argv)).toBe(true)
  })
})

test("herdr's service: herdr server as the user, again after a failure, with the user's manager", () => {
  const unit = serviceUnit('/home/agent')
  expect(unit).toContain('ExecStart=/home/agent/.local/bin/herdr server\n')
  expect(unit).toContain('Restart=on-failure\n')
  expect(unit).toContain('WantedBy=default.target\n')
  expect(unit).toContain('Environment=PATH=/home/agent/.local/bin:/home/agent/.bun/bin:')
  expect(unit).not.toContain('User=')
})

describe('where the code came from', () => {
  test('read back: a git ref or a pack; anything else is no source', () => {
    expect(sourceOf(JSON.parse(JSON.stringify(GIT)))).toEqual(GIT)
    expect(sourceOf(JSON.parse(JSON.stringify(PACK)))).toEqual(PACK)
    expect(sourceOf({ ...GIT, commit: 'abc' })).toBeNull()
    expect(sourceOf({ ...GIT, ref: '--upload-pack=x' })).toBeNull()
    expect(sourceOf({ kind: 'archive', commit: SHA })).toBeNull()
    expect(archiveMark({ commit: SHA, changes: false })).toEqual({ commit: SHA, changes: false })
    expect(archiveMark({ commit: 'x', changes: false })).toBeNull()
  })

  test('in words', () => {
    expect(sourceLine(GIT, en)).toBe('main (1a2b3c4) from GitHub')
    expect(sourceLine({ ...GIT, repo: 'file:///opt/board.git' }, en)).toBe('main (1a2b3c4) from file:///opt/board.git')
    expect(sourceLine(PACK, en)).toBe('a copy of 1a2b3c4 from your computer, with its local changes')
    expect(sourceLine({ ...PACK, changes: false }, ru)).toBe('копия 1a2b3c4 с вашего компьютера')
  })

  test('board update follows the ref; after a pack it asks for one (call 10)', () => {
    expect(updateRef(GIT, null)).toEqual({ ref: 'main', repo: REPO })
    expect(updateRef(GIT, 'dev')).toEqual({ ref: 'dev', repo: REPO })
    expect(updateRef(PACK, 'main')).toEqual({ ref: 'main', repo: REPO })
    expect('error' in updateRef(PACK, null)).toBe(true)
    expect('error' in updateRef(null, null)).toBe(true)
    expect('error' in updateRef(GIT, '-x')).toBe(true)
  })
})

test("the install's record: read back only as the installer writes it", () => {
  const r = {
    v: 1,
    user: 'agent',
    home: '/home/agent',
    domain: 'w.example.com',
    socket: BOARD_SOCKET,
    source: GIT,
    sudo: false,
    at: 'x',
  }
  expect(installRecord(JSON.parse(JSON.stringify(r)))).toEqual(r as never)
  expect(installRecord({ ...r, socket: '/tmp/x.sock' })).toBeNull()
  expect(installRecord({ ...r, user: 'a;b' })).toBeNull()
  expect(installRecord({ ...r, source: { kind: 'git' } })).toBeNull()
})

test("the install's own plan lines", () => {
  const base = { user: 'agent', userThere: false, sudoThere: false, sudo: false, source: GIT, keysFrom: 'root' }
  expect(installWill(base, en)).toEqual([
    'Make the user agent (no sudo) for herdr, Claude Code and the board.',
    'The ssh keys of root let you log in as agent too.',
    `Install Bun ${BUN_VERSION}, herdr and Claude Code for agent, each from its own installer (what is there is kept).`,
    'Install the board: main (1a2b3c4) from GitHub.',
    'Bind prefix+a to the board in herdr for agent, when no key is bound to it.',
    'Run herdr as agent’s service, started with the server; the board opens in it.',
  ])
  expect(installWill({ ...base, userThere: true, sudoThere: true, keysFrom: null }, en)[0]).toBe(
    'Take sudo from agent again (it had it from --sudo before).',
  )
  expect(installWill({ ...base, sudo: true }, ru)[0]).toBe(
    'Создать пользователя agent, с sudo, для herdr, Claude Code и доски.',
  )
})

test("the board's user's mark is not the tunnel user's: neither's Undo takes the other", () => {
  expect(BOARD_USER_COMMENT).not.toBe(USER_COMMENT)
})

describe('the bootstrap', () => {
  test('agrees with the install: Bun, the systems, the repository, root’s folder', () => {
    expect(BOOTSTRAP).toContain(`\nBUN_VERSION=${BUN_VERSION}\n`)
    expect(BOOTSTRAP).toContain(`\nREPO=${REPO}\n`)
    expect(BOOTSTRAP).toContain(`\nHOME_DIR=${INSTALL_HOME}\n`)
    const systems = Object.entries(SUPPORTED).flatMap(([id, versions]) => versions.map(v => `${id} ${v}`))
    expect(BOOTSTRAP).toContain(`\nSUPPORTED='${systems.join('|')}'\n`)
  })

  test('hands over to the board’s own install, with stdin closed and the flags as they came', () => {
    expect(BOOTSTRAP).toContain('"$HOME_DIR/bun/bin/bun" "$HOME_DIR/src/src/entrypoints/server-install.ts" "$@"')
    expect(BOOTSTRAP.trimEnd().split('\n').slice(-2)).toEqual(['main "$@" </dev/null', 'AGENT_BOARD_MAIN'])
  })

  test('is a POSIX sh script: dash reads it', async () => {
    const dash = Bun.which('dash') ?? Bun.which('sh')
    if (!dash) return
    const p = Bun.spawn([dash, '-n'], { stdin: new TextEncoder().encode(BOOTSTRAP), stderr: 'pipe' })
    expect(await p.exited).toBe(0)
  })
})
