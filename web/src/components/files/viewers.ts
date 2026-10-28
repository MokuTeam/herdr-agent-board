// The quick look's viewers (web/src/viewers/, #176): each a script the board serves beside
// app.js (server/viewers.ts), imported only when such a file is opened, so the page's own script
// stays as small as it was. A phone's page names its build (app.js?v=…, core/pwa.ts); a viewer
// and its worker are asked for under the same one, so the service worker keeps them apart too.
import type { mount as pdfMount } from '../../viewers/pdf.ts'

export type { PdfFailure, PdfViewer } from '../../viewers/pdf.ts'

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

let pdf: Promise<PdfModule> | null = null

/** The PDF viewer's module, imported once; a failed import is tried again next time. */
export function loadPdf(load: (url: string) => Promise<PdfModule> = url => import(url)): Promise<PdfModule> {
  pdf ??= load(besideApp('pdf-viewer.js')).catch(err => {
    pdf = null
    throw err
  })
  return pdf
}
