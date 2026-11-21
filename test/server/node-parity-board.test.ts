// What a node needs of its profile between running boards (#602, #603): a master and its node as
// sandbox boards (test/support/node-pair.ts). The master's profile has Code Mode on in its settings
// and its notice answered in .claude.json, and MemPalace's hooks: a script that reads a config with
// a token beside it and keeps its own offsets file there. After one sync the node's .claude.json
// has the answers and every key it had; the script travels and neither file beside it does, each
// said; `board nodes sync` prints the answers given and the file to give. The token is nowhere on
// the node, in no request and no log.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nodePair } from '../support/node-pair.ts'
import type { ChildResult, Sandbox } from '../support/sandbox.ts'

const CANARY = 'canary-parity-board-3e7d'
const profileDir = (box: Sandbox): string => join(box.env.HOME as string, '.claude')
function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}
const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string): void => {
    let names: string[] = []
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(at, name)
      try {
        if (statSync(full).isDirectory()) walk(full)
        else out[full] = readFileSync(full, 'latin1')
      } catch {}
    }
  }
  walk(dir)
  return out
}

/** The master's profile as the first real node met it (#602, #603), with the master's own paths. */
function ownerProfile(box: Sandbox): void {
  const dir = profileDir(box)
  // Run by Bun, a program the node has whatever its PATH, so the hook travels on any test machine.
  const script = join(dir, 'mempalace-memory', 'save.mjs')
  put(
    dir,
    'mempalace-memory/save.mjs',
    "import { readFileSync } from 'node:fs'\nconst cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url)))\nconst state = new URL('./offsets.json', import.meta.url)\n",
  )
  put(
    dir,
    'mempalace-memory/config.json',
    JSON.stringify({ user_name: 'owner', url: 'https://m.example', token: CANARY }),
  )
  put(dir, 'mempalace-memory/offsets.json', JSON.stringify({ last: 7 }))
  put(
    dir,
    'settings.json',
    JSON.stringify({
      env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: `bun "${script}"` }] }] },
    }),
  )
  writeFileSync(
    join(box.env.HOME as string, '.claude.json'),
    JSON.stringify({
      codeModeCaveatsAcceptedV1: true,
      codeModeAutoModeCaveatAcceptedV1: true,
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: CANARY },
    }),
  )
}

describe("a node gets the owner's answers, and the files a hook reads are said (#602, #603)", () => {
  test('one sync: .claude.json on the node, the script without its files, board nodes sync says both', async () => {
    const pair = await nodePair({
      masterSetup: ownerProfile,
      nodeSetup(_id, box) {
        writeFileSync(join(box.env.HOME as string, '.claude.json'), JSON.stringify({ numStartups: 5, projects: {} }))
      },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    await pair.waitDevice('server-1', d => d.link?.state === 'online' && d.status !== null, 15_000)
    const nodeDir = profileDir(node.box)

    const res = await fetch(`${pair.master.url}/api/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ op: 'sync', id: 'server-1' }),
    })
    const r = (await res.json()) as {
      ok: boolean
      lines: { kind: string; name: string; verdict: string; why: string }[]
    }
    expect(r.ok).toBe(true)

    // The answers, and every key the node's file had.
    expect(JSON.parse(readFileSync(join(node.box.env.HOME as string, '.claude.json'), 'utf8'))).toEqual({
      numStartups: 5,
      projects: {},
      codeModeAutoModeCaveatAcceptedV1: true,
      codeModeCaveatsAcceptedV1: true,
    })
    // The script travels; the config with the token and the script's own state do not.
    expect(existsSync(join(nodeDir, 'mempalace-memory', 'save.mjs'))).toBe(true)
    expect(existsSync(join(nodeDir, 'mempalace-memory', 'config.json'))).toBe(false)
    expect(existsSync(join(nodeDir, 'mempalace-memory', 'offsets.json'))).toBe(false)
    expect(r.lines.filter(l => l.kind === 'file' && l.verdict !== 'sent').map(l => [l.name, l.verdict, l.why])).toEqual(
      [
        ['mempalace-memory/config.json', 'needs-secret', 'secret-file'],
        ['mempalace-memory/offsets.json', 'not-sent', 'script-state'],
      ],
    )

    // board nodes sync, as an agent runs it.
    mkdirSync(dirname(configPath(pair.master.box)), { recursive: true })
    writeFileSync(
      configPath(pair.master.box),
      JSON.stringify({
        language: 'en',
        wakeUrl: '',
        port: Number(new URL(pair.master.url).port),
        nodes: {
          id: 'laptop',
          devices: { 'server-1': { link: { kind: 'direct', url: `http://127.0.0.1:${node.proxy.port}` } } },
        },
      }),
    )
    const cli: ChildResult = await pair.master.box.run('cli', { args: ['nodes', 'sync', 'server-1'], env: {} }).exited
    const out = cli.stdout.trim().split('\n')
    expect(out).toContain('ack codeModeCaveatsAcceptedV1: sent (acknowledged) · env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE')
    expect(out).toContain('file mempalace-memory/config.json: needs-secret (secret-file) · mempalace-memory/save.mjs')
    expect(out).toContain('file mempalace-memory/offsets.json: not-sent (script-state) · mempalace-memory/save.mjs')

    for (const req of node.proxy.received) expect(`${req.request} ${req.body}`).not.toContain(CANARY)
    for (const [file, text] of Object.entries(files(node.box.dir)))
      expect([file, text.includes(CANARY)]).toEqual([file, false])
    for (const proc of [pair.master.proc, node.proc]) expect(JSON.stringify(proc.messages)).not.toContain(CANARY)
    expect(cli.stdout).not.toContain(CANARY)
  }, 90_000)
})
