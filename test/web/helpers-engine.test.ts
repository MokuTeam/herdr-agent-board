// The helpers window's reads, steps, motion, focus and keys (hooks/useHelpers.ts helpersEngine) in
// a fake DOM (support/fake-dom.ts), with fake reads and the world's timers: a helper at work is read
// again every second and a half, one that could not be read every four seconds (never after a 404),
// none while the page is hidden; an answer for what is no longer on show is dropped; only the sheet's
// own helpers open over what is on show; Back steps down and from the first step closes; keys act
// only while it is the top layer; closing gives the focus back to the row it grew from, drawn anew.
// Springs share one frame loop: every world settles before it goes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { PublicHelper } from '../../src/core/helpers.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { SessionDetail } from '../../web/src/api/client.ts'
import type { HelperRead } from '../../web/src/api/helpers.ts'
import { type HelpersEngine, type HelpersKey, type HelpersRefs, helpersEngine } from '../../web/src/hooks/useHelpers.ts'
import { item } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'

const en = translator('en')

let world: FakeWorld
const engines: HelpersEngine[] = []
beforeEach(() => {
  world = new FakeWorld({ viewport: { w: 1200, h: 800 } })
  world.install()
})
afterEach(async () => {
  try {
    await world.settle()
    for (const engine of engines.splice(0)) engine.stop()
  } finally {
    world.uninstall()
  }
})

/** A fake element as the page's (the world is installed: its HTMLElement is the fake one). */
function mount(html: string): HTMLElement {
  const [node] = parseHtml(html)
  if (node?.kind !== 'element') throw new Error('no element')
  const el: FakeElement = world.mount(node)
  if (el instanceof HTMLElement) return el
  throw new Error('the world is not installed')
}

function query(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`no ${selector}`)
  return el
}

const ref = <T>(current: T) => ({ current })

const NOW = Date.now()
const helper = (id: string, more: Partial<PublicHelper> = {}): PublicHelper => ({
  id,
  kind: 'agent',
  type: 'general-purpose',
  name: '',
  description: `Task ${id}`,
  color: '',
  model: '',
  background: true,
  parent: null,
  toolUseId: null,
  workflow: null,
  phase: '',
  status: 'running',
  startedAt: NOW - 60_000,
  endedAt: null,
  activity: NOW,
  prompt: `Do ${id}.`,
  from: '',
  now: null,
  after: '',
  waiting: 0,
  tokens: null,
  result: '',
  ...more,
})
const running = (id: string): HelperRead => ({
  ok: true,
  data: { helper: { ...helper(id), tools: 1 }, workflow: null, conversation: [] },
})
const finished = (id: string): HelperRead => ({
  ok: true,
  data: { helper: { ...helper(id, { status: 'done', endedAt: NOW }), tools: 1 }, workflow: null, conversation: [] },
})
const failed = (error: string, gone = false): HelperRead => ({ ok: false, error, gone })

const session = item({ key: 'k', name: 'Here', column: 'work' })
const other = item({ key: 'other', name: 'There' })
const detail = (helpers: PublicHelper[]): SessionDetail => ({
  item: session,
  conversation: [],
  screen: '',
  dialog: null,
  checkout: false,
  helpers,
  workflows: [],
})

function setup() {
  const layer = mount(
    '<div class="ql helpers"><div class="ql-scrim"></div><section class="ql-win"></section><div class="helper-body"></div></div>',
  )
  const refs: HelpersRefs = {
    layer: ref(layer as HTMLDivElement),
    win: ref(query(layer, '.ql-win')),
    scrim: ref(query(layer, '.ql-scrim') as HTMLDivElement),
    body: ref(query(layer, '.helper-body') as HTMLDivElement),
  }
  const focus = { opened: [] as unknown[], closed: 0, top: true }
  const asked: string[] = []
  const waiting: ((r: HelperRead) => void)[] = []
  const opened: string[] = []
  const page = { hidden: false }
  const engine = helpersEngine({
    refs,
    focus: () => ({
      open: origin => void focus.opened.push(origin),
      close: () => void focus.closed++,
      isTop: () => focus.top,
    }),
    t: () => en,
    item: key => [session, other].find(i => i.key === key),
    read: (key, id) =>
      new Promise<HelperRead>(resolve => {
        asked.push(`${key}/${id}`)
        waiting.push(resolve)
      }),
    openSession: key => void opened.push(key),
    hidden: () => page.hidden,
  })
  engines.push(engine)
  /** The oldest read still waiting gets `r`; then what that sets off runs. */
  const answer = async (r: HelperRead) => {
    const resolve = waiting.shift()
    if (!resolve) throw new Error('no read waits')
    resolve(r)
    await world.flush()
  }
  const view = () => engine.view.get()
  const stack = () => view().stack.map(s => ('id' in s ? s.id : `list:${s.run ?? ''}`))
  return { engine, refs, focus, asked, waiting, answer, opened, page, view, stack }
}

