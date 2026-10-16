// The page: top-level files of web/ by name, app.js from the in-memory bundle (web-bundle.ts).
// Last in the table: any GET no other route took.
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { json, type Route } from '../http.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}
// The page's scripts and styles come from here only (inline style attributes are used for colors).
const PAGE_CSP =
  "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"

export function staticRoute(web: string, bundle: { js(): string }): Route {
  return {
    method: 'GET',
    path: /^/,
    async handle(_req, { path }) {
      const name = path === '/' ? 'index.html' : path.slice(1)
      const type = TYPES[extname(name)]
      if (!/^[\w.-]+$/.test(name) || !type) return json(404, { error: 'not found' })
      const body = name === 'app.js' ? bundle.js() : await readFile(join(web, name)).catch(() => null)
      if (!body) return json(404, { error: 'not found' })
      return new Response(body, {
        headers: {
          'content-type': type,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          ...(name.endsWith('.html') ? { 'content-security-policy': PAGE_CSP } : {}),
        },
      })
    },
  }
}
