// Auto-compact on the sheet's card (#378, SheetCard's CompactRows): a Claude session's own limit,
// what its summary keeps and the board's last /compact; nothing for a pi session, nor for a Claude
// one with nothing set while the card's details are folded.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CompactView } from '../../src/core/compact.ts'
import { SheetCard } from '../../web/src/components/sheet/SheetCard.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board, item, payload } from './support/board.tsx'

const AT = new Date(2026, 10, 12, 14, 5).getTime()
const view = (fields: Partial<CompactView> = {}): CompactView => ({
  own: '300k',
  note: 'keep the ticket list',
  limit: '300k',
  source: 'session',
  tokens: 300_000,
  run: null,
  ...fields,
})
const card = (it: ReturnType<typeof item>, open: boolean, compactDefault = '', lang = 'en') =>
  renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <BoardContext.Provider value={board({ data: payload({ items: [it], compactDefault }), now: AT })}>
        <SheetCard item={it} open={open} disabled={false} />
      </BoardContext.Provider>
    </I18nProvider>,
  )

test("a Claude session's own limit and instructions, and the board's last /compact, held in its own color", () => {
  const held = view({
    run: {
      state: 'done',
      at: AT - 60_000,
      from: 612_000,
      limit: 300_000,
      setting: '300k',
      to: 320_000,
      doneAt: AT,
      measured: true,
      hold: true,
    },
  })
  const html = card(item({ key: 'a', agent: 'claude', compact: held }), false)
  expect(html).toContain('Compact at')
  expect(html).toContain('id="compactAt"')
  expect(html).toContain('>300k</textarea>')
  expect(html).toContain('>keep the ticket list</textarea>')
  expect(html).toMatch(
    /class="row-value compact-run held" title="No other \/compact until the context is below 300k or the limit changes">[^<]*612k → 320k, still above 300k: paused</,
  )
  // In Russian too.
  expect(card(item({ key: 'a', agent: 'claude', compact: held }), false, '', 'ru')).toContain('Сжать на')
})

test("nothing set: folded, no row; open, the empty field says Settings' default or off", () => {
  const plain = item({ key: 'b', agent: 'claude' })
  expect(card(plain, false)).not.toContain('Compact at')
  expect(card(plain, true)).toContain('placeholder="Off: 300k, 60% or never"')
  expect(card(plain, true, '400k')).toContain('placeholder="Default: 400k (300k, 60% or never)"')
  // Instructions are offered once a limit applies.
  expect(card(plain, true)).not.toContain('id="compactNote"')
  const byDefault = item({
    key: 'b',
    agent: 'claude',
    compact: view({ own: '', note: '', source: 'default', limit: '400k' }),
  })
  expect(card(byDefault, true, '400k')).toContain('id="compactNote"')
})

test('a share of the window whose size the board does not know yet says so', () => {
  const share = item({ key: 'e', agent: 'claude', compact: view({ own: '60%', note: '', limit: '60%', tokens: null }) })
  expect(card(share, false)).toContain(
    'Waits for the window size: the status line has not said it for this session yet',
  )
})

test('a pi session, a MokuPilot day session: no auto-compact on their card', () => {
  expect(card(item({ key: 'c', agent: 'pi' }), true)).not.toContain('Compact at')
  expect(card(item({ key: 'd', agent: 'claude', day: true }), true)).not.toContain('Compact at')
})
