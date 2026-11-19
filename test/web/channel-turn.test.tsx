// The owner's messages through a channel (Telegram) in the conversation: a mark with the channel's
// name before the time, "voice · transcribed" for a voice message, a placeholder for a file without
// text; a message from the board or the terminal is drawn as before.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationTurn } from '../../src/core/transcript.ts'
import type { Item } from '../../src/core/types.ts'
import { Thread } from '../../web/src/components/sheet/Thread.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'

const ITEM: Pick<Item, 'column' | 'status'> = { column: 'me', status: 'idle' }
const AT = Date.parse('2026-11-19T07:58:01Z')

const draw = (conversation: ConversationTurn[], lang = 'en') =>
  renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <Thread conversation={conversation} item={ITEM} />
    </I18nProvider>,
  )

test('a Telegram message carries its mark; a voice one says it was transcribed', () => {
  const html = draw([
    { role: 'user', text: '🎤 Check the estimate.', at: AT, via: 'telegram', attached: 'voice', transcribed: true },
  ])
  expect(html).toContain('class="msg user via"')
  expect(html).toContain('data-via="telegram"')
  expect(html).toContain('title="Sent through Telegram"')
  expect(html).toContain('Telegram · voice · transcribed · ')
  expect(
    draw([{ role: 'user', text: 'hi', at: AT, via: 'telegram', attached: 'voice', transcribed: true }], 'ru'),
  ).toContain('Telegram · голосовое · расшифровано · ')
})

test('a photo without text says so instead of an empty bubble', () => {
  const html = draw([{ role: 'user', text: '', at: AT, via: 'telegram', attached: 'photo' }])
  expect(html).toContain('<div class="md attached">(photo attached)</div>')
  expect(html).not.toContain('voice')
})

test('a message typed on the board or in the terminal is drawn as before', () => {
  const html = draw([{ role: 'user', text: 'plain', at: AT }])
  expect(html).toContain('class="msg user"')
  expect(html).not.toContain('via')
})
