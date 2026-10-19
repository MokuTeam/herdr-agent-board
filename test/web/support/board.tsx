// Fixed boards for the web board's tests, and rendering a component inside the page's providers.
import type { ReactNode } from 'react'
import { LANGUAGES } from '../../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { Item } from '../../../src/core/types.ts'
import { I18nProvider } from '../../../web/src/i18n/I18nProvider.tsx'
import { type Board, BoardContext } from '../../../web/src/state/BoardProvider.tsx'
import { type BoardUi, initialUi } from '../../../web/src/state/board-ui.ts'
import { reactMarkup } from './markup.ts'

export function item(fields: Partial<Item> & Pick<Item, 'key'>): Item {
  return {
    session: fields.key,
    pane: `pane-${fields.key}`,
    workspace: 'ws',
    cwd: '/work',
    status: 'idle',
    name: fields.key,
    autoName: fields.key,
    category: 'other',
    categorySet: true,
    column: 'idle',
    attention: '',
    sleeping: false, // the server always says (services/board.ts)
    ...fields,
  }
}

export function payload(fields: Partial<BoardPayload> = {}): BoardPayload {
  return {
    version: 'v1',
    lang: 'en',
    language: 'auto',
    languages: LANGUAGES,
    fsToken: 'token',
    stale: false,
    lastSuccessfulRefreshAt: Date.now() - 1000,
    limits: null,
    items: [],
    launches: [],
    categories: [],
    swatches: [],
    columns: (['work', 'me', 'ext', 'done', 'idle'] as const).map(id => ({ id, title: id })),
    schedules: [],
    scheduleLog: [],
    ...fields,
  }
}

/** The board context as the provider gives it; connected and fresh unless told otherwise. */
export function board(fields: Partial<Omit<Board, 'ui'>> & { ui?: Partial<BoardUi> } = {}): Board {
  const { ui, ...rest } = fields
  const data = rest.data === undefined ? payload() : rest.data
  const connected = rest.connected ?? data !== null
  const fresh = connected && data?.stale === false && data.lastSuccessfulRefreshAt != null
  return {
    data,
    connected,
    dropped: false,
    canMutate: fresh,
    canEdit: connected,
    resume() {},
    reveal: null,
    dispatch() {},
    toast() {},
    now: Date.now(),
    ...rest,
    ui: { ...initialUi((_key, fallback) => fallback), ...ui },
  }
}

/** A component rendered inside the language and board providers, parsed (support/markup.ts). */
export function renderInBoard(node: ReactNode, value: Board, lang = 'en') {
  return reactMarkup(
    <I18nProvider lang={lang}>
      <BoardContext.Provider value={value}>{node}</BoardContext.Provider>
    </I18nProvider>,
  )
}
