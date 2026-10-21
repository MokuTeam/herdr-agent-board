import { expect, test } from 'bun:test'
import { cardStore } from '../../src/core/card-store.ts'

test('the default cards and schedules keep the existing layout on Unix and Windows', () => {
  expect(cardStore({}, '/home/u', 'linux')).toEqual({
    cards: '/home/u/.local/state/herdr/plugins/agent-board/cards',
    state: '/home/u/.local/state/herdr/plugins/agent-board',
    schedule: '/home/u/.local/state/herdr/plugins/agent-board/schedule',
    explicit: false,
    customState: false,
  })
  const windows = cardStore({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u', 'win32')
  expect(windows.cards).toBe('C:\\Users\\u\\AppData\\Local\\herdr\\plugins\\agent-board\\cards')
  expect(windows.customState).toBe(false) // LOCALAPPDATA is normal on Windows.
})

test('only cards move: spaces, other alphabets and percent signs remain literal', () => {
  for (const [platform, home, local, cards] of [
    ['darwin', '/Users/u', '/tmp/preview', '/Users/u/Работа 100%/cards'],
    ['linux', '/home/u', '/tmp/preview', '/srv/Team cards/100%'],
    ['win32', 'C:\\Users\\u', 'D:\\preview', 'E:\\Работа 100%\\cards'],
    ['win32', 'C:\\Users\\u', 'D:\\preview', '\\\\server\\shared\\Team cards'],
  ] as const) {
    const env = { LOCALAPPDATA: local, HERDR_BOARD_CARDS_DIR: cards }
    const before = cardStore({ LOCALAPPDATA: local }, home, platform)
    const after = cardStore(env, home, platform)
    expect(after.cards).toBe(cards)
    expect(after.state).toBe(before.state)
    expect(after.schedule).toBe(before.schedule)
    expect(after.explicit).toBe(true)
  }
})

test('empty keeps the default; relative and tilde paths are refused instead of following cwd', () => {
  expect(cardStore({ HERDR_BOARD_CARDS_DIR: '' }, '/home/u', 'linux').explicit).toBe(false)
  for (const [platform, path] of [
    ['linux', './cards'],
    ['darwin', '~/cards'],
    ['win32', 'C:cards'],
    ['win32', '.\\cards'],
    ['win32', '\\cards'],
  ] as const)
    expect(() => cardStore({ HERDR_BOARD_CARDS_DIR: path }, '/home/u', platform)).toThrow(
      'HERDR_BOARD_CARDS_DIR must be an absolute directory path',
    )
})
