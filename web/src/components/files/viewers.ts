// The quick look's viewers (web/src/viewers/, #176): each a script the board serves beside
// app.js (server/viewers.ts), imported only when such a file is opened, so the page's own script
// stays as small as it was. A phone's page names its build (app.js?v=…, core/pwa.ts); a viewer
// and its worker are asked for under the same one, so the service worker keeps them apart too.
// One file in a viewer is a session (openViewer): its script imported, the file drawn, and the
// viewer let go of when it fails or the file is no longer on show.
import type { mount as documentMount } from '../../viewers/document.ts'
import type { mount as pdfMount } from '../../viewers/pdf.ts'

export type { PdfViewer } from '../../viewers/pdf.ts'

/** A file the board serves beside app.js, under the build the page runs (`script`: app.js's URL). */
export function besideApp(name: string, script: string = import.meta.url): string {
  const app = new URL(script)
  const url = new URL(name, app)
  url.search = app.search
  return url.href
}

/** Where PDF.js's decoders, character maps and fonts are: the same for every build. */
export const pdfAssets = (script: string = import.meta.url): string => new URL('pdfjs/', script).href

export interface PdfModule {
  mount: typeof pdfMount
}

/** The Word and the spreadsheet viewer draw the same way (viewers/office.ts). */
export interface OfficeModule {
  mount: typeof documentMount
}

/** The kinds of file read by a viewer and a worker of their own. */
export type OfficeKind = 'document' | 'spreadsheet'

export type Import<T> = (url: string) => Promise<T>

const loaded = new Map<string, Promise<unknown>>()

/** `<name>-viewer.js`, imported once; a failed import is tried again next time. */
export function loadViewer<T>(name: string, load: Import<T> = url => import(url)): Promise<T> {
  let module = loaded.get(name) as Promise<T> | undefined
  if (!module) {
    module = load(besideApp(`${name}-viewer.js`)).catch(err => {
      loaded.delete(name)
      throw err
    })
    loaded.set(name, module)
  }
  return module
}

export type ViewerFailure = 'password' | 'broken' | 'other'

/** Where a file in a viewer is: coming, drawn, failed (and why), or with no viewer to draw it. */
export type ViewerState =
  | { at: 'loading' }
  | { at: 'shown' }
  | { at: 'failed'; why: ViewerFailure }
  | { at: 'unavailable' }

/** What a viewer tells of the file it draws. */
export interface ViewerReport {
  ready(): void
  fail(why: ViewerFailure): void
}

/**
 * One file in a viewer: its module imported, then mounted. A failure lets go of the viewer at
 * once (and of its worker); the returned stop, before the module came, mounts nothing, after it,
 * lets go of the viewer.
 */
export function openViewer<M, V extends { destroy(): void }>(
  load: () => Promise<M>,
  mount: (module: M, report: ViewerReport) => V,
  onState: (state: ViewerState) => void,
): () => void {
  let viewer: V | null = null
  let over = false
  onState({ at: 'loading' })
  load().then(
    module => {
      if (over) return
      let failed = false
      const report: ViewerReport = {
        ready: () => {
          if (!over && !failed) onState({ at: 'shown' })
        },
        fail: why => {
          if (over || failed) return
          failed = true
          onState({ at: 'failed', why })
          viewer?.destroy()
          viewer = null
        },
      }
      let shown: V
      try {
        shown = mount(module, report)
      } catch {
        // A viewer that throws as it starts: the file cannot be shown, and there is nothing to let go of.
        return report.fail('other')
      }
      if (failed) shown.destroy()
      else viewer = shown
    },
    () => {
      if (!over) onState({ at: 'unavailable' })
    },
  )
  return () => {
    over = true
    viewer?.destroy()
    viewer = null
  }
}

/** What the quick look draws for a viewer's state: the browser's frame, "loading", or why not. */
export interface ViewerLook {
  frame: boolean
  wait: boolean
  /** The text's key when it draws nothing (with the button that opens it), else null. */
  empty: string | null
}

/** The texts of a kind of file: a password, broken, no viewer (null: the browser's own frame). */
export interface ViewerTexts {
  password: string
  broken: string
  unavailable: string | null
}

export const PDF_TEXTS: ViewerTexts = { password: 'ql.pdfPassword', broken: 'ql.pdfBroken', unavailable: null }

/** A Word document or a spreadsheet without its viewer: the file cannot be shown here. */
export const OFFICE_TEXTS: ViewerTexts = {
  password: 'ql.fileLocked',
  broken: 'ql.fileBroken',
  unavailable: 'ql.fileBroken',
}

export function viewerLook(state: ViewerState, texts: ViewerTexts): ViewerLook {
  if (state.at === 'unavailable')
    return texts.unavailable === null
      ? { frame: true, wait: false, empty: null }
      : { frame: false, wait: false, empty: texts.unavailable }
  if (state.at === 'failed')
    return { frame: false, wait: false, empty: state.why === 'password' ? texts.password : texts.broken }
  return { frame: false, wait: state.at === 'loading', empty: null }
}
