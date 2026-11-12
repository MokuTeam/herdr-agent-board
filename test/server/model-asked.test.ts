// A session started on a model of its own (#380): its card says the model the start asked for
// (`modelWant`, spawn-agent --model or the new-session window's Model field), and the board hands
// it to the page as `modelAsked`, which the session sheet's meter shows. Sessions started on the
// profile's default carry nothing new.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Item } from '../../src/core/types.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

describe('the model a start asked for', () => {
  const sandbox = sharedSandbox()
  let box: Sandbox
  let url = ''
  const items = async () => ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items

  beforeAll(async () => {
    box = await sandbox()
    const pane = (n: number) => ({
      pane_id: `p${n}`,
      agent: 'claude',
      agent_session: { value: `s${n}` },
      agent_status: 'idle',
      cwd: box.dir,
    })
    box.state({
      'api snapshot': { result: { snapshot: { panes: [pane(1), pane(2), pane(3)], tabs: [], workspaces: [] } } },
    })
    const cards = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/cards')
    mkdirSync(cards, { recursive: true })
    writeFileSync(join(cards, 's1.json'), JSON.stringify({ key: 's1', category: 'other', modelWant: 'haiku' }))
    writeFileSync(join(cards, 's2.json'), JSON.stringify({ key: 's2', category: 'other', profileWant: 'default' }))
    writeFileSync(join(cards, 's3.json'), JSON.stringify({ key: 's3', category: 'other', modelWant: '' }))
    ;({ url } = await serveBoard(box, { language: 'en' }))
    const deadline = Date.now() + 5000
    while ((await items()).length < 3 && Date.now() < deadline) await Bun.sleep(20)
  }, 20_000)

  test('its card’s modelWant reaches the page as modelAsked; the others have no such field', async () => {
    const byKey = new Map((await items()).map(i => [i.key, i]))
    expect(byKey.get('s1')?.modelAsked).toBe('haiku')
    expect(byKey.get('s2')).not.toHaveProperty('modelAsked')
    expect(byKey.get('s3')).not.toHaveProperty('modelAsked')
  })
})
