// The page of the board on its own server (the payload's `server`, src/core/on-server.ts): no
// Remote access…, no MokuPilot…, and nothing that opens on this computer in the menus; a board on a
// PC (no `server`) offers them as before (models/settings-menu.ts, models/board-menus.ts).
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { type BoardMenuDeps, menuFor } from '../../web/src/models/board-menus.ts'
import { ALL_LANES } from '../../web/src/models/lane-picks.ts'
import { boardOnServer, offersAccess, offersMokupilot } from '../../web/src/models/settings-menu.ts'
import { FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'

const t = translator('en')

describe('Settings', () => {
  test('on the board’s own server: no Remote access…, no MokuPilot…', () => {
    expect(boardOnServer({ server: true })).toBe(true)
    expect(offersAccess(false, { server: true })).toBe(false)
    expect(offersMokupilot({ server: true, mokupilot: true })).toBe(false)
  })

  test('on a PC as before: Remote access… on the local page only, MokuPilot… always', () => {
    const payloads: ({ mokupilot?: boolean; server?: boolean } | null | undefined)[] = [
      {},
      { mokupilot: false },
      null,
      undefined,
    ]
    for (const payload of payloads) {
      expect(boardOnServer(payload)).toBe(false)
      expect(offersAccess(false, payload)).toBe(true)
      expect(offersAccess(true, payload)).toBe(false)
      expect(offersMokupilot(payload)).toBe(true)
    }
  })
})

/** The ids of a file chip's menu, with the payload's `server` as given. */
function chipMenuIds(server: boolean | undefined): string[] {
  const world = new FakeWorld({ viewport: { w: 100, h: 100 } })
  world.install()
  try {
    for (const node of parseHtml('<span id="x" data-fs="file" data-abs="/srv/app/a.ts">a.ts</span>'))
      if (node.kind === 'element') world.mount(node)
    const none = () => undefined
    const deps = {
      t: () => t,
      canMutate: () => true,
      canEdit: () => true,
      item: none,
      column: () => 'idle',
      category: () => 'other',
      state: () => ({
        open: null,
        filter: ALL_LANES,
        sleepers: true,
        data: { categories: [], ...(server === undefined ? {} : { server }) },
      }),
      launch: null,
      tidyCount: () => 0,
      do: new Proxy({}, { get: () => none }),
    } as unknown as BoardMenuDeps
    const menu = menuFor(world.document.querySelector('#x'), { x: 0, y: 0 }, deps)
    return (menu?.items ?? []).flatMap(i => ('id' in i ? [i.id] : []))
  } finally {
    world.uninstall()
  }
}

describe('a file chip’s menu', () => {
  test('on the board’s own server: nothing opens on this computer', () => {
    const ids = chipMenuIds(true)
    expect(ids).toContain('look')
    expect(ids).not.toContain('open')
    expect(ids).not.toContain('reveal')
  })

  test('on a PC as before: open and show in its folder', () => {
    expect(chipMenuIds(undefined)).toEqual(expect.arrayContaining(['look', 'open', 'reveal', 'copyPath']))
  })
})
