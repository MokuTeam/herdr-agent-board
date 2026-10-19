// The session sheet's rules (web/app.js renderSheetHead, syncAvailability, renderDetailState,
// renderSheetBody's question box, onData's detail stamp), as pure functions.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { DetailValue } from '../../web/src/models/detail-resource.ts'
import {
  askedView,
  clockText,
  contextText,
  detailNotice,
  detailOnBoard,
  detailStamp,
  draftKey,
  headButtons,
  liveEdit,
  NO_HEAD_BUTTONS,
  sessionMissing,
  sheetAvailability,
  sheetHead,
  threadPlaceholder,
  typing,
} from '../../web/src/models/sheet.ts'
import { item } from './support/board.tsx'

const t = translator('en')
const NOW = Date.UTC(2026, 9, 17, 12, 0)

test('a session is missing only while one is open: off the board, or its detail says so', () => {
  expect(sessionMissing(null, false, 'missing')).toBe(false)
  expect(sessionMissing('a', true, 'ready')).toBe(false)
  expect(sessionMissing('a', false, 'ready')).toBe(true)
  expect(sessionMissing('a', true, 'missing')).toBe(true)
  expect(sessionMissing('a', true, undefined)).toBe(false)
})

test('drafts go by the Claude session, else by the card', () => {
  expect(draftKey(item({ key: 'k', session: 's' }))).toBe('s')
  expect(draftKey(item({ key: 'k', session: null }))).toBe('k')
  expect(draftKey(null)).toBe(null)
})

test('the detail is read again when what the card says changes', () => {
  const a = item({ key: 'a', activity: 5, status: 'working', column: 'work', doing: 'x' })
  expect(detailStamp(a)).toBe('5|working|work|undefined|x|other||')
  expect(detailStamp({ ...a, wait: 'review' })).not.toBe(detailStamp(a))
  expect(detailStamp({ ...a, name: 'renamed' })).toBe(detailStamp(a))
  // A helper at work changes the sheet too, while the session itself may wait for it.
  const helping = { ...a, helpers: { running: 1, total: 1, workflows: 0, live: [], at: 9 } }
  expect(detailStamp(helping)).toBe('5|working|work|undefined|x|other|9|1')
  expect(detailStamp({ ...helping, helpers: { ...helping.helpers, at: 10 } })).not.toBe(detailStamp(helping))
})

describe('a new board and the open session’s detail', () => {
  const a = item({ key: 'a', activity: 5, status: 'working', column: 'work' })
  const fresh = { stale: false, items: [a] }
  const turn = { before: { stale: false }, board: fresh, key: 'a', stamp: detailStamp(a), status: 'ready' as const }
  test('nothing new on its card: nothing to read', () => {
    expect(detailOnBoard(turn)).toBe(null)
  })
  test('its card says something new, or the sheet just opened it: read again, at that stamp', () => {
    const moved = { ...a, column: 'done' as const, status: 'done' as const }
    expect(detailOnBoard({ ...turn, board: { stale: false, items: [moved] } })).toEqual({
      kind: 'load',
      stamp: detailStamp(moved),
    })
    expect(detailOnBoard({ ...turn, stamp: '' })).toEqual({ kind: 'load', stamp: detailStamp(a) })
  })
  test('fresh again after out-of-date data (the page starts so), or back after it was gone: read again', () => {
    expect(detailOnBoard({ ...turn, before: { stale: true } })?.kind).toBe('load')
    expect(detailOnBoard({ ...turn, before: null })?.kind).toBe('load')
    expect(detailOnBoard({ ...turn, status: 'missing' })?.kind).toBe('load')
    expect(detailOnBoard({ ...turn, before: { stale: true }, board: { stale: true, items: [a] } })).toBe(null)
  })
  test('off a fresh board it is gone; off an out-of-date one it may only be late', () => {
    expect(detailOnBoard({ ...turn, board: { stale: false, items: [] } })).toEqual({ kind: 'missing' })
    expect(detailOnBoard({ ...turn, board: { stale: true, items: [] } })).toBe(null)
  })
})

