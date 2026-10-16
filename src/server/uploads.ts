// Files and screenshots sent to sessions from the board; the message carries their paths. They
// live in uploads/<day>/ and go after keepUploadsDays.
import { mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { uploadsDir } from '../adapters/paths.ts'
import { t } from '../core/lang.ts'
import { json, type Route } from './http.ts'

const MAX_UPLOAD = 30 << 20
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export type UploadResult =
  | { ok: true; path: string; name: string; size: number; url: string }
  | { ok: false; error: string }

/** A file name that is safe on disk and in a URL: letters, digits, dot and dash. */
export function safeName(name: unknown): string {
  const clean = (
    String(name ?? '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/^[-.]+|-+$/g, '')
    .slice(-120)
  return clean || 'file'
}

/** Day folders of uploads older than `days` go; the sessions have read them by then. */
export function pruneUploads(days: number): void {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  let dirs: string[] = []
  try {
    dirs = readdirSync(uploadsDir())
  } catch {
    return
  }
  for (const d of dirs)
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) rmSync(join(uploadsDir(), d), { recursive: true, force: true })
}

/** Stores the request's body as `<time>-<safe name>` under today's folder; over 30 MB is refused. */
export async function receiveUpload(req: Request, name: string): Promise<UploadResult> {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const stamp = now.toTimeString().slice(0, 8).replace(/:/g, '')
  const dir = join(uploadsDir(), day)
  mkdirSync(dir, { recursive: true })
  const file = `${stamp}-${safeName(name)}`
  const path = join(dir, file)
  // Held in memory (30 MB at most) and written once: a refused or broken upload leaves no file.
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (req.body)
      for await (const chunk of req.body) {
        size += chunk.byteLength
        if (size > MAX_UPLOAD) return { ok: false, error: t('err.upload.big', { mb: MAX_UPLOAD >> 20 }) }
        chunks.push(chunk)
      }
  } catch {
    return { ok: false, error: t('err.upload.broken') }
  }
  try {
    writeFileSync(path, Buffer.concat(chunks))
  } catch (err) {
    try {
      unlinkSync(path)
    } catch {}
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path, name: file, size, url: `/uploads/${day}/${encodeURIComponent(file)}` }
}

export function uploadRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/upload',
      guard: ['board-header'],
      async handle(req) {
        const r = await receiveUpload(req, decodeURIComponent(req.headers.get('x-filename') ?? 'file'))
        return json(r.ok ? 200 : 413, r)
      },
    },
    {
      method: 'GET',
      path: /^\/uploads\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/,
      async handle(_req, { params: [day = '', name = ''] }) {
        // Raster images show inline; anything else only downloads, so no uploaded page can run here.
        if (safeName(name) !== name) return json(404, { error: 'not found' })
        const body = await readFile(join(uploadsDir(), day, name)).catch(() => null)
        if (!body) return json(404, { error: 'not found' })
        const type = IMAGE_TYPES[extname(name).toLowerCase()]
        return new Response(body, {
          headers: {
            'content-type': type ?? 'application/octet-stream',
            'content-disposition': type ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'content-security-policy': "default-src 'none'",
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=86400',
          },
        })
      },
    },
  ]
}
