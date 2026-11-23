import { describe, expect, onTestFinished, test } from 'bun:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { type ClaudeHome, createClaudeHome } from '../../src/adapters/claude-home.ts'
import { profileSet } from '../../src/core/profiles.ts'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Item } from '../../src/core/types.ts'
import { createNodePilotCall } from '../../src/services/node/pilot-call.ts'

const SID = '11111111-2222-3333-4444-555555555555'

function makeEnv(): {
  root: string
  homeDir: string
  claudeDir: string
  writeTranscript: (folderKeyCwd: string, lines: Record<string, unknown>[]) => string
} {
  const root = mkdtempSync(join(tmpdir(), 'node-pilot-call-unit-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const homeDir = join(root, 'home')
  const claudeDir = join(homeDir, '.claude')
  mkdirSync(join(claudeDir, 'projects'), { recursive: true })
  const writeTranscript = (folderKeyCwd: string, lines: Record<string, unknown>[]) => {
    const dir = join(claudeDir, 'projects', projectFolderName(folderKeyCwd))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${SID}.jsonl`)
    writeFileSync(file, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    return file
  }
  return { root, homeDir, claudeDir, writeTranscript }
}

function makeItem(cwd: string): Item {
  return {
    key: SID,
    session: SID,
    pane: 'p1',
    workspace: 'Personal',
    cwd,
    status: 'idle',
    name: 'Atlas',
    autoName: 'Atlas',
    category: 'personal',
    categorySet: true,
    column: 'idle',
    attention: '',
    agent: 'claude',
    profile: 'default',
  }
}

describe('createNodePilotCall session cwd resolution (#657)', () => {
  test('resolves moved session cwd via card cwd and transcript last cwd, ignoring foreign laptop cwd', async () => {
    const { root, homeDir, claudeDir, writeTranscript } = makeEnv()
    const nodeDir = join(root, 'atlas work')
    mkdirSync(nodeDir, { recursive: true })
    writeTranscript(nodeDir, [
      { type: 'user', cwd: 'C:\\Work\\atlas', sessionId: SID, message: { role: 'user', content: 'from laptop' } },
      { type: 'user', cwd: nodeDir, sessionId: SID, message: { role: 'user', content: 'on node' } },
    ])

    const home = createClaudeHome(claudeDir)
    const profiles = profileSet(
      [{ id: 'default', title: 'Default', dir: claudeDir, color: 'indigo', hidden: false }],
      claudeDir,
    )
    let itemsList: Item[] = [makeItem(nodeDir)]
    const spawns: { file: string; args: string[]; cwd: string | undefined }[] = []

    const call = createNodePilotCall({
      profiles: () => profiles,
      homes: {
        forDir: (): Pick<ClaudeHome, 'transcriptPath'> => home,
        liveSessions: () => new Map(),
      },
      items: () => itemsList,
      log: () => {},
      claudeBin: () => '/usr/bin/claude',
      home: homeDir,
      platform: 'linux',
      env: {},
      spawn: (file, args, opts: SpawnOptions) => {
        spawns.push({ file, args, cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined })
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        })
        return child as unknown as ChildProcess
      },
    })

    // 1. Moved session with card cwd and given cwd on node: succeeds with nodeDir.
    const check1 = await call.check({ session: SID, cwd: nodeDir, profile: 'default', profileFolder: '' })
    expect(check1).toEqual({ status: 200, body: { ok: true, cwd: nodeDir, profile: 'default' } })

    // 2. Moved session with no card item and empty given cwd: falls back to transcript's last cwd.
    itemsList = []
    const check2 = await call.check({ session: SID, cwd: '', profile: 'default', profileFolder: '' })
    expect(check2).toEqual({ status: 200, body: { ok: true, cwd: nodeDir, profile: 'default' } })

    // 3. start() spawns claude in nodeDir even when given cwd is a foreign Windows path.
    itemsList = [makeItem(nodeDir)]
    const started = await call.start({
      session: SID,
      cwd: 'C:\\Work\\atlas',
      profile: 'default',
      profileFolder: '',
      fork: true,
    })
    expect(started.status).toBe(200)
    expect((started.body as { ok: boolean; cwd: string }).cwd).toBe(nodeDir)
    expect(spawns.at(-1)?.cwd).toBe(nodeDir)
    call.closeAll()
  })

  test('resolves moved session before any new turn on node using card cwd when transcript only has foreign cwd', async () => {
    const { root, homeDir, claudeDir, writeTranscript } = makeEnv()
    const nodeDir = join(root, 'проект 100%atlas')
    mkdirSync(nodeDir, { recursive: true })
    writeTranscript(nodeDir, [
      { type: 'user', cwd: 'C:\\Work\\atlas', sessionId: SID, message: { role: 'user', content: 'from laptop' } },
    ])

    const home = createClaudeHome(claudeDir)
    const profiles = profileSet(
      [{ id: 'default', title: 'Default', dir: claudeDir, color: 'indigo', hidden: false }],
      claudeDir,
    )
    const call = createNodePilotCall({
      profiles: () => profiles,
      homes: { forDir: () => home, liveSessions: () => new Map() },
      items: () => [makeItem(nodeDir)],
      log: () => {},
      claudeBin: () => '/usr/bin/claude',
      home: homeDir,
      platform: 'linux',
      env: {},
    })

    const res = await call.check({ session: SID, cwd: '', profile: 'default', profileFolder: '' })
    expect(res).toEqual({ status: 200, body: { ok: true, cwd: nodeDir, profile: 'default' } })
  })

  test('falls back to first transcript cwd when later cwd is gone, handles special chars, and returns no-cwd if none exist', async () => {
    const { root, homeDir, claudeDir, writeTranscript } = makeEnv()
    const firstDir = join(root, 'anna проект 100%')
    mkdirSync(firstDir, { recursive: true })
    writeTranscript(firstDir, [
      { type: 'user', cwd: firstDir, sessionId: SID },
      { type: 'user', cwd: join(root, 'gone-folder'), sessionId: SID },
    ])

    const home = createClaudeHome(claudeDir)
    const profiles = profileSet(
      [{ id: 'default', title: 'Default', dir: claudeDir, color: 'indigo', hidden: false }],
      claudeDir,
    )
    const call = createNodePilotCall({
      profiles: () => profiles,
      homes: { forDir: () => home, liveSessions: () => new Map() },
      items: () => [],
      log: () => {},
      claudeBin: () => '/usr/bin/claude',
      home: homeDir,
      platform: 'linux',
      env: {},
    })

    const fallback = await call.check({ session: SID, cwd: '', profile: 'default', profileFolder: '' })
    expect(fallback).toEqual({ status: 200, body: { ok: true, cwd: firstDir, profile: 'default' } })

    rmSync(firstDir, { recursive: true, force: true })
    const missing = await call.check({ session: SID, cwd: '', profile: 'default', profileFolder: '' })
    expect(missing).toEqual({
      status: 409,
      body: { ok: false, code: 'no-cwd', error: 'session folder not found on node' },
    })
  })
})