const press = (key: string, altKey = false) => {
  const e = {
    key,
    altKey,
    prevented: false,
    preventDefault() {
      e.prevented = true
    },
    stopImmediatePropagation() {},
  }
  return e satisfies HelpersKey
}

describe('a helper read again', () => {
  test('every second and a half while it works; once it finished, no more', async () => {
    const { engine, asked, answer, view } = setup()
    engine.open('k', { id: 'a1' })
    expect(asked).toEqual(['k/a1'])
    await answer(running('a1'))
    expect(view()).toMatchObject({ first: true, error: '', data: { helper: { id: 'a1', status: 'running' } } })
    await world.tick(1499)
    expect(asked.length).toBe(1)
    await world.tick(1)
    expect(asked.length).toBe(2)
    await answer(running('a1'))
    // A read again is not the first: the conversation keeps the reader's place.
    expect(view().first).toBe(false)
    await world.tick(1500)
    expect(asked.length).toBe(3)
    await answer(finished('a1'))
    expect(view().data?.helper.status).toBe('done')
    await world.tick(60_000)
    expect(asked.length).toBe(3)
  })

  test('one that could not be read is asked again in four seconds; one the server says is not there, never', async () => {
    const { engine, asked, answer, view } = setup()
    engine.open('k', { id: 'a1' })
    await answer(failed('offline'))
    expect(view()).toMatchObject({ data: null, error: 'offline' })
    await world.tick(3999)
    expect(asked.length).toBe(1)
    await world.tick(1)
    expect(asked.length).toBe(2)
    await answer(failed('This session has no such helper', true))
    expect(view().error).toBe('This session has no such helper')
    await world.tick(60_000)
    expect(asked.length).toBe(2)
  })

  test('the error shows only until the first answer; a later failure keeps what was read', async () => {
    const { engine, asked, answer, view } = setup()
    engine.open('k', { id: 'a1' })
    await answer(failed('offline'))
    await world.tick(4000)
    await answer(running('a1'))
    expect(view()).toMatchObject({ error: '', data: { helper: { id: 'a1' } } })
    await world.tick(1500)
    await answer(failed('offline again'))
    expect(view()).toMatchObject({ error: '', data: { helper: { id: 'a1' } } })
    await world.tick(4000)
    expect(asked.length).toBe(4)
  })

  test('a hidden page reads nothing until it is back', async () => {
    const { engine, asked, answer, page } = setup()
    engine.open('k', { id: 'a1' })
    await answer(running('a1'))
    page.hidden = true
    await world.tick(1500)
    await world.tick(1500)
    expect(asked.length).toBe(1)
    page.hidden = false
    await world.tick(1500)
    expect(asked.length).toBe(2)
  })

  test('nothing is read once it shrinks away, and an answer that comes after is dropped', async () => {
    const { engine, asked, answer, view } = setup()
    engine.open('k', { id: 'a1' })
    await answer(running('a1'))
    engine.close()
    await world.tick(1500)
    expect(asked.length).toBe(1)
    await world.settle()
    expect(view()).toMatchObject({ hidden: true, key: null, stack: [], data: null })
    engine.open('k', { id: 'a2' })
    engine.close()
    await world.settle()
    await answer(running('a2'))
    expect(view()).toMatchObject({ hidden: true, data: null })
  })
})

