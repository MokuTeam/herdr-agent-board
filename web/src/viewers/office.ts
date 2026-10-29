// What the quick look's Word and spreadsheet viewers (document.ts, spreadsheet.ts) are given and
// give back: each reads its file in a worker of its own and draws it into `host`.

/** Why a file is not shown: a password, broken, too big for the viewer (or too long to read), other. */
export type ViewerFailure = 'password' | 'broken' | 'big' | 'other'

/** A worker that has not answered in this long is let go of: the file is too big to show here. */
export const WORKER_TIMEOUT_MS = 60_000

export interface OfficeOptions {
  /** The bytes, through the board's file route with its token. */
  url: string
  /** The file's name (its extension says what it should hold). */
  name: string
  /** The viewer's worker, served beside it. */
  worker: string
  /** The page's language (a spreadsheet's numbers and dates). */
  lang: string
  /** "The start only": under a sheet cut short. */
  truncated: string
  onReady(): void
  onFail(why: ViewerFailure, message: string): void
}

export interface OfficeViewer {
  destroy(): void
}
