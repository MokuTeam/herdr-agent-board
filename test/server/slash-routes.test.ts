// GET /api/session/<key>/commands (#191): what the card's chat box offers after a slash, read
// from the session's own profile and folder for Claude, pi's folders for pi, Codex's own for
// Codex, nothing for an agent the board knows no commands of; 404 for a session that is gone.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

type Command = { name: string; description: string; hint?: string; source: string }
const CLAUDE = '030bc85e-c173-4999-b250-c85a4d5595be'
const CODEX = '01a15a8a-bd97-7701-a7f7-401e4bec3149'
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('the slash commands of a session', () => {
  const sandbox = sharedSandbox()
  let url = ''
  let box: Awaited<ReturnType<typeof sandbox>>
  const items = async (): Promise<{ key: string; pane: string }[]> =>
    ((await (await fetch(`${url}/api/board`)).json()) as { items: { key: string; pane: string }[] }).items
  const keyOf = async (pane: string) => String((await items()).find(i => i.pane === pane)?.key ?? '')
  const commands = async (key: string) => {
    const r = await fetch(`${url}/api/session/${encodeURIComponent(key)}/commands`)
    return { status: r.status, body: (await r.json()) as { commands?: Command[] } }
  }

  beforeAll(async () => {
    box = await sandbox()
    const profile = join(box.dir, 'home', '.claude')
    const project = join(box.dir, 'Проект anna 100%')
    const projects = join(profile, 'projects', 'fixture')
    put(
      join(projects, `${CLAUDE}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    )
    put(join(profile, 'commands', 'standup.md'), '---\ndescription: Write the standup\nargument-hint: [day]\n---')
    put(join(profile, 'skills', 'atlas', 'SKILL.md'), '---\ndescription: Atlas skill\n---')
    put(join(project, '.claude', 'commands', 'ship.md'), '---\ndescription: Ship it\n---')
    const piDir = join(box.dir, 'pi дом 100%')
    put(join(piDir, 'prompts', 'review.md'), '---\ndescription: Review staged changes\n---')
    const piFile = join(box.dir, 'pi session 100%.jsonl')
    put(
      piFile,
      JSON.stringify({ type: 'message', id: 'p1', parentId: null, message: { role: 'assistant', content: [] } }),
    )
    const pane = (pane_id: string, agent: string, cwd: string, session?: string) => ({
      pane_id,
      agent,
      agent_status: 'idle',
      cwd,
      label: `Session ${pane_id}`,
      ...(session && { agent_session: { value: session } }),
    })
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              pane('s1', 'claude', project, CLAUDE),
              pane('s2', 'pi', project, piFile),
              pane('s3', 'codex', project, CODEX),
              pane('s4', 'agy', project),
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    ;({ url } = await serveBoard(box, { language: 'en' }, { PI_CODING_AGENT_DIR: piDir }))
    const deadline = Date.now() + 5000
    while (((await (await fetch(`${url}/api/board`)).json()) as { stale: boolean }).stale) {
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }
  }, 20_000)

  test("Claude: the folder's commands, the profile's commands and skills, then Claude's own", async () => {
    const { status, body } = await commands(await keyOf('s1'))
    expect(status).toBe(200)
    const list = body.commands ?? []
    expect(list.slice(0, 3)).toEqual([
      { name: 'ship', description: 'Ship it', source: 'project' },
      { name: 'standup', description: 'Write the standup', hint: '[day]', source: 'user' },
      { name: 'atlas', description: 'Atlas skill', source: 'user' },
    ])
    expect(list.find(c => c.name === 'compact')).toMatchObject({ source: 'builtin', hint: '[instructions]' })
  })

  test("pi: its prompts from PI_CODING_AGENT_DIR, then pi's own; Codex: its own", async () => {
    const pi = (await commands(await keyOf('s2'))).body.commands ?? []
    expect(pi[0]).toEqual({ name: 'review', description: 'Review staged changes', source: 'user' })
    expect(pi.map(c => c.name)).toContain('tree')
    expect(pi.map(c => c.name)).not.toContain('standup')
    const codex = (await commands(await keyOf('s3'))).body.commands ?? []
    expect(codex.map(c => c.name)).toContain('approvals')
    expect(codex.every(c => c.source === 'builtin')).toBe(true)
  })

  test('an agent the board knows no commands of gets none; a session that is gone is a 404', async () => {
    expect(await commands(await keyOf('s4'))).toEqual({ status: 200, body: { commands: [] } })
    expect((await commands('pane-gone')).status).toBe(404)
  })
})
