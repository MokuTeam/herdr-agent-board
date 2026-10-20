// The page: top-level files of web/ and its styles/ by name, app.js with its source map (and
// theme.js, the viewer's light or dark before the page paints) from the in-memory bundle of the
// React page (web-bundle.ts). Last in the table: any GET no other route took. `html` changes the
// page as it goes out: the board for a phone's browser (core/pwa.ts).
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { json, type Route } from '../http.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
}

// The page's scripts and styles come from here only (inline style attributes are used for colors).
const PAGE_CSP =
  "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"

// Text goes out compressed when the browser takes it: app.js is a megabyte, and a phone's link is
// slow. Each file's compressed copy is kept until the file changes, so a build is compressed once,
// by the first request that asks for it, not by every request.
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.webmanifest', '.map'])
type Encoding = 'br' | 'gzip'
type Body = string | Buffer<ArrayBuffer>
// Brotli's quality 5: a tenth smaller than gzip in as little time; its best takes seconds.
const COMPRESS: Record<Encoding, (body: Body) => Buffer<ArrayBuffer>> = {
  br: body => brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
  gzip: body => gzipSync(body),
}

/** br, else gzip, as the request's Accept-Encoding takes them (`q=0` refuses one); none for neither. */
export function encodingFor(accept: string | null): Encoding | undefined {
  const taken = new Map<string, boolean>()
  for (const part of (accept ?? '').toLowerCase().split(',')) {
    const [name = '', ...params] = part.split(';').map(p => p.trim())
    const q = params.find(p => p.startsWith('q='))
    taken.set(name, !q || Number(q.slice(2)) > 0)
  }
  return (['br', 'gzip'] as const).find(e => taken.get(e) ?? taken.get('*'))
}

/**
 * Whether `If-None-Match` names the answer's tag: `*`, or one of its tags compared weakly (a `W/`
 * on either side does not count), as RFC 9110 has it for this header.
 */
export function matchesTag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false
  const bare = (tag: string): string => tag.trim().replace(/^W\//, '')
  return ifNoneMatch.split(',').some(tag => tag.trim() === '*' || bare(tag) === bare(etag))
}

const same = (a: Body, b: Body): boolean => a === b || (typeof a !== 'string' && typeof b !== 'string' && a.equals(b))

export function staticRoute(
  web: string,
  bundle: { js(): string; map(): string; early(): string },
  html?: (page: string) => string,
): Route {
  type Kept = { body: Body; hash: string } & Partial<Record<Encoding, Buffer<ArrayBuffer>>>
  const kept = new Map<string, Kept>()
  /** What is kept of the file `name` (its hash, its compressed copies) while it stays `body`. */
  function keptFor(name: string, body: Body): Kept {
    const before = kept.get(name)
    if (before && same(before.body, body)) return before
    const copies: Kept = { body, hash: createHash('sha1').update(body).digest('base64url').slice(0, 16) }
    kept.set(name, copies)
    return copies
  }
  /** `body` of the file `name` compressed, from what is kept while the file stays the same. */
  function compressed(name: string, body: Body, encoding: Encoding): Buffer<ArrayBuffer> {
    const copies = keptFor(name, body)
    copies[encoding] ??= COMPRESS[encoding](body)
    return copies[encoding]
  }

  return {
    method: 'GET',
    path: /^/,
    async handle(req, { path }) {
      const name = path === '/' ? 'index.html' : path.slice(1)
      const type = TYPES[extname(name)]
      // One folder deep at most, and only styles/: nothing else under web/ (web/src) is served.
      if (!/^(styles\/)?[\w.-]+$/.test(name) || !type) return json(404, { error: 'not found' })
      const file =
        name === 'app.js'
          ? bundle.js()
          : name === 'app.js.map'
            ? bundle.map()
            : name === 'theme.js'
              ? bundle.early()
              : await readFile(join(web, name)).catch(() => null)
      if (!file) return json(404, { error: 'not found' })
      const body = html && name.endsWith('.html') ? html(file.toString()) : file
      const text = TEXT.has(extname(name))
      const encoding = text ? encodingFor(req.headers.get('accept-encoding')) : undefined
      // The tag of these bytes: the file's hash, and the encoding they go out in (the compressed
      // and the plain answer are different bytes). `no-cache` has the browser ask again on every
      // open (a phone's service worker too, through the browser's cache); while the build is the
      // same, the answer is a 304 with no body instead of the whole file again.
      const etag = `"${keptFor(name, body).hash}${encoding ? `-${encoding}` : ''}"`
      const headers: Record<string, string> = {
        'cache-control': 'no-cache',
        etag,
        // Caches keep the compressed and the plain answer apart.
        ...(text ? { vary: 'accept-encoding' } : {}),
      }
      if (matchesTag(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers })
      return new Response(encoding ? compressed(name, body, encoding) : body, {
        headers: {
          'content-type': type,
          ...headers,
          'x-content-type-options': 'nosniff',
          ...(name.endsWith('.html') ? { 'content-security-policy': PAGE_CSP } : {}),
          ...(encoding ? { 'content-encoding': encoding } : {}),
        },
      })
    },
  }
}
