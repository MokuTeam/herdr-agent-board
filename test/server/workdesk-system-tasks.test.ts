import { expect, test } from 'bun:test'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'
import { mcp } from '../support/workdesk-fixture.ts'

const completed = {
  key: 'TRIPIO-32',
  title: 'Трейс чата Помощник',
  project: 'Tripio',
  status: 'done',
  updated_at: 1795706794784,
  executor: 'Tripio agent',
  url: 'https://workdesk.test/workdesk/#tasks/TRIPIO-32',
  summary: 'Private result',
}
const running = {
  ...completed,
  key: 'TRIPIO-33',
  title: 'Системная задача',
  status: 'doing',
  updated_at: completed.updated_at + 10,
  url: 'https://workdesk.test/workdesk/#tasks/TRIPIO-33',
}
const ready = (data: BoardPayload) => {
  const feed = data.workdeskSystemTasks
  return feed?.state === 'ready' ? feed.tasks : undefined
}

test('Tripio feed reads pages independently of assignment routing and replaces tasks by key', async () => {
  const box = await sandbox()
  const fake = mcp(box.dir)
  fake.write({
    tasks: [],
    systemPages: {
      first: { tasks: [running], next_cursor: 'page-2' },
      'page-2': { tasks: [completed, { ...running, updated_at: 0 }], next_cursor: null },
    },
  })
  const { url } = await serveBoard(box, {
    workdeskSystemTasks: { ...fake.config, intervalSec: 1 },
  })
  const board = async (): Promise<BoardPayload> => (await fetch(`${url}/api/board`)).json()
  async function waitFor(predicate: (data: BoardPayload) => boolean): Promise<void> {
    const deadline = Date.now() + 5000
    while (!predicate(await board())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for system task feed')
      await Bun.sleep(25)
    }
  }
  await waitFor(data => ready(data) !== undefined)
  const data = await board()
  expect(data.categories.some(lane => lane.id === 'tripio')).toBe(true)
  expect(data.workdesk).toBeUndefined()
  expect(data.items).toEqual([])
  expect(ready(data)).toEqual([
    {
      key: running.key,
      title: running.title,
      status: 'doing',
      updatedAt: running.updated_at,
      executor: running.executor,
      url: running.url,
    },
    {
      key: completed.key,
      title: completed.title,
      status: 'done',
      updatedAt: completed.updated_at,
      executor: completed.executor,
      url: completed.url,
    },
  ])
  const firstPoll = fake.calls().filter(call => call.method === 'tools/call')
  expect(firstPoll.map(call => call.params)).toEqual([
    { name: 'list_tripio_system_tasks', arguments: { limit: 100 } },
    { name: 'list_tripio_system_tasks', arguments: { limit: 100, cursor: 'page-2' } },
  ])
  fake.write({
    tasks: [],
    systemPages: {
      first: { tasks: [{ ...running, status: 'done', updated_at: running.updated_at + 20 }], next_cursor: null },
    },
  })
  await waitFor(data => ready(data)?.[0]?.status === 'done')
  expect(ready(await board())?.map(task => task.key)).toEqual([running.key])

  fake.write({ tasks: [], systemPages: { first: { tasks: [], next_cursor: null } } })
  await waitFor(data => ready(data)?.length === 0)

  fake.write({ tasks: [] })
  await waitFor(data => data.workdeskSystemTasks?.state === 'unavailable')
  expect(
    fake
      .calls()
      .filter(call => call.method === 'tools/call')
      .every(call => call.params.name === 'list_tripio_system_tasks'),
  ).toBe(true)
}, 15_000)

test('a board without a system feed keeps the existing categories and payload', async () => {
  const { url } = await serveBoard(await sandbox())
  const data = (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
  expect(data.workdeskSystemTasks).toBeUndefined()
  expect(data.categories.map(lane => lane.id)).toEqual(['other'])
})