describe('what is on show', () => {
  test('an answer for a helper no longer on show is dropped, after a step in or a step back', async () => {
    const { engine, asked, answer, view, stack } = setup()
    engine.feed({ key: 'k', data: detail([helper('a1'), helper('a2')]) })
    engine.open('k', { id: 'a1' })
    engine.pushHelper('a2')
    expect(stack()).toEqual(['a1', 'a2'])
    await answer(running('a1'))
    expect(view().data).toBeNull()
    await answer(running('a2'))
    expect(view().data?.helper.id).toBe('a2')
    // Its polling stopped with it: only the one on show is read again.
    await world.tick(1500)
    expect(asked).toEqual(['k/a1', 'k/a2', 'k/a2'])
    // Back while that read waits: the older one is on show, the newer one's late answer is dropped.
    engine.back()
    expect(stack()).toEqual(['a1'])
    await answer(running('a2'))
    expect(view().data).toBeNull()
    await answer(running('a1'))
    expect(view()).toMatchObject({ first: true, data: { helper: { id: 'a1' } } })
  })

  test("only the sheet's own helpers open over what is on show", () => {
    const { engine, asked, stack } = setup()
    engine.feed({ key: 'k', data: detail([helper('a1')]) })
    engine.open('k', { list: true, run: null })
    engine.pushHelper('zz')
    expect(stack()).toEqual(['list:'])
    engine.pushHelper('a1')
    expect(stack()).toEqual(['list:', 'a1'])
    expect(asked).toEqual(['k/a1'])
    // The sheet shows another session now: its helpers are not these.
    engine.feed({ key: 'other', data: detail([helper('a1'), helper('b1')]) })
    engine.pushHelper('b1')
    expect(stack()).toEqual(['list:', 'a1'])
  })

  test('opened again for its session it steps in; for another it starts afresh; an unknown one opens nothing', () => {
    const { engine, view, stack } = setup()
    engine.open('nope', { id: 'a1' })
    expect(view().hidden).toBe(true)
    engine.open('k', { list: true, run: 'wf_1' })
    expect(view()).toMatchObject({ hidden: false, key: 'k', stack: [{ list: true, run: 'wf_1' }] })
    engine.open('k', { id: 'a1' })
    expect(stack()).toEqual(['list:wf_1', 'a1'])
    engine.pushRun('wf_2')
    expect(stack()).toEqual(['list:wf_1', 'a1', 'list:wf_2'])
    engine.open('other', { id: 'b1' })
    expect(view().key).toBe('other')
    expect(stack()).toEqual(['b1'])
  })

  test('Back steps down; from the first step it closes', async () => {
    const { engine, focus, view, stack } = setup()
    engine.feed({ key: 'k', data: detail([helper('a1')]) })
    engine.open('k', { list: true, run: null })
    engine.pushHelper('a1')
    engine.back()
    expect(stack()).toEqual(['list:'])
    expect(engine.isOpen()).toBe(true)
    engine.back()
    expect(engine.isOpen()).toBe(false)
    expect(view().closing).toBe(true)
    await world.settle()
    expect(view().hidden).toBe(true)
    expect(focus.closed).toBe(1)
  })

  test('another session: the window closes, that session opens; an unknown one does nothing', async () => {
    const { engine, opened } = setup()
    engine.open('k', { list: true, run: null })
    engine.session('nope')
    expect(engine.isOpen()).toBe(true)
    expect(opened).toEqual([])
    engine.session('other')
    expect(engine.isOpen()).toBe(false)
    expect(opened).toEqual(['other'])
  })
})

describe('keys', () => {
  test('Esc closes; Backspace and Alt+← step back, Backspace not while typing', () => {
    const { engine, stack } = setup()
    engine.feed({ key: 'k', data: detail([helper('a1'), helper('a2')]) })
    engine.open('k', { list: true, run: null })
    engine.pushHelper('a1')
    engine.pushHelper('a2')
    const back = press('Backspace')
    engine.keydown(back)
    expect(back.prevented).toBe(true)
    expect(stack()).toEqual(['list:', 'a1'])
    const field = mount('<input>')
    field.focus()
    const typed = press('Backspace')
    engine.keydown(typed)
    expect(typed.prevented).toBe(false)
    expect(stack()).toEqual(['list:', 'a1'])
    engine.keydown(press('ArrowLeft', true))
    expect(stack()).toEqual(['list:'])
    const esc = press('Escape')
    engine.keydown(esc)
    expect(esc.prevented).toBe(true)
    expect(engine.isOpen()).toBe(false)
  })

  test('with a dialog above it, or once it closed, its keys are not its own', async () => {
    const { engine, focus, stack } = setup()
    engine.open('k', { list: true, run: null })
    focus.top = false
    const esc = press('Escape')
    engine.keydown(esc)
    expect(esc.prevented).toBe(false)
    expect(engine.isOpen()).toBe(true)
    focus.top = true
    engine.close()
    await world.settle()
    const late = press('Backspace')
    engine.keydown(late)
    expect(late.prevented).toBe(false)
    expect(stack()).toEqual([])
  })
})

describe('motion and focus', () => {
  test('it grows once out of the row, taking the focus; it shrinks back into it', async () => {
    const { engine, refs, focus } = setup()
    const sheet = mount('<div id="sheet"><button data-helper="a1"></button></div>')
    const row = query(sheet, '[data-helper="a1"]')
    engine.open('k', { id: 'a1' }, row)
    engine.grow()
    expect(focus.opened).toEqual([row])
    await world.settle()
    expect(refs.win.current?.style.transform).toBe('translate(0px, 0px) scale(1)')
    expect(refs.scrim.current?.style.opacity).toBe('1')
    engine.grow()
    expect(focus.opened.length).toBe(1)
    engine.close()
    await world.settle()
    expect(refs.win.current?.style.opacity).toBe('0')
    expect(focus.closed).toBe(1)
  })

  test('closed, it gives the focus back to the row it came from, drawn anew meanwhile under #sheet', async () => {
    const { engine } = setup()
    const sheet = mount('<div id="sheet"><button data-helper="a1"></button><button data-helpers-all=""></button></div>')
    for (const [selector, ref] of [
      ['[data-helper="a1"]', { id: 'a1' }],
      ['[data-helpers-all]', { list: true as const, run: null }],
    ] as const) {
      engine.open('k', ref, query(sheet, selector))
      engine.grow()
      await world.settle()
      // The strip drew its rows anew: the one it came from left the page.
      sheet.innerHTML = '<button data-helper="a1"></button><button data-helpers-all=""></button>'
      document.body.focus()
      engine.close()
      await world.settle()
      expect(document.activeElement).toBe(query(sheet, selector))
    }
  })
})
