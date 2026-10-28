// The quick look's viewers (web/src/viewers/): each a script of its own that the page imports
// only when it opens such a file (components/files/Viewer.tsx), what they load from their
// packages as the packages have them, and the packages' folders the static route serves.
import { dirname, join } from 'node:path'

/** Served name to entry: bundled apart from app.js (web-bundle.ts). */
export const viewerEntries = (web: string): Record<string, string> => ({
  'pdf-viewer.js': join(web, 'src', 'viewers', 'pdf.ts'),
})

/** Served name to module: PDF.js's worker, minified by its makers, served as it is. */
export const VIEWER_COPIES: Record<string, string> = {
  'pdf.worker.js': 'pdfjs-dist/build/pdf.worker.min.mjs',
}

/**
 * What the PDF viewer's worker fetches when a PDF needs it (JBIG2 and JPEG 2000 decoders, the
 * CJK character maps, the standard fonts, a color profile): served folder to the package's own.
 * None when the package is not installed (the viewer then does not build either).
 */
export function viewerDirs(root: string): Record<string, string> {
  let pdfjs: string
  try {
    pdfjs = dirname(Bun.resolveSync('pdfjs-dist/package.json', root))
  } catch {
    return {}
  }
  return Object.fromEntries(['cmaps', 'standard_fonts', 'wasm', 'iccs'].map(d => [`pdfjs/${d}`, join(pdfjs, d)]))
}