describe('the head', () => {
  test('context: percent and rounded thousands, raw tokens, nothing; unknown size reads as before', () => {
    expect(contextText({ context: 85_400, contextPct: 42.4 }, t)).toBe('context 42% · 85k')
    expect(contextText({ context: 640 }, t)).toBe('context 640')
    expect(contextText({ context: null }, t)).toBe('')
    expect(contextText({ contextPct: 10 }, t)).toBe('context 10% · undefined')
  })
  test('pill, name and the line under it', () => {
    const a = item({ key: 'a', name: 'Alpha', workspace: 'web', activity: NOW - 5 * 60_000, context: 2000 })
    expect(sheetHead(a, { missing: false, categoryTitle: 'Project', now: NOW, t })).toEqual({
      pill: { kind: 'column' },
      name: 'Alpha',
      meta: ['Project', 'workspace web', 'active 5 min ago', 'context 2k'],
      metaTitle: 'Tokens its last request carried',
    })
    const now = sheetHead(
      { ...a, activity: NOW - 10_000, workspace: null, context: null },
      {
        missing: false,
        categoryTitle: 'Project',
        now: NOW,
        t,
      },
    )
    expect([now.meta, now.metaTitle]).toEqual([['Project', 'active now'], ''])
    expect(sheetHead({ ...a, sleeping: true }, { missing: false, categoryTitle: '', now: NOW, t }).pill.kind).toBe(
      'asleep',
    )
    expect(sheetHead({ ...a, sleeping: true }, { missing: true, categoryTitle: '', now: NOW, t }).pill.kind).toBe(
      'missing',
    )
  })
  test('History needs a Claude project, Wake a sleeper, sleep an awake Claude session; the hint says when it cannot', () => {
    const a = item({ key: 'a', status: 'working' })
    expect(headButtons(a, t)).toEqual({
      historyHidden: false,
      wakeHidden: true,
      sleepHidden: false,
      sleepTitle: t('sheet.sleepBusy'),
      restartHidden: true,
      restartTitle: t('sheet.restartHint'),
      mokupilotHidden: true,
      archiveHidden: true,
      archiveTitle: t('archive.why.notClaude'),
    })
    expect(headButtons({ ...a, status: 'idle', session: null }, t)).toEqual({
      historyHidden: true,
      wakeHidden: true,
      sleepHidden: true,
      sleepTitle: t('sheet.sleepHint'),
      restartHidden: true,
      restartTitle: t('sheet.restartHint'),
      mokupilotHidden: true,
      archiveHidden: true,
      archiveTitle: t('archive.why.notClaude'),
    })
    // A MokuPilot call: with MokuPilot here, for a Claude session with an id.
    expect(headButtons({ ...a, agent: 'claude' }, t, true).mokupilotHidden).toBe(false)
    expect(headButtons({ ...a, agent: 'codex' }, t, true).mokupilotHidden).toBe(true)
    expect(headButtons({ ...a, agent: 'claude', session: null }, t, true).mokupilotHidden).toBe(true)
    expect(headButtons({ ...a, agent: 'claude' }, t, false).mokupilotHidden).toBe(true)
    expect(headButtons({ ...a, sleeping: true }, t).wakeHidden).toBe(false)
    expect(headButtons({ ...a, sleeping: true }, t).sleepHidden).toBe(true)
    expect(NO_HEAD_BUTTONS).toEqual({
      historyHidden: false,
      wakeHidden: true,
      sleepHidden: false,
      sleepTitle: undefined,
      restartHidden: true,
      restartTitle: undefined,
      mokupilotHidden: true,
      archiveHidden: true,
      archiveTitle: undefined,
    })
  })

  test('Restart for a Claude session in herdr that is awake, also mid-turn; one on its way says so and how it stands', () => {
    const a = item({ key: 'a', status: 'working', agent: 'claude' })
    expect(headButtons(a, t)).toMatchObject({ restartHidden: false, restartTitle: t('sheet.restartHint') })
    expect(headButtons({ ...a, sleeping: true }, t).restartHidden).toBe(true)
    expect(headButtons({ ...a, agent: 'codex' }, t).restartHidden).toBe(true)
    expect(headButtons({ ...a, session: null }, t).restartHidden).toBe(true)
    const restart = { id: 'r1', key: 'a', kind: 'restart', text: '', next: NOW, why: 'tasks' }
    expect(headButtons(a, t, false, [restart]).restartTitle).toBe(
      `${t('sheet.restartPending')}. ${t('restart.title.wait')}. ${t('sched.tasks')}`,
    )
    // One that gave up does not stop another being asked for.
    expect(headButtons(a, t, false, [{ ...restart, failed: 'herdr-wake is down' }]).restartTitle).toBe(
      t('sheet.restartHint'),
    )
  })
})

