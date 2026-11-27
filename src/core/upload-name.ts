// The name a file is kept under in the board's uploads (server/uploads.ts) and a received team
// file (#371, services/team-files.ts): letters, digits, dot and dash, so it is safe on disk and in
// a URL on every platform.

export const TEAM_FILE_PATH = /^\/api\/team\/files\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/

export const MAX_UPLOAD = 30 << 20

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
