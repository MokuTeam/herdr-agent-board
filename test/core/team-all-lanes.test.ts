// Every lane shared with a peer (#386, docs/design/assistant-bridge, 8.4): the pure rules. A peer's
// switches share a lane when it is in their list or when `allLanes` is exactly true; a session in
// no lane is shared with nobody either way. Turning every lane on widens what agents may say, so
// the owner confirms it; turning it off is free. A roster peer is an assistant's bridge when its
// caps say `assistant`; this board never says it of itself.
import { describe, expect, test } from 'bun:test'
import { hasAssistant, OUR_CAPS } from '../../src/core/team.ts'
import { allLanes, sharesLane } from '../../src/core/team-agents.ts'
import { widens } from '../../src/core/team-confirm.ts'

describe('a peer with every lane (#386)', () => {
  test('only exactly true counts; anything else in the file is a peer without it', () => {
    expect(allLanes({ allLanes: true })).toBe(true)
    for (const v of [undefined, false, 'true', 1, {}, null]) expect(allLanes({ allLanes: v })).toBe(false)
    expect(allLanes(undefined)).toBe(false)
  })

  test('a lane is shared when it is in the list, or every lane is; no lane is never shared', () => {
    const listed = { on: true, lanes: ['acme'] }
    expect(sharesLane(listed, 'acme')).toBe(true)
    expect(sharesLane(listed, 'globex')).toBe(false)
    expect(sharesLane(listed, '')).toBe(false)
    expect(sharesLane(undefined, 'acme')).toBe(false)
    expect(sharesLane({ lanes: [] }, 'acme')).toBe(false)
    const every = { on: true, lanes: [], allLanes: true }
    expect(sharesLane(every, 'acme')).toBe(true)
    expect(sharesLane(every, 'a-lane-added-later')).toBe(true)
    expect(sharesLane(every, '')).toBe(false)
    expect(sharesLane({ lanes: ['acme'], allLanes: 'yes' }, 'globex')).toBe(false)
  })

  test('an assistant is a roster peer whose caps say so; this board does not say it of itself', () => {
    expect(hasAssistant({ caps: ['threads', 'assistant'] })).toBe(true)
    expect(hasAssistant({ caps: ['threads', 'channels', 'replies', 'files'] })).toBe(false)
    expect(hasAssistant({})).toBe(false)
    expect(hasAssistant(undefined)).toBe(false)
    expect(OUR_CAPS).not.toContain('assistant')
  })
})

describe('what widens, with every lane (#386)', () => {
  const now = {
    off: false,
    peers: {
      P: { on: true, lanes: ['acme'] },
      E: { on: true, lanes: [], allLanes: true },
    },
  }

  test('every lane on widens, for a peer, a peer with no switches yet and the team; already on, it does not', () => {
    expect(widens(now, { peer: 'P', allLanes: true })).toBe(true)
    expect(widens(now, { peer: 'nobody-yet', allLanes: true })).toBe(true)
    expect(widens(now, { peer: 'team', allLanes: true })).toBe(true)
    expect(widens(now, { peer: 'E', allLanes: true })).toBe(false)
  })

  test('every lane off is free, as removing a lane is', () => {
    expect(widens(now, { peer: 'E', allLanes: false })).toBe(false)
    expect(widens(now, { peer: 'P', allLanes: false })).toBe(false)
  })

  test('the changes there were before go as they did', () => {
    expect(widens(now, { peer: 'P', lanes: ['acme', 'globex'] })).toBe(true)
    expect(widens(now, { peer: 'P', lanes: [] })).toBe(false)
    expect(widens(now, { peer: 'P', on: false })).toBe(false)
    expect(widens({ off: false, peers: {} }, { peer: 'P', on: true })).toBe(true)
    expect(widens(now, { peer: 'P', muted: true })).toBe(false)
    expect(widens(now, { peer: 'P', loop: 5 })).toBe(true)
    expect(widens(now, { listener: null })).toBe(false)
    expect(widens({ off: true, peers: {} }, { off: false })).toBe(true)
  })
})