describe('what works now', () => {
  const scene = { canMutate: true, canEdit: true, missing: false, turn: false }
  test('fresh and present: everything; in a turn, no sleep', () => {
    expect(sheetAvailability(scene, t)).toEqual({
      blocked: false,
      banner: t('mobile.readOnly'),
      focus: false,
      wake: false,
      sleep: false,
      edit: false,
      dismiss: false,
      newHere: false,
      newHereTitle: t('launch.hereHint'),
      files: false,
      restart: false,
      archive: false,
    })
    expect(sheetAvailability({ ...scene, turn: true }, t).sleep).toBe(true)
    // A turn does not gray Restart (it waits for the turn by itself); a restart on its way does.
    expect(sheetAvailability({ ...scene, turn: true }, t).restart).toBe(false)
    expect(sheetAvailability({ ...scene, restarting: true }, t).restart).toBe(true)
    expect(sheetAvailability({ ...scene, canMutate: false }, t).restart).toBe(true)
    expect(sheetAvailability({ ...scene, missing: true }, t).restart).toBe(true)
  })
  test('without fresh herdr data the herdr actions stop; without the board the edits too', () => {
    const stale = sheetAvailability({ ...scene, canMutate: false }, t)
    expect([stale.blocked, stale.focus, stale.wake, stale.sleep, stale.newHere, stale.edit, stale.files]).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ])
    expect(stale.newHereTitle).toBe(t('mobile.readOnly'))
    const off = sheetAvailability({ ...scene, canMutate: false, canEdit: false }, t)
    expect([off.banner, off.edit, off.dismiss]).toEqual([t('live.off'), true, true])
  })
  test('a session that is gone takes every session action with it', () => {
    const gone = sheetAvailability({ ...scene, missing: true }, t)
    expect([gone.focus, gone.wake, gone.sleep, gone.edit, gone.dismiss, gone.newHere, gone.files]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    expect([gone.blocked, gone.newHereTitle]).toEqual([false, t('launch.hereHint')])
  })
})

describe('over the conversation', () => {
  const value = (fields: Partial<DetailValue<object>>): DetailValue<object> => ({
    key: 'a',
    data: null,
    status: 'idle',
    error: '',
    at: null,
    ...fields,
  })
  const scene = { missing: false, onBoard: true, outdated: false, canEdit: true }
  test('missing, an error, out of date, refreshing — or nothing', () => {
    expect(detailNotice(value({}), { ...scene, missing: true }, t).text).toBe(t('detail.missing'))
    expect(detailNotice(value({ status: 'error', error: 'offline' }), scene, t).text).toBe(
      'Could not read the conversation: offline',
    )
    expect(detailNotice(value({ status: 'ready', data: {} }), { ...scene, outdated: true }, t).text).toBe(
      t('detail.stale'),
    )
    expect(detailNotice(value({ status: 'ready' }), { ...scene, outdated: true }, t).text).toBe('')
    expect(detailNotice(value({ status: 'loading', data: {} }), scene, t).text).toBe(t('detail.refreshing'))
    expect(detailNotice(value({ status: 'loading' }), scene, t).text).toBe('')
  })
  test('when it was read, and Retry only when it can be asked again', () => {
    const at = Date.UTC(2026, 9, 17, 9, 5)
    const read = detailNotice(value({ status: 'ready', data: {}, at }), scene, t)
    expect(read.stamp).toBe(`Last read at ${clockText(at, t)}`)
    expect(read.retryDisabled).toBe(false)
    expect(detailNotice(value({ status: 'loading' }), scene, t).retryDisabled).toBe(true)
    expect(detailNotice(value({}), { ...scene, canEdit: false }, t).retryDisabled).toBe(true)
    expect(detailNotice(value({}), { ...scene, onBoard: false }, t).retryDisabled).toBe(true)
    expect(clockText(0, t)).toBe('')
  })
  test('no conversation yet: loading, or why it could not load; an empty one says so', () => {
    expect(threadPlaceholder(null, 'idle', t)).toBe(t('loading'))
    expect(threadPlaceholder(undefined, 'error', t)).toBe(t('detail.noTranscript'))
    expect(threadPlaceholder(null, 'missing', t)).toBe(t('detail.noTranscript'))
    expect(threadPlaceholder([], 'ready', t)).toBe(t('thread.empty'))
    expect(threadPlaceholder([{}], 'ready', t)).toBe(null)
  })
})

