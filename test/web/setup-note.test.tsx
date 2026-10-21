// The setup note and its list against upstream's (web/setup.js at its merge, run on a fake DOM):
// the same summary and the same answer from /api/setup give the same markup; where the list
// hangs from the note; and the model's rules on their own.
import { afterEach, describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import { type InstallPaths, planSettings } from '../../src/core/install-plan.ts'
import { boardFiles, checkSetup, type SetupCheck, type SetupFacts, setupSummary } from '../../src/core/setup.ts'
import { SetupNote } from '../../web/src/components/SetupNote.tsx'
import { SetupPop } from '../../web/src/components/SetupPop.tsx'
import type { SetupNoteState } from '../../web/src/hooks/useSetupNote.ts'
import { isSetupReply, noteShown, setupList, setupPopPlace } from '../../web/src/models/setup.ts'
import { board, renderInBoard } from './support/board.tsx'
import { box } from './support/fake-dom.ts'
import { newMarkup, OldSetup, oldMarkup, type SetupServer } from './support/old-setup.ts'

const ROOT = 'C:\\plugins\\agent-board'
const files = boardFiles(ROOT)
const paths: InstallPaths & { wakeHook: string } = { bun: 'C:\\bun.exe', ...files, binDir: 'C:\\Users\\u\\.local\\bin' }

/** A computer half set up: no hooks, no key, no herdr-wake, notifications off; the commands in place. */
function facts(): SetupFacts {
  const ours = (name: string, target: string) => ({ file: `C:\\Users\\u\\.local\\bin\\${name}`, target })
  return {
    platform: 'win32',
    root: ROOT,
    node: '22.5.0',
    binDir: 'C:\\Users\\u\\.local\\bin',
    path: 'C:\\Users\\u\\.local\\bin',
    files,
    commands: {
      board: { ps: ours('board.cmd', files.cli), sh: ours('board', files.cli) },
      'spawn-agent': { ps: ours('spawn-agent.cmd', files.spawn), sh: ours('spawn-agent', files.spawn) },
    },
    settingsFile: 'C:\\Users\\u\\.claude\\settings.json',
    settings: {},
    settingsError: '',
    herdrConfigFile: 'C:\\Users\\u\\AppData\\Roaming\\herdr\\config.toml',
    herdrConfig: null,
    wakeUrl: null,
    wake: null,
    launcher: { kind: 'builtin', claude: ['claude'], error: '', program: { file: 'C:\\bin\\claude.exe', found: true } },
  }
}

function reply(lang: string, over: Partial<SetupFacts> = {}) {
  const f = { ...facts(), ...over }
  return { checks: checkSetup(f, translator(lang)), ...setupSummary(checkSetup(f)) }
}

/** The page's state for the views, as useSetupNote keeps it. */
function state(fields: Partial<SetupNoteState>): SetupNoteState {
  return {
    open: false,
    opened: false,
    shown: false,
    hidden: true,
    checks: null,
    loadFailed: false,
    loading: false,
    busy: false,
    summary: null,
    copied: new Set(),
    noteRef: createRef(),
    popRef: createRef(),
    toggle() {},
    close() {},
    recheck() {},
    hide() {},
    copy() {},
    ...fields,
  }
}

const reactNote = (s: SetupNoteState, lang = 'en') => newMarkup(renderInBoard(<SetupNote setup={s} />, board(), lang))
const reactPop = (s: SetupNoteState, lang = 'en') => newMarkup(renderInBoard(<SetupPop setup={s} />, board(), lang))

let running: OldSetup | null = null
async function oldSide(lang: string, server: SetupServer, rects?: ConstructorParameters<typeof OldSetup>[2]) {
  running = new OldSetup(translator(lang), server, rects)
  await running.start()
  return running
}
afterEach(() => {
  running?.stop()
  running = null
})

describe('setup note markup parity', () => {
  test('something needs a look: the note in the toolbar, the list not drawn yet', async () => {
    const old = await oldSide('en', 'pending')
    old.render({ todo: 2, sig: 'hooks:error:x|key:warn:y' })
    const s = state({ shown: true, summary: { todo: 2, sig: 'hooks:error:x|key:warn:y' } })
    expect(reactNote(s)).toBe(oldMarkup(old.note))
    expect(reactPop(s)).toBe(oldMarkup(old.pop))
  })

  test('nothing to look at, or hidden until something changes: no note', async () => {
    const old = await oldSide('en', 'pending')
    old.render({ todo: 0, sig: '' })
    expect(reactNote(state({}))).toBe(oldMarkup(old.note))
    old.storage.set('board.setupHidden', 'a|b')
    old.render({ todo: 2, sig: 'a|b' })
    expect(reactNote(state({ summary: { todo: 2, sig: 'a|b' } }))).toBe(oldMarkup(old.note))
    expect(noteShown(false, { todo: 2, sig: 'a|b' }, 'a|b')).toBe(false)
  })

  for (const lang of ['en', 'ru']) {
    test(`open, in ${lang}: problems first, the install once on top, a command of its own, the rest quiet`, async () => {
      const r = reply(lang)
      const old = await oldSide(lang, { reply: r })
      old.render({ todo: r.todo, sig: r.sig })
      await old.click()
      const s = state({
        open: true,
        opened: true,
        shown: true,
        hidden: false,
        checks: r.checks,
        summary: { todo: r.todo, sig: r.sig },
      })
      expect(reactNote(s, lang)).toBe(oldMarkup(old.note))
      expect(reactPop(s, lang)).toBe(oldMarkup(old.pop))
    })
  }

  test('opening: “Checking…” until the server answers, “Check again” waiting', async () => {
    const old = await oldSide('en', 'pending')
    old.render({ todo: 1, sig: 'x' })
    await old.click()
    const s = state({
      open: true,
      opened: true,
      shown: true,
      hidden: false,
      loading: true,
      busy: true,
      summary: { todo: 1, sig: 'x' },
    })
    expect(reactPop(s)).toBe(oldMarkup(old.pop))
  })

  test('the server did not answer: it says so', async () => {
    const old = await oldSide('ru', 'fails')
    old.render({ todo: 1, sig: 'x' })
    await old.click()
    const s = state({
      open: true,
      opened: true,
      shown: true,
      hidden: false,
      loadFailed: true,
      summary: { todo: 1, sig: 'x' },
    })
    expect(reactPop(s, 'ru')).toBe(oldMarkup(old.pop))
  })

  test('a command copied: its button says so', async () => {
    const r = reply('en')
    const old = await oldSide('en', { reply: r })
    old.render({ todo: r.todo, sig: r.sig })
    await old.click()
    await old.click(old.find('[data-copy="1"]'))
    const s = state({
      open: true,
      opened: true,
      shown: true,
      hidden: false,
      checks: r.checks,
      summary: { todo: r.todo, sig: r.sig },
      copied: new Set([1]),
    })
    expect(reactPop(s)).toBe(oldMarkup(old.pop))
  })

  test('all set: no hide button, the list says so', async () => {
    const settings = planSettings({}, paths, { toast: true }).settings
    const toml = '[[keys.command]]\nkey = "prefix+a"\ntype = "plugin_action"\ncommand = "agent-board.open"\n'
    const r = reply('en', { settings, herdrConfig: toml })
    expect(r.todo).toBe(0)
    const old = await oldSide('en', { reply: r })
    old.render({ todo: 1, sig: 'before' })
    await old.click()
    const s = state({
      open: true,
      opened: true,
      shown: true,
      hidden: false,
      checks: r.checks,
      summary: { todo: 0, sig: '' },
    })
    expect(reactPop(s)).toBe(oldMarkup(old.pop))
    expect(reactNote(s)).toBe(oldMarkup(old.note))
  })
})

describe('where the list hangs from the note', () => {
  for (const [label, note, pop] of [
    ['under the note, its right edge on the note’s', box(900, 10, 120, 28), box(0, 0, 460, 300)],
    ['above it when there is no room below', box(900, 700, 120, 28), box(0, 0, 460, 300)],
    ['kept inside a narrow window', box(20, 10, 120, 28), box(0, 0, 460, 300)],
  ] as const) {
    test(label, async () => {
      const r = reply('en')
      const old = await oldSide('en', { reply: r }, el =>
        el.id === 'setup-note' ? note : el.id === 'setup-pop' ? pop : null,
      )
      old.render({ todo: r.todo, sig: r.sig })
      await old.click()
      const at = setupPopPlace(note, pop, { width: 1200, height: 800 })
      const style = old.popStyle()
      expect([style.left, style.top, style['transform-origin']]).toEqual([`${at.left}px`, `${at.top}px`, at.origin])
    })
  }
})

describe('the setup model', () => {
  const check = (id: string, level: SetupCheck['level'], code = '', fix = ''): SetupCheck => ({
    id,
    level,
    title: id,
    detail: '',
    fix,
    code,
  })

  test('the note shows while open, or while something not hidden needs a look', () => {
    expect(noteShown(true, null, '')).toBe(true)
    expect(noteShown(false, null, '')).toBe(false)
    expect(noteShown(false, { todo: 0, sig: '' }, '')).toBe(false)
    expect(noteShown(false, { todo: 1, sig: 'a' }, 'b')).toBe(true)
    expect(noteShown(false, { todo: 1, sig: 'a' }, 'a')).toBe(false)
  })

  test('a command several checks share is lifted once to the top, with the first fix that goes with it', () => {
    const list = setupList([
      check('ok', 'ok', 'X', 'run X'),
      check('w', 'warn', 'X', 'run X'),
      check('e', 'error', 'X', 'run X'),
      check('k', 'warn', 'K', 'add K'),
    ])
    expect(list.common).toEqual({ fix: 'run X', code: 'X' })
    expect(list.rows.map(r => [r.check.id, r.fix, r.code])).toEqual([
      ['e', false, false],
      ['w', false, false],
      ['k', true, true],
      ['ok', false, false],
    ])
    // One use is no common command.
    expect(setupList([check('k', 'warn', 'K', 'add K')]).common).toBe(null)
  })

  test('the server’s answer is checked before the page uses it', () => {
    const r = reply('en')
    expect(isSetupReply(r)).toBe(true)
    expect(isSetupReply({ ...r, checks: [{ ...r.checks[0], level: 'bad' }] })).toBe(false)
    expect(isSetupReply({ checks: [], todo: '1', sig: '' })).toBe(false)
    expect(isSetupReply(null)).toBe(false)
  })
})
