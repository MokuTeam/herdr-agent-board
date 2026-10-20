// The foot of the session's thread, markup parity with upstream's merge of the queue (#53): the
// thread the React sheet draws (<SheetView>'s .thread) against the one upstream's own
// renderSheetBody, waitingHTML and settleOutbox of web/app.js draw at that merge, with its own
// web/outbox.js, for the same detail and the same messages of the board's own. Those come from
// the React composer's model (models/composer-session.ts): refused, sent, on their way; each side
// settles them against the detail by its own code.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { QueuedPrompt } from '../../src/core/queue.ts'
import type { ConversationTurn } from '../../src/core/transcript.ts'
import type { Item } from '../../src/core/types.ts'
import type { SessionDetail } from '../../web/src/api/client.ts'
import { SheetView } from '../../web/src/components/sheet/Sheet.tsx'
import type { Attachment } from '../../web/src/models/composer.ts'
import { type ComposerSession, composerSession, type SendResult } from '../../web/src/models/composer-session.ts'
import type { DetailValue } from '../../web/src/models/detail-resource.ts'
import { draftBook } from '../../web/src/models/drafts.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { byClass, canonical, type Element, findAll, hasClass, type Node, parseHtml } from './support/markup.ts'
import { OLD_MARKDOWN, oldCode, oldFunction, oldModule } from './support/old-app.ts'
import { composerOf } from './support/sheet-scene.tsx'

/** The newest web merge ported (b2c5afa; the queue is #53's): this file's own pin. */
const QUEUE_MERGE = 'b2c5afa'
const OLD_OUTBOX = await oldModule('web/outbox.js', QUEUE_MERGE)

const MIN = 60_000
const NOW = Date.now()
const UPLOADS = 'C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-19'

const working = item({ key: 'a', session: 'sa', name: 'Alpha', column: 'work', status: 'working' })

const CONVERSATION: ConversationTurn[] = [
  { role: 'user', text: 'Fix the **login**', at: NOW - 30 * MIN },
  { role: 'tool', label: 'Read', detail: 'src/app.ts', path: 'src/app.ts', done: true, at: NOW - 29 * MIN },
  { role: 'assistant', text: 'On it.', at: NOW - 28 * MIN },
  { role: 'tool', label: 'Bash', detail: 'bun test', path: '', done: false, at: NOW - MIN },
]

const QUEUED: QueuedPrompt[] = [
  { text: 'also check the `logs`', at: NOW - 3 * MIN },
  { text: `and this one:\n${UPLOADS}\\shot.png`, at: NOW - 2 * MIN },
]

const shot: Attachment = {
  id: 1,
  name: 'shot.png',
  size: 10,
  image: true,
  url: 'blob:shot',
  status: 'done',
  path: `${UPLOADS}\\out.png`,
}

/**
 * The composer's model after five messages to `it`: one refused with why, one refused without
 * (files only), two sent, and one still on its way.
 */
async function outboxOf(it: Item, lang: string): Promise<ComposerSession> {
  const t = translator(lang)
  const state = { text: '', files: [] as readonly Attachment[] }
  let answer: (r: SendResult) => void = () => {}
  const storage = new Map<string, string>()
  const box = composerSession({
    drafts: draftBook({
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: k => void storage.delete(k),
    }),
    page: () => ({ open: it.key, ...state, canMutate: true, detail: null, item: () => it, t }),
    setText: text => {
      state.text = text
    },
    clearFiles: () => {
      state.files = []
    },
    releaseFiles: () => {
      state.files = []
    },
    restoreFiles() {},
    revoke() {},
    sending() {},
    changed() {},
    foot() {},
    toast() {},
    busy() {},
    post: () =>
      new Promise(resolve => {
        answer = resolve
      }),
    reload() {},
    focus() {},
    later() {},
    now: () => Date.now(),
  })
  box.opened(it.key, false)
  const send = async (text: string, files: readonly Attachment[], r: SendResult | null) => {
    box.input(text)
    state.files = files
    const sent = box.send()
    if (r) {
      answer(r)
      await sent
    }
  }
  await send('Please **rebase** first', [], { ok: false, error: 'herdr is <out> of date' })
  await send('', [shot], { ok: false, error: '' })
  await send('run the e2e suite', [], { ok: true })
  await send('settled one', [], { ok: true })
  await send('and then *deploy*', [], null)
  return box
}

interface Scene {
  lang?: string
  /** The session's detail as the sheet has it (null: not read yet). */
  conversation: ConversationTurn[] | null
  status?: DetailValue<SessionDetail>['status']
  queued?: QueuedPrompt[]
  /** The composer's model holding the board's own messages. */
  box?: ComposerSession
  /** The sheet closed while it slides out: it still shows the session, its outbox unsettled. */
  closed?: boolean
}

function detailOf(scene: Scene): DetailValue<SessionDetail> {
  const data: SessionDetail | null = scene.conversation
    ? {
        item: working,
        conversation: scene.conversation,
        queued: scene.queued ?? [],
        screen: '',
        dialog: null,
        checkout: false,
      }
    : null
  return { key: 'a', data, status: scene.status ?? (data ? 'ready' : 'loading'), error: '', at: NOW }
}

