import { describe, expect, onTestFinished, test } from 'bun:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { type ClaudeHome, createClaudeHome } from '../../src/adapters/claude-home.ts'
import { CODE_MODE_SETTINGS, NO_HOOKS_SETTINGS } from '../../src/core/pilot-call.ts'
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

function settingsOf(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined
  const idx = args.indexOf('--settings')
  return idx >= 0 ? args[idx + 1] : undefined
}

async function readSse(res: Response): Promise<{ name: string; data: string }[]> {
  const text = await res.text()
  const out: { name: string; data: string }[] = []
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue
    let name = 'message'
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length > 0) out.push({ name, data: dataLines.join('\n') })
  }
  return out
}

describe('createNodePilotCall Code Mode detection and failure reporting (#683)', () => {
  test('passes CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 for Code Mode transcripts without touching the file, and keeps plain transcripts on NO_HOOKS_SETTINGS', async () => {
    const { root, homeDir, claudeDir, writeTranscript } = makeEnv()
    const nodeDir = join(root, 'anna проект 100%')
    mkdirSync(nodeDir, { recursive: true })
    // Profile settings.json enables Code Mode, yet plain transcripts must still get NO_HOOKS_SETTINGS.
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' } }),
    )

    const home = createClaudeHome(claudeDir)
    const profiles = profileSet(
      [{ id: 'default', title: 'Default', dir: claudeDir, color: 'indigo', hidden: false }],
      claudeDir,
    )
    const spawns: { args: string[] }[] = []

    const call = createNodePilotCall({
      profiles: () => profiles,
      homes: { forDir: (): Pick<ClaudeHome, 'transcriptPath'> => home, liveSessions: () => new Map() },
      items: () => [makeItem(nodeDir)],
      log: () => {},
      claudeBin: () => '/usr/bin/claude',
      home: homeDir,
      platform: 'linux',
      env: {},
      spawn: (_file, args) => {
        spawns.push({ args })
        return Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        }) as unknown as ChildProcess
      },
    })

    // 1. Code Mode marker after a >300 KiB payload (spans chunk boundaries) -> CODE_MODE_SETTINGS; file unchanged.
    const bigText = 'x'.repeat(300 * 1024)
    const transcriptFile = writeTranscript(nodeDir, [
      { type: 'user', cwd: nodeDir, sessionId: SID, message: { role: 'user', content: bigText } },
      { type: 'repl-mode', replMode: true, sessionId: SID },
    ])
    const beforeBytes = readFileSync(transcriptFile)

    const resCodeMode = await call.start({
      session: SID,
      cwd: nodeDir,
      profile: 'default',
      profileFolder: '',
      fork: true,
    })
    expect(resCodeMode.status).toBe(200)
    expect(settingsOf(spawns.at(-1)?.args)).toBe(CODE_MODE_SETTINGS)
    expect(readFileSync(transcriptFile)).toEqual(beforeBytes)

    // 2. Plain transcript mentioning "repl-mode" in text -> exact NO_HOOKS_SETTINGS (even though profile enables Code Mode).
    writeTranscript(nodeDir, [
      {
        type: 'user',
        cwd: nodeDir,
        sessionId: SID,
        message: { role: 'user', content: 'Discuss {"type":"repl-mode","replMode":true}' },
      },
    ])
    const resQuoted = await call.start({
      session: SID,
      cwd: nodeDir,
      profile: 'default',
      profileFolder: '',
      fork: true,
    })
    expect(resQuoted.status).toBe(200)
    expect(settingsOf(spawns.at(-1)?.args)).toBe(NO_HOOKS_SETTINGS)

    // 3. Transcript with replMode: false only -> exact NO_HOOKS_SETTINGS.
    writeTranscript(nodeDir, [
      { type: 'repl-mode', replMode: false, sessionId: SID },
      { type: 'user', cwd: nodeDir, sessionId: SID, message: { role: 'user', content: 'hi' } },
    ])
    const resFalse = await call.start({
      session: SID,
      cwd: nodeDir,
      profile: 'default',
      profileFolder: '',
      fork: true,
    })
    expect(resFalse.status).toBe(200)
    expect(settingsOf(spawns.at(-1)?.args)).toBe(NO_HOOKS_SETTINGS)

    // 4. Missing transcript on fork:false falls back to profile settings.json.
    rmSync(transcriptFile)
    const resMissingCm = await call.start({
      session: SID,
      cwd: nodeDir,
      profile: 'default',
      profileFolder: '',
      fork: false,
    })
    expect(resMissingCm.status).toBe(200)
    expect(settingsOf(spawns.at(-1)?.args)).toBe(CODE_MODE_SETTINGS)

    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({}))
    const resMissingPlain = await call.start({
      session: SID,
      cwd: nodeDir,
      profile: 'default',
      profileFolder: '',
      fork: false,
    })
    expect(resMissingPlain.status).toBe(200)
    expect(settingsOf(spawns.at(-1)?.args)).toBe(NO_HOOKS_SETTINGS)

    call.closeAll()
  })

  test('surfaces stdout result errors, plain stdout without newline, and signal names when stderr is empty', async () => {
    const { root, homeDir, claudeDir, writeTranscript } = makeEnv()
    const nodeDir = join(root, 'proj')
    mkdirSync(nodeDir, { recursive: true })
    writeTranscript(nodeDir, [{ type: 'user', cwd: nodeDir, sessionId: SID, message: { role: 'user', content: 'hi' } }])

    const home = createClaudeHome(claudeDir)
    const profiles = profileSet(
      [{ id: 'default', title: 'Default', dir: claudeDir, color: 'indigo', hidden: false }],
      claudeDir,
    )
    const children: {
      child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
    }[] = []
    const logs: string[] = []

    const call = createNodePilotCall({
      profiles: () => profiles,
      homes: { forDir: (): Pick<ClaudeHome, 'transcriptPath'> => home, liveSessions: () => new Map() },
      items: () => [makeItem(nodeDir)],
      log: text => logs.push(text),
      claudeBin: () => '/usr/bin/claude',
      home: homeDir,
      platform: 'linux',
      env: {},
      spawn: () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        })
        children.push({ child })
        return child as unknown as ChildProcess
      },
    })

    // 1. JSON result error on stdout with empty stderr -> exit.stderr + 409 stdin include the reason.
    const r1 = await call.start({ session: SID, cwd: nodeDir, profile: 'default', profileFolder: '', fork: true })
    expect(r1.status).toBe(200)
    const id1 = (r1.body as { id: string }).id
    const c1 = children[0]?.child
    if (!c1) throw new Error('missing child 0')
    c1.stdout.write(
      `${JSON.stringify({ type: 'result', is_error: true, errors: ['Failed to resume session: Code Mode off'] })}\n`,
    )
    c1.emit('close', 1, null)

    const events1 = await readSse(call.events(id1, new Request('http://127.0.0.1/events')))
    const exit1 = JSON.parse(events1.find(e => e.name === 'exit')?.data ?? '{}') as { code: number; stderr: string }
    expect(exit1.code).toBe(1)
    expect(exit1.stderr).toContain('Failed to resume session: Code Mode off')

    const stdin1 = call.stdin(id1, { line: '{"type":"user"}' })
    expect(stdin1.status).toBe(409)
    expect((stdin1.body as { error: string }).error).toContain('Failed to resume session: Code Mode off')
    expect(logs.some(l => l.includes('Failed to resume session: Code Mode off'))).toBe(true)

    // 2. Plain stdout without trailing newline before close -> flushed into exit.stderr.
    const r2 = await call.start({ session: SID, cwd: nodeDir, profile: 'default', profileFolder: '', fork: true })
    const id2 = (r2.body as { id: string }).id
    const c2 = children[1]?.child
    if (!c2) throw new Error('missing child 1')
    c2.stdout.write('unterminated plain failure')
    c2.emit('close', 1, null)
    const events2 = await readSse(call.events(id2, new Request('http://127.0.0.1/events')))
    const exit2 = JSON.parse(events2.find(e => e.name === 'exit')?.data ?? '{}') as { code: number; stderr: string }
    expect(exit2.stderr).toContain('unterminated plain failure')

    // 3. Terminated by signal with empty stdout/stderr -> signal name reported.
    const r3 = await call.start({ session: SID, cwd: nodeDir, profile: 'default', profileFolder: '', fork: true })
    const id3 = (r3.body as { id: string }).id
    const c3 = children[2]?.child
    if (!c3) throw new Error('missing child 2')
    c3.emit('close', null, 'SIGKILL')
    const events3 = await readSse(call.events(id3, new Request('http://127.0.0.1/events')))
    const exit3 = JSON.parse(events3.find(e => e.name === 'exit')?.data ?? '{}') as {
      code: number | null
      stderr: string
    }
    expect(exit3.code).toBeNull()
    expect(exit3.stderr).toContain('SIGKILL')

    call.closeAll()
  })
})
