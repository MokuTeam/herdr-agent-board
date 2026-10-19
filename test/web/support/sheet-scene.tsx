// One session-sheet scene drawn both ways: by the old page's own code (support/old-sheet.ts) and by
// the React sheet's parts — <SheetHead> in the head's title, <SheetView> under the head — inside
// the page's providers, with the hooks' state handed in as it would be at that moment.
import { createRef, type ReactNode } from 'react'
import type { BoardCategory, BoardPayload } from '../../../src/core/payload.ts'
import type { ScheduleEntry } from '../../../src/core/schedule-rules.ts'
import type { ColumnId, Item } from '../../../src/core/types.ts'
import type { SessionDetail } from '../../../web/src/api/client.ts'
import { SheetView } from '../../../web/src/components/sheet/Sheet.tsx'
import { SheetHead } from '../../../web/src/components/sheet/SheetHead.tsx'
import { type ComposerControls, NO_OUTBOX } from '../../../web/src/hooks/useComposer.ts'
import { emptyDetail } from '../../../web/src/hooks/useSessionDetail.ts'
import { NO_MOVES, withMove } from '../../../web/src/models/board-view.ts'
import type { Attachment } from '../../../web/src/models/composer.ts'
import type { DetailValue } from '../../../web/src/models/detail-resource.ts'
import { sessionMissing } from '../../../web/src/models/sheet.ts'
import { board, payload, renderInBoard } from './board.tsx'
import { CATEGORIES } from './board-scene.tsx'
import { canonical, type Node } from './markup.ts'
import { oldSheet, sheetParts } from './old-sheet.ts'

export interface SheetScene {
  lang?: string
  items: Item[]
  categories?: BoardCategory[]
  schedules?: ScheduleEntry[]
  open: string | null
  /** The item the sheet showed last (a session gone from the board). */
  selected?: Item
  detail?: DetailValue<SessionDetail>
  connected?: boolean
  /** The board's data is out of date. */
  stale?: boolean
  moves?: { key: string; cat: string | null; column: ColumnId | null }[]
  armed?: string | null
  /** The form the session waits on, as both pages would draw it in #sheet-question (a stand-in)… */
  formHtml?: string
  /** …or the old page's own form (`formHtml`) beside the React one. */
  formNode?: ReactNode
  narrow?: boolean
  propertiesOpen?: boolean
  message?: string
  attachments?: Attachment[]
  sending?: string[]
  /** The payload's terminal fields: whether the board offers one, the sessions with a shell. */
  terminal?: boolean
  shells?: string[]
  /** The payload's `mokupilot`: MokuPilot is here for calls with a fork of a session. */
  mokupilot?: boolean
}

export function composerOf(scene: Pick<SheetScene, 'message' | 'attachments' | 'sending' | 'open'>): ComposerControls {
  return {
    text: scene.message ?? '',
    attachments: scene.attachments ?? [],
    sending: !!scene.open && (scene.sending ?? []).includes(scene.open),
    messageRef: createRef(),
    input() {},
    send() {},
    discard() {},
    addFiles() {},
    removeFile() {},
    outbox: NO_OUTBOX,
  }
}

function dataOf(scene: SheetScene): BoardPayload {
  return payload({
    lang: scene.lang === 'ru' ? 'ru' : 'en',
    items: scene.items,
    categories: scene.categories ?? CATEGORIES,
    schedules: scene.schedules ?? [],
    stale: !!scene.stale,
    ...(scene.terminal !== undefined && { terminal: scene.terminal }),
    ...(scene.shells && { shells: scene.shells }),
    ...(scene.mokupilot !== undefined && { mokupilot: scene.mokupilot }),
  })
}

/** The form slot's content, as React would get it from 25c. */
const formNode = (html: string | undefined): ReactNode =>
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the test's own fixed markup standing in for 25c's form
  html === undefined ? null : <div className="qa-stand-in" dangerouslySetInnerHTML={{ __html: html }} />

export interface SheetSides {
  title: string
  body: string
  /** The trees, for looking at one part with its inline spaces. */
  oldTitle: Node[]
  oldBody: Node[]
  reactTitle: Node[]
  reactBody: Node[]
}

export function drawSheet(scene: SheetScene): SheetSides {
  const lang = scene.lang ?? 'en'
  const data = dataOf(scene)
  const connected = scene.connected ?? true
  const moves = scene.moves ?? []
  const now = Date.now()
  const formHtml =
    scene.formHtml === undefined || scene.formNode !== undefined
      ? scene.formHtml
      : `<div class="qa-stand-in">${scene.formHtml}</div>`
  // Opening a session resets its detail (openSheet: detail.reset, state.detailState).
  const detail = scene.detail ?? emptyDetail(scene.open)
  const old = sheetParts(
    oldSheet({
      lang,
      data,
      open: scene.open,
      ...(scene.selected ? { selected: scene.selected } : {}),
      ...(scene.open ? { detail } : {}),
      connected,
      moved: new Map(moves.flatMap((m): [string, string][] => (m.cat ? [[m.key, m.cat]] : []))),
      movedCol: new Map(
        moves.flatMap((m): [string, { col: ColumnId; at: number }][] =>
          m.column ? [[m.key, { col: m.column, at: now }]] : [],
        ),
      ),
      armed: scene.armed ?? null,
      form: formHtml !== undefined,
      ...(formHtml !== undefined ? { formHtml } : {}),
      narrow: !!scene.narrow,
      propertiesOpen: !!scene.propertiesOpen,
      message: scene.message ?? '',
      attachments: scene.attachments ?? [],
      sending: scene.sending ?? [],
    }),
  )
  const pending = moves.reduce((all, m) => withMove(all, m.key, { ...m, at: now }), NO_MOVES)
  const value = board({ data, connected, now, ui: { open: scene.open, moves: pending } })
  const onBoard = scene.open ? data.items.find(i => i.key === scene.open) : undefined
  const shown = onBoard ?? scene.selected ?? null
  const missing = sessionMissing(detail.key, !!data.items.find(i => i.key === detail.key), detail.status)
  const reactTitle = renderInBoard(
    <div className="sheet-title">
      <SheetHead item={shown} missing={missing} />
    </div>,
    value,
    lang,
  )
  const reactBody = renderInBoard(
    <SheetView
      open={scene.open}
      item={shown}
      detail={detail}
      form={scene.formNode ?? formNode(scene.formHtml)}
      narrow={!!scene.narrow}
      propertiesOpen={!!scene.propertiesOpen}
      composer={composerOf(scene)}
      schedule={{ armed: scene.armed ?? null }}
    />,
    value,
    lang,
  )
  const oldTitle = [old.title]
  return {
    title: canonical(oldTitle),
    body: canonical(old.body),
    oldTitle,
    oldBody: old.body,
    reactTitle,
    reactBody: withoutPreloads(reactBody),
  }
}

/**
 * react-dom/server hoists a `<link rel="preload" as="image">` for an image it renders without
 * lazy loading (the attachment's preview); a page drawn in the browser gets none.
 */
export function withoutPreloads(nodes: Node[]): Node[] {
  return nodes.filter(n => !(n.kind === 'element' && n.tag === 'link' && n.attrs.get('rel') === 'preload'))
}

/** Both sides' canonical text of the title and the body. */
export function bothSheets(scene: SheetScene): { old: string; react: string } {
  const sides = drawSheet(scene)
  return {
    old: `${sides.title}\n${sides.body}`,
    react: `${canonical(sides.reactTitle)}\n${canonical(sides.reactBody)}`,
  }
}
