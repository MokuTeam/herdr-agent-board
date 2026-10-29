// Files and folders the chat mentions: what they are, a preview, opening them, links, the raw
// bytes of media for the quick look and any file as a download (adapters/files.ts); folders for
// the folder picker. Through the tunnel, the board's own files are none of these (ctx.ownFile):
// stat says they are missing, the others refuse them.
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { describe, MEDIA_TYPES, openWith, preview, resolvePath } from '../../adapters/files.ts'
import { listDirs } from '../../adapters/folders.ts'
import { t } from '../../core/lang.ts'
import { type Body, json, type Route, type RouteContext } from '../http.ts'

const missing = (body: Body) => json(400, { error: t('err.fs.missing', { path: String(body.path ?? '') }) })
/** A file of the board's own, asked for through the tunnel. */
const ownRefusal = () => json(403, { error: t('err.fs.own') })
const opened = (r: { ok: boolean; error?: string }) =>
  json(r.ok ? 200 : 500, r.ok ? r : { error: t('err.fs.open', { why: String(r.error) }) })

// An SVG opened on its own runs no script here; the PDF viewer needs no sandbox.
const RAW_CSP =
  "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox"
const PDF_CSP = "default-src 'none'; frame-ancestors 'self'"

/** The one range main reads (`bytes=a-b`, `bytes=a-`, `bytes=-n`): null for none, 'unsatisfiable' past the end. */
function byteRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const range = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!range || !(range[1] || range[2])) return null
  let start = 0
  let end = size - 1
  if (range[1]) {
    start = Number(range[1])
    if (range[2]) end = Math.min(Number(range[2]), end)
  } else start = Math.max(0, size - Number(range[2]))
  return start > end ? 'unsatisfiable' : { start, end }
}

/**
 * GET /api/fs/raw. The bytes go as a slice of the file for a range, and as the file itself
 * otherwise, except when the request carries a Range main did not read: Bun.serve would answer
 * that one with a 206 of its own, so that body goes from memory.
 */
async function raw(req: Request, ctx: RouteContext): Promise<Response> {
  const { path: target } = resolvePath(ctx.url.searchParams.get('path'))
  if (target && ctx.ownFile(target)) return ownRefusal()
  const type = MEDIA_TYPES[extname(target).slice(1).toLowerCase()]
  const st = target ? statSync(target, { throwIfNoEntry: false }) : null
  if (!type || !st?.isFile()) return json(404, { error: 'not found' })
  const head = {
    'content-type': type,
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'content-security-policy': type === 'application/pdf' ? PDF_CSP : RAW_CSP,
  }
  const asked = req.headers.get('range')
  const range = byteRange(asked, st.size)
  if (range === 'unsatisfiable')
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${st.size}` } })
  if (range) {
    const { start, end } = range
    return new Response(Bun.file(target).slice(start, end + 1), {
      status: 206,
      headers: {
        ...head,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': String(end - start + 1),
      },
    })
  }
  const headers = { ...head, 'content-length': String(st.size) }
  if (st.size === 0) return new Response(null, { headers })
  return new Response(asked === null ? Bun.file(target) : await Bun.file(target).bytes(), { headers })
}

/**
 * Content-Disposition for a download (RFC 6266): a plain ASCII filename for old clients, and the
 * real name as UTF-8 in filename* (RFC 8187).
 */
export function attachment(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${plain}"; filename*=UTF-8''${utf8}`
}

/** GET /api/fs/download: any file the quick look can show, saved on the viewer's device, never shown inline. */
function download(ctx: RouteContext): Response {
  const { path: target } = resolvePath(ctx.url.searchParams.get('path'))
  if (target && ctx.ownFile(target)) return ownRefusal()
  const st = target ? statSync(target, { throwIfNoEntry: false }) : null
  if (!st?.isFile()) return json(404, { error: 'not found' })
  const headers = {
    'content-type': 'application/octet-stream',
    'content-disposition': attachment(basename(target)),
    'content-length': String(st.size),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  }
  // Bun.file goes out as it is read from disk, not from memory.
  return new Response(st.size === 0 ? null : Bun.file(target), { headers })
}

export function fsRoutes(): Route[] {
  const post = (path: string | RegExp, handle: Route['handle']): Route => ({
    method: 'POST',
    path,
    guard: ['board-header'],
    handle,
  })
  return [
    // Folders only, for the new-session window's folder picker (adapters/folders.ts).
    post('/api/fs/dirs', async (_req, ctx) => {
      const body = await ctx.body()
      // A blank path lists the roots; any other is the folder listDirs reads.
      if (String(body.path ?? '').trim()) {
        const { path: target } = resolvePath(body.path)
        if (target && ctx.ownFile(target)) return ownRefusal()
      }
      return json(200, await listDirs(body.path, { git: !!body.git }))
    }),
    post('/api/fs/stat', async (_req, ctx) => {
      const body = await ctx.body()
      const raws = Array.isArray(body.paths) ? body.paths.slice(0, 300).map(String) : []
      const items = raws.map(raw => {
        const { path: target, line } = resolvePath(raw, String(body.cwd ?? ''))
        if (!target) return { raw, line, path: '', exists: false }
        // Missing, so the page shows no link for it.
        if (ctx.ownFile(target)) return { raw, line, path: target, name: basename(target), exists: false }
        return { raw, line, ...describe(target) }
      })
      return json(200, { items })
    }),
    post('/api/fs/preview', async (_req, ctx) => {
      const body = await ctx.body()
      const { path: target } = resolvePath(body.path, String(body.cwd ?? ''))
      if (!target) return missing(body)
      return ctx.ownFile(target) ? ownRefusal() : json(200, preview(target))
    }),
    post('/api/fs/open', async (_req, ctx) => {
      const body = await ctx.body()
      const { path: target } = resolvePath(body.path, String(body.cwd ?? ''))
      if (!target) return missing(body)
      if (!describe(target).exists) return json(404, { error: t('err.fs.missing', { path: target }) })
      return opened(await openWith(target, body.how === 'reveal' ? 'reveal' : 'open'))
    }),
    // Any other POST under /api/fs/ (main took the body and the path before it looked at the name).
    post(/^\/api\/fs\//, async (_req, ctx) => {
      const body = await ctx.body()
      return resolvePath(body.path, String(body.cwd ?? '')).path ? json(404, { error: 'not found' }) : missing(body)
    }),
    post('/api/open-url', async (_req, ctx) => {
      const body = await ctx.body()
      let link: URL | null = null
      try {
        link = new URL(String(body.url ?? ''))
      } catch {}
      if (!link || !/^https?:$/.test(link.protocol))
        return json(400, { error: t('err.fs.open', { why: String(body.url ?? '') }) })
      return opened(await openWith(link.href))
    }),
    // Bytes of an image, PDF, video or audio file for the quick look: the per-run token stands
    // for the X-Board header, which <img>, <video> and the PDF viewer cannot send.
    { method: 'GET', path: '/api/fs/raw', guard: ['fs-token'], handle: raw },
    // Any file as a download, for the board on another device: the same token, as <a href> sends no header.
    { method: 'GET', path: '/api/fs/download', guard: ['fs-token'], handle: (_req, ctx) => download(ctx) },
  ]
}