test('what it asks under "Needs me": why, the question, and whether it can be waved off', () => {
  expect(askedView(item({ key: 'a', column: 'me', attention: 'ask', question: 'Proceed?' }), t)).toEqual({
    why: 'ASKS',
    text: 'Proceed?',
    dismiss: 'No reply needed',
  })
  expect(askedView(item({ key: 'a', column: 'me', attention: 'later', question: 'x' }), t)).toEqual({
    why: 'PARKED BY YOU',
    text: t('asked.later'),
    dismiss: 'Seen',
  })
  expect(askedView(item({ key: 'a', column: 'me', attention: 'decision' }), t)).toEqual({
    why: 'NEEDS A DECISION IN THE TERMINAL',
    text: t('asked.terminal'),
    dismiss: null,
  })
  expect(askedView(item({ key: 'a', column: 'me', attention: '' }), t).why).toBe('WAITS FOR YOU')
})

describe('a card field being edited', () => {
  const at = (focused: boolean, saved: string, session = 'a') => ({ focused, saved, session })

  test('keeps what is typed while focused, then until the card moves on; Escape is the caller’s', () => {
    let edit = typing(null, at(true, 'old'), 'new')
    expect(edit).toEqual({ text: 'new', from: 'old', session: 'a' })
    expect(liveEdit(edit, at(true, 'server changed it'))?.text).toBe('new')
    expect(liveEdit(edit, at(false, 'old'))?.text).toBe('new')
    expect(liveEdit(edit, at(false, 'server changed it'))).toBe(null)
    // Still typing while the card moved on: the typing goes on from where it began, and goes once left.
    expect(typing(edit, at(true, 'server changed it'), 'newer')).toEqual({ text: 'newer', from: 'old', session: 'a' })
    // Typing again after that starts from the card's new value.
    edit = typing(edit, at(false, 'server changed it'), 'again')
    expect(edit).toEqual({ text: 'again', from: 'server changed it', session: 'a' })
    expect(liveEdit(null, at(true, 'x'))).toBe(null)
  })

  test('saved, then the value goes back: the field shows the card’s value, not the old typing', () => {
    // Waits for '' → "review", Enter: the field is left, the board then shows the saved value.
    const edit = typing(null, at(true, ''), 'review')
    const saved = liveEdit(edit, at(false, 'review'))
    expect(saved).toBe(null)
    // The edit was dropped then (the field keeps what liveEdit leaves), so clearing the note later shows ''.
    expect(liveEdit(saved, at(false, ''))).toBe(null)
    // A save that did not go through keeps the typing until the card's value moves on.
    expect(liveEdit(edit, at(false, ''))?.text).toBe('review')
  })

  test('another session with the same value: nothing typed for one shows in the other', () => {
    const edit = typing(null, at(true, '', 'a'), 'for A only')
    expect(liveEdit(edit, at(false, '', 'b'))).toBe(null)
    expect(liveEdit(edit, at(true, '', 'b'))).toBe(null)
    expect(typing(edit, at(true, '', 'b'), 'x')).toEqual({ text: 'x', from: '', session: 'b' })
  })
})
