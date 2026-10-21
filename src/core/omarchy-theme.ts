// The web board's Terminal style in the colors of the Omarchy theme on now (omarchy.org): the theme's
// colors.toml read as Omarchy's own templates read it, mixed as they mix (omarchy-theme-set-templates'
// mix_color: each channel weighed and rounded), and the system's monospace font (fontconfig's, which
// `omarchy font set` sets). Omarchy's apps take their quiet text, faint text and borders that way
// (its pi.json.tpl: mutedText, dimText, border). The style follows the theme in its own mode, dark
// or light; in the other one it keeps its One Dark / One Light (web/styles/look-terminal.css).
// Pure: src/adapters/omarchy.ts reads the file and serves what comes out.

export type OmarchyColors = Record<string, string>

const HEX = /^#[0-9a-fA-F]{6}$/

/** `key = "value"` lines of colors.toml; comments, tables and anything else left out. */
export function parseColors(toml: string): OmarchyColors {
  const colors: OmarchyColors = {}
  for (const line of toml.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line)
    if (m?.[1] && m[2] !== undefined) colors[m[1]] = m[2]
  }
  return colors
}

/** `start` mixed with `end` by `amount` (0..1), as Omarchy's templates mix: each channel rounded. */
export function mix(start: string, end: string, amount: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  const parts = [0, 1, 2].map(i => Math.floor(channel(start, i) * (1 - amount) + channel(end, i) * amount + 0.5))
  return `#${parts.map(p => p.toString(16).padStart(2, '0')).join('')}`
}

/** The style's variables (look-terminal.css's --t-*) from the theme's colors; null when one it needs is missing or not a color. */
export function omarchyTokens(c: OmarchyColors): Record<string, string> | null {
  const need = ['background', 'foreground', 'accent', 'red', 'yellow', 'green', 'cyan', 'magenta']
  if (!need.every(k => HEX.test(c[k] ?? ''))) return null
  const bg = c.background as string
  const fg = c.foreground as string
  const term = HEX.test(c.dark_background ?? '') ? (c.dark_background as string) : bg
  return {
    '--t-bg': bg,
    '--t-text': fg,
    '--t-dim': mix(fg, bg, 0.34),
    '--t-faint': mix(fg, bg, 0.52),
    '--t-edge': mix(bg, fg, 0.3),
    '--t-accent': c.accent as string,
    '--t-green': c.green as string,
    '--t-amber': c.yellow as string,
    '--t-red': c.red as string,
    '--t-purple': c.magenta as string,
    '--t-cyan': c.cyan as string,
    '--term-bg': term,
    '--term-edge': mix(bg, fg, 0.3),
  }
}

const MARK = '/* The Omarchy theme on now, for the Terminal style (src/core/omarchy-theme.ts). */'

/** The stylesheet the page links after look-terminal.css on a computer with Omarchy; null when the theme does not say enough. */
export function omarchyCss(c: OmarchyColors): string | null {
  const tokens = omarchyTokens(c)
  if (!tokens) return null
  const body = Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  const light = c.mode === 'light'
  const [mode, other] = light ? ['light', 'dark'] : ['dark', 'light']
  return [
    MARK,
    // The system's monospace is fontconfig's, which Omarchy's font is. Named twice: a lone
    // `monospace` makes a browser size text by its own monospace default.
    ':root[data-look="terminal"] { --t-mono: monospace, monospace; }',
    `@media (prefers-color-scheme: ${mode}) {`,
    `  :root[data-look="terminal"]:not([data-theme="${other}"]) {`,
    body.replace(/^/gm, '  '),
    '  }',
    '}',
    `:root[data-look="terminal"][data-theme="${mode}"] {`,
    body,
    '}',
    '',
  ].join('\n')
}

/**
 * The page as it goes out, for the board's settings: config.json's `look` makes Terminal the style a
 * browser starts in until it picks one (theme.js reads data-look-default), and with Omarchy here
 * the page links its theme's colors after the style's own. Neither: the page as it is.
 */
export function pageWithLook(html: string, { look, omarchy }: { look: unknown; omarchy: boolean }): string {
  let page = html
  if (look === 'terminal') page = page.replace(/<html\b/, '<html data-look-default="terminal"')
  if (omarchy)
    page = page.replace(
      '<link rel="stylesheet" href="styles/look-terminal.css">',
      '$&\n  <link rel="stylesheet" href="omarchy-theme.css">',
    )
  return page
}
