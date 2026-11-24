// Pure node-routing helpers (#701): machine hints, routing key comparison,
// candidate item matching, device ordering, request body parsing, and result validation.
import { describe, expect, test } from 'bun:test'
import type { Item } from '../../../src/core/types.ts'
import {
  hintMachine,
  hintPane,
  isNodeOnly,
  isRouteResult,
  matchNodeItem,
  type NodeRouteCandidate,
  offlineHeldNote,
  offlineRetryNote,
  orderNodeDevices,
  parseRouteItemsBody,
  remoteMachineHint,
  sameTgKey,
} from '../../../src/core/wake/node-route.ts'

const item = (fields: Partial<Item> = {}): Item => ({
  key: '@server-1:11111111-1111-4111-8111-111111111111',
  session: '11111111-1111-4111-8111-111111111111',
  pane: 'w1:p1',
  workspace: 'Main',
  cwd: '/home/anna/work/billing',
  status: 'idle',
  name: 'Billing',
  autoName: 'Billing',
  category: 'other',
  categorySet: false,
  column: 'idle',
  attention: '',
  agent: 'claude',
  ...fields,
})

describe('isNodeOnly', () => {
  test('true only when node is configured and nodes is absent', () => {
    expect(isNodeOnly({})).toBe(false)
    expect(isNodeOnly({ nodes: { id: 'laptop', devices: {} } })).toBe(false)
    expect(isNodeOnly({ node: { id: 'server-1' } })).toBe(true)
    expect(isNodeOnly({ node: { id: 'server-1' }, nodes: { id: 'server-1', devices: {} } })).toBe(false)
    expect(isNodeOnly({ node: false, nodes: false })).toBe(false)
  })
})

describe('pane hints', () => {
  test('hintMachine, hintPane, and remoteMachineHint parse <machine>:<pane>', () => {
    expect(hintMachine('SERVER-1:w1:p2')).toBe('SERVER-1')
    expect(hintPane('SERVER-1:w1:p2')).toBe('w1:p2')
    expect(hintMachine('w1:p2')).toBeNull()
    expect(hintPane('w1:p2')).toBe('w1:p2')
    expect(hintMachine(':w1:p2')).toBeNull()
    expect(hintMachine('')).toBeNull()
    expect(hintPane('')).toBeNull()

    expect(remoteMachineHint('SERVER-1:w1:p2', 'LAPTOP')).toBe('SERVER-1')
    expect(remoteMachineHint('laptop:w1:p2', 'LAPTOP')).toBeNull()
    expect(remoteMachineHint('w1:p2', 'LAPTOP')).toBeNull()
  })
})

describe('sameTgKey', () => {
  test('topic keys match strictly while paths normalize slashes, trailing slashes, and Windows drives', () => {
    expect(sameTgKey('topic:Main', 'topic:Main')).toBe(true)
    expect(sameTgKey('topic:Main /', 'topic:Main')).toBe(false)
    expect(sameTgKey('topic:Main / hotfix', 'topic:Main / hotfix')).toBe(true)
    expect(sameTgKey('C:\\Work\\Проект x 50%\\', 'c:/Work/Проект x 50%')).toBe(true)
    expect(sameTgKey('/work/Проект x 50%/', '/work/Проект x 50%')).toBe(true)
  })
})

