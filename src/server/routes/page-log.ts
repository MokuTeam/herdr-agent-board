// A line from the page for the board's log: the board in a phone's browser says what it could not
// do there (a paste that found no picture, the page started over), which nobody at the computer
// sees otherwise. One line, cut to 500 characters, marked as the page's.
import { json, type Route } from '../http.ts'

export const pageLogLine = (text: unknown): string =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 500) : ''

export function pageLogRoute(log: (text: string) => void): Route {
  return {
    method: 'POST',
    path: '/api/log',
    guard: ['board-header', 'origin'],
    async handle(_req, ctx) {
      const line = pageLogLine((await ctx.body()).text)
      if (!line) return json(400, { ok: false, error: 'text' })
      log(`page: ${line}`)
      return json(200, { ok: true })
    },
  }
}
