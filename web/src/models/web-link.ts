/** A web link must parse as an absolute HTTP or HTTPS URL. */
export function safeLink(link: string | null | undefined): string | null {
  if (!link) return null
  try {
    const u = new URL(link)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}