describe('matchNodeItem', () => {
  test('prefers pane hint, then live_panes, then tgKey/cwd, with awake before sleeping and newest activity first', () => {
    const awakeOther = item({
      key: '@server-1:aaa',
      pane: 'w1:p2',
      tgKey: 'topic:Other',
      activity: 200,
    })
    const sleepingTopic = item({
      key: '@server-1:bbb',
      pane: null,
      formerPanes: ['w1:p7'],
      sleeping: true,
      tgKey: 'topic:Billing',
      activity: 500,
    })
    const awakeTopicOlder = item({
      key: '@server-1:ccc',
      pane: 'w1:p3',
      tgKey: 'topic:Billing',
      activity: 100,
    })
    const awakeTopicNewer = item({
      key: '@server-1:ddd',
      pane: 'w1:p4',
      tgKey: 'topic:Billing',
      activity: 300,
    })
    const piItem = item({
      key: '@server-1:/tmp/a.jsonl',
      agent: 'pi',
      pane: 'w1:p9',
      tgKey: 'topic:Billing',
      activity: 999,
    })

    const list = [piItem, awakeOther, sleepingTopic, awakeTopicOlder, awakeTopicNewer]
    expect(matchNodeItem({ key: 'topic:Billing' }, list, 'SERVER')?.key).toBe('@server-1:ddd')
    expect(matchNodeItem({ key: 'topic:Anything', pane: 'server:w1:p2' }, list, 'SERVER')?.key).toBe('@server-1:aaa')
    expect(matchNodeItem({ key: 'topic:Anything', pane: 'server:w1:p7' }, list, 'SERVER')?.key).toBe('@server-1:bbb')
    expect(
      matchNodeItem({ key: 'topic:Anything', live_panes: ['other:w1:p1', 'SERVER:w1:p3'] }, list, 'server')?.key,
    ).toBe('@server-1:ccc')
    expect(matchNodeItem({ key: 'topic:Billing' }, list, 'SERVER')?.key).toBe('@server-1:ddd')
    expect(matchNodeItem({ key: 'topic:Billing' }, [piItem], 'SERVER')).toBeNull()
  })

  test('matches cwd for directory keys when tgKey is absent, but never for topic: keys', () => {
    const winItem = item({ key: '@server-1:win', cwd: 'C:\\Work\\Проект x 50%\\' })
    expect(matchNodeItem({ key: 'c:/Work/Проект x 50%' }, [winItem], 'WIN')?.key).toBe('@server-1:win')
    expect(matchNodeItem({ key: 'topic:Проект' }, [winItem], 'WIN')).toBeNull()
  })
})

describe('orderNodeDevices', () => {
  test('orders pane machine hint > live_panes hint > live cached item > sleeping cached item > others', () => {
    const dNone: NodeRouteCandidate = { id: 'd-none', title: 'None', online: true, machine: 'M0', items: [] }
    const dSleep: NodeRouteCandidate = {
      id: 'd-sleep',
      title: 'Sleep',
      online: false,
      machine: 'M1',
      items: [item({ key: '@d-sleep:s', sleeping: true, tgKey: 'topic:Atlas' })],
    }
    const dLive: NodeRouteCandidate = {
      id: 'd-live',
      title: 'Live',
      online: true,
      machine: 'M2',
      items: [item({ key: '@d-live:a', sleeping: false, tgKey: 'topic:Atlas' })],
    }
    const dLivePane: NodeRouteCandidate = { id: 'd-lp', title: 'LP', online: true, machine: 'M3', items: [] }
    const dPinned: NodeRouteCandidate = { id: 'd-pin', title: 'Pin', online: true, machine: 'M4', items: [] }

    const ordered = orderNodeDevices({ key: 'topic:Atlas', pane: 'm4:w1:p1', live_panes: ['m3:w2:p1'] }, [
      dNone,
      dSleep,
      dLive,
      dLivePane,
      dPinned,
    ])
    expect(ordered.map(d => d.id)).toEqual(['d-pin', 'd-lp', 'd-live', 'd-sleep', 'd-none'])
  })
})

describe('parseRouteItemsBody and isRouteResult', () => {
  test('validates items and rejects malformed or oversized payloads', () => {
    expect(parseRouteItemsBody(null)).toBeNull()
    expect(parseRouteItemsBody({})).toBeNull()
    expect(parseRouteItemsBody({ items: [] })).toBeNull()
    expect(parseRouteItemsBody({ items: [{ key: '' }] })).toBeNull()
    expect(parseRouteItemsBody({ items: [{ key: 'topic:A' }], liveOnly: 'yes' })).toBeNull()

    const parsed = parseRouteItemsBody({
      items: [{ key: 'topic:A', text: 'hi', meta: { message_id: 42 }, id: 7 }],
      liveOnly: true,
    })
    expect(parsed).toEqual({
      items: [{ key: 'topic:A', text: 'hi', meta: { message_id: '42' }, id: 7 }],
      liveOnly: true,
    })

    expect(isRouteResult({ ok: true })).toBe(true)
    expect(isRouteResult({ ok: true, note: 'hi' })).toBe(true)
    expect(isRouteResult({ skip: true, note: 'missing' })).toBe(true)
    expect(isRouteResult({ retry: 30, note: 'later' })).toBe(true)
    expect(isRouteResult({ retry: 0 })).toBe(false)
    expect(isRouteResult({ skip: true })).toBe(false)
    expect(isRouteResult(null)).toBe(false)
  })

  test('offline notes contain no em or en dashes', () => {
    for (const note of [offlineHeldNote('Atlas Server'), offlineRetryNote('Atlas Server')]) {
      expect(note).not.toContain('\u2014')
      expect(note).not.toContain('\u2013')
    }
  })
})
