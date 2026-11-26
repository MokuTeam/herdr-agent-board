// A file the board serves, saved on this device by the page itself (#873): fetched by the page,
// so the browser sends the login cookie as for any request of the page, and handed to the
// browser's download as a blob. A plain link would leave the page on a phone (the installed app
// opens it in the system's browser view), and that navigation goes without the cookie.

export interface SaveDeps {
  fetch(url: string, init: RequestInit): Promise<Response>
  document: Pick<Document, 'createElement' | 'body'>
  URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
  later(fn: () => void, ms: number): void
}

const pageDeps = (): SaveDeps => ({
  fetch: (url, init) => fetch(url, init),
  document,
  URL,
  later: (fn, ms) => void setTimeout(fn, ms),
})

/** Saves `url` as `name`; null when the browser has it, else why not. */
export async function saveFile(url: string, name: string, deps: SaveDeps = pageDeps()): Promise<string | null> {
  let blob: Blob
  try {
    const res = await deps.fetch(url, { credentials: 'same-origin' })
    if (!res.ok) return `HTTP ${res.status}`
    blob = await res.blob()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  const href = deps.URL.createObjectURL(blob)
  const a = deps.document.createElement('a')
  a.href = href
  a.download = name
  a.hidden = true
  deps.document.body.append(a)
  a.click()
  a.remove()
  // The download has its bytes by then; a phone may take a while to start it.
  deps.later(() => deps.URL.revokeObjectURL(href), 60_000)
  return null
}