const openOf = (scene: Scene) => (scene.closed ? null : 'a')

/** upstream's renderSheetBody at QUEUE_MERGE, its thread part: the `.thread` it drew. */
function oldThread(scene: Scene): Element {
  const t = translator(scene.lang ?? 'en')
  const detail = detailOf(scene)
  // Its outbox holds what the model does, unsettled (outbox.js settles it in the draw).
  const own = scene.box?.waiting('a', null, null) ?? []
  let drawn = ''
  const code = oldCode(
    'web/app.js',
    [
      'ICON',
      'esc',
      'UPLOAD_IMAGE',
      'thumbs',
      'clock',
      'thread',
      'renderSheetBody',
      'waitingHTML',
      'settleOutbox',
      'forgetOut',
    ],
    {
      t,
      markdown: OLD_MARKDOWN.get('markdown'),
      unsettled: OLD_OUTBOX.get('unsettled'),
      outbox: new Map(own.length ? [['a', own.map(e => ({ ...e }))]] : []),
      attachments: [],
      state: { open: openOf(scene), selectedItem: working, detail: detail.data, detailState: detail },
      itemOf: (key: string | null) => (key === 'a' ? working : undefined),
      questionsUI: {
        mount: () => null,
        threadHTML() {
          throw new Error('no question forms in these turns')
        },
      },
      dismissable: () => false,
      renderSheetCard() {},
      renderHelpersStrip() {},
      sheetBody: { scrollHeight: 0, scrollTop: 0, clientHeight: 0 },
      sheetQuestion: { _html: '', innerHTML: '', hidden: true },
      redraw: (_el: unknown, html: string) => {
        drawn = html
      },
      arrive() {},
      files: { upgrade() {} },
      syncAvailability() {},
    },
    QUEUE_MERGE,
  )
  oldFunction(code, 'renderSheetBody')(true)
  return byClass(parseHtml(drawn), 'thread')
}

/** The React sheet's `.thread` for the same scene, the outbox as useComposer hands it over. */
function reactThread(scene: Scene): Element {
  const open = openOf(scene)
  const detail = detailOf(scene)
  const { box } = scene
  const composer = {
    ...composerOf({ open }),
    outbox: {
      waiting: (key: string | null) => box?.waiting(key, open, detail.data) ?? [],
      retry() {},
      edit() {},
      version: 0,
      foot: 0,
    },
  }
  const nodes = renderInBoard(
    <SheetView open={open} item={working} detail={detail} composer={composer} />,
    board({ data: payload({ items: [working] }), ui: { open } }),
    scene.lang ?? 'en',
  )
  return byClass(nodes, 'thread')
}

function same(scene: Scene): Node[] {
  const old = [oldThread(scene)]
  const react = [reactThread(scene)]
  expect(canonical(react)).toBe(canonical(old))
  expect(canonical(react, { spaces: true })).toBe(canonical(old, { spaces: true }))
  return react
}

const own = (nodes: Node[]) => findAll(nodes, el => el.attrs.has('data-out'))

describe('the foot of the thread, markup parity with upstream', () => {
  for (const lang of ['en', 'ru'])
    test(`the queue, then the board's own: refused with Retry and Edit, sent, on its way (${lang})`, async () => {
      const box = await outboxOf(working, lang)
      const react = same({ lang, conversation: CONVERSATION, queued: QUEUED, box })
      expect(findAll(react, el => hasClass(el, 'waiting')).length).toBe(2 + 5)
      expect(findAll(react, el => hasClass(el, 'failed')).length).toBe(2)
      expect(findAll(react, el => el.attrs.has('data-out-retry')).length).toBe(2)
      // The images they name from the uploads preview: the queued one's, the refused one's file.
      expect(findAll(react, el => el.tag === 'img').length).toBe(2)
    })

  test('what the transcript or the queue shows after the send settles on both sides; a closing sheet settles nothing', async () => {
    const box = await outboxOf(working, 'en')
    const after = Math.max(...box.waiting('a', null, null).map(e => e.after)) + 1
    const scene: Scene = {
      conversation: [...CONVERSATION, { role: 'user', text: 'settled one', at: after }],
      queued: [...QUEUED, { text: 'run the e2e suite', at: after }],
      box,
    }
    expect(own(same(scene)).length).toBe(3)
    // An older message with the same words is not this one.
    const older: Scene = { ...scene, conversation: [...CONVERSATION, { role: 'user', text: 'settled one', at: 1 }] }
    expect(own(same({ ...older, queued: QUEUED })).length).toBe(5)
    // Closed, sliding out: nothing settles.
    expect(own(same({ ...scene, closed: true })).length).toBe(5)
  })

  test('no conversation yet, or none at all: the waiting bubbles alone, else the placeholder', async () => {
    const box = await outboxOf(working, 'en')
    same({ conversation: null, box })
    same({ conversation: null })
    same({ conversation: null, status: 'error' })
    same({ conversation: [], queued: QUEUED, box })
    same({ conversation: [], queued: QUEUED })
    same({ conversation: [] })
    same({ conversation: [], box })
  })
})
