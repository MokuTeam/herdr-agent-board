import { expect, test } from 'bun:test'
import { item } from './support/board.tsx'
import { bothCards } from './support/board-scene.tsx'
import { canonical } from './support/markup.ts'
import { drawSheet } from './support/sheet-scene.tsx'

const local = 'http://127.0.0.1:39396/workdesk/#tasks'
const external = 'https://example.com/path_name?a=1&b=2#part_two'
const question = `Откройте локальный Workdesk на Mac (${local}), проверьте группы и причины блокировки. Если всё ок, скажите «ок деплоим». Затем «${external}»! ftp://example.com mailto:a@example.com javascript:alert(1) <em>текст</em>`
const asked = item({ key: 'a', column: 'me', attention: 'ask', question })

test('the Asks sheet links only HTTP(S) and preserves prose, punctuation and dismissal', () => {
  const { reactBody } = drawSheet({ lang: 'ru', items: [asked], open: asked.key })
  const html = canonical(reactBody)
  expect(html).toContain(`href="${local}"`)
  expect(html).toContain('href="https://example.com/path_name?a=1&amp;b=2#part_two"')
  expect(html).toMatch(/#tasks<\/a>\s*\), проверьте/)
  expect(html).not.toMatch(/href="(?:ftp:|mailto:|javascript:)/)
  expect(html).not.toContain('<em>текст</em>')
  expect(html).toContain('Не ждёт ответа')
})

test('the card preview retains the full URL and structured question options', () => {
  const { react } = bothCards({ items: [asked] }, asked.key)
  expect(react).toContain(`href="${local}"`)
  expect(react).toContain('path_name?a=1&amp;b=2#part_two')

  const form = item({
    key: 'b',
    column: 'me',
    attention: 'question',
    status: 'blocked',
    tool: {
      id: 'q',
      name: 'AskUserQuestion',
      pending: true,
      questions: [
        {
          header: 'Workdesk',
          question: `Откройте ${local}.`,
          multiSelect: false,
          preview: false,
          options: [
            { label: 'Открыто', description: '' },
            { label: 'Позже', description: '' },
          ],
        },
      ],
    },
  })
  const html = bothCards({ items: [form] }, form.key).react
  expect(html).toContain(`href="${local}"`)
  expect(html).toContain('Открыто · Позже')
})
