// Favorites on the web board's server (#64): the card's menu and the sheet set it through the
// session's card route; the board lists favorites first in their columns. Sessions that are not
// favorites go as before: no `favorite` field, the order by activity alone.
import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Item } from '../../src/core/types.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'
import type { Sandbox } from '../support/sandbox.ts'

describe('favorites', () => {
  const sandbox = sharedSandbox()
  let box: Sandbox
  let url = ''
  const card = (key: string) => {
    const file = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/cards', `${key}.json`)
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null
  }
  const set = (key: string, body: unknown) =>
    fetch(`${url}/api/session/${key}/card`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(body),
    }).then(r => r.json())
  const items = async () => ((await (await fetch(`${url}/api/board`)).json()) as { items: Item[] }).items
  /** The board once it shows what `ok` waits for. */
  async function boardWhen(ok: (items: Item[]) => boolean): Promise<Item[]> {
    const deadline = Date.now() + 5000
    for (;;) {
      const now = await items()
      if (ok(now) || Date.now() > deadline) return now
      await Bun.sleep(20)
    }
  }

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
    ;({ url } = await serveBoard(box, { language: 'en' }))
    await boardWhen(list => list.length === 3)
  }, 20_000)

  test('a favorite comes first in its column and says so; the others carry nothing new', async () => {
    const before = await items()
    expect(before.map(i => i.key)).toEqual(['s1', 's2', 's3'])
    expect(before.some(i => 'favorite' in i)).toBe(false)

    expect(await set('s3', { favorite: true })).toEqual({ ok: true })
    expect(card('s3')).toEqual(expect.objectContaining({ favorite: true }))
    const after = await boardWhen(list => list[0]?.key === 's3')
    expect(after.map(i => [i.key, i.column, i.favorite])).toEqual([
      ['s3', 'idle', true],
      ['s1', 'idle', undefined],
      ['s2', 'idle', undefined],
    ])
  })

  test('taken back, the field leaves the card and the session its place', async () => {
    expect(await set('s3', { favorite: false })).toEqual({ ok: true })
    expect(card('s3')).not.toHaveProperty('favorite')
    const after = await boardWhen(list => list[0]?.key === 's1')
    expect(after.map(i => i.key)).toEqual(['s1', 's2', 's3'])
    expect(after.some(i => 'favorite' in i)).toBe(false)
    // Anything but true or false changes nothing.
    expect(await set('s2', { favorite: 'yes' })).toEqual({ ok: true })
    expect(card('s2') ?? {}).not.toHaveProperty('favorite')
  })
})
