// The quick look's viewers (web/src/viewers/): each a script of its own that the page imports
// only when it opens such a file (components/files/Preview.tsx, viewers.ts), what they load from
// their packages as the packages have them, the packages' folders the static route serves, and
// the policy their workers run under.
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
 * The policy each worker runs under (its own response's, not the page's): it reads the file and
 * what it needs from the board, runs its own scripts, compiles PDF.js's decoders, and nothing else.
 * Before #176 a PDF was drawn in a frame under the raw route's policy; now PDF.js runs in the
 * board's origin, so its worker is held to what it needs.
 */
export const WORKER_POLICIES: Record<string, string> = {
  'pdf.worker.js': "default-src 'none'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'",
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
