// The toasts against the old page's (at the parity baseline): the #toasts block of web/index.html
// with the elements toast() appended (their opacity and offset are set by the spring once they are
// on the page, on both pages).
import { expect, test } from 'bun:test'
import { Toasts } from '../../web/src/components/Toasts.tsx'
import { boardUi, initialUi } from '../../web/src/state/board-ui.ts'
import { board, renderInBoard } from './support/board.tsx'
import { append, byId, canonical, pageMarkup } from './support/markup.ts'

test('toasts markup parity: an empty stack, then a note and an error in the order they came', () => {
  const page = [byId(pageMarkup(), 'toasts')]
  expect(canonical(renderInBoard(<Toasts />, board()))).toBe(canonical(page))

  let ui = initialUi((_key, fallback) => fallback)
  ui = boardUi(ui, { type: 'toast', text: 'Sent to Alpha', error: false })
  ui = boardUi(ui, { type: 'toast', text: 'No connection to the board: <offline> & "down"', error: true })
  const stack = byId(page, 'toasts')
  append(stack, '<div class="toast">Sent to Alpha</div>')
  append(stack, '<div class="toast error">No connection to the board: &lt;offline&gt; &amp; "down"</div>')
  expect(canonical(renderInBoard(<Toasts />, board({ ui })))).toBe(canonical(page))
})
