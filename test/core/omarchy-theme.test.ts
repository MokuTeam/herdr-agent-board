// The web board's Terminal style in the colors of the Omarchy theme on now (src/core/omarchy-theme.ts,
// #161): the theme read and mixed as Omarchy's own templates do, every rule under the style, and the
// page untouched where neither Omarchy nor config.json's `look` asks for anything.
import { describe, expect, test } from 'bun:test'
import { mix, omarchyCss, omarchyTokens, pageWithLook, parseColors } from '../../src/core/omarchy-theme.ts'
import { rulesOf } from '../web/support/stylesheets.ts'

// Omarchy's stock Tokyo Night and Catppuccin Latte (/usr/share/omarchy/themes/*/colors.toml), in part.
const TOKYO = `mode = "dark"

accent = "#7aa2f7"
background = "#1a1b26"
dark_background = "#13141c"
foreground = "#a9b1d6"  # its text
red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
cyan = "#449dab"
magenta = "#ad8ee6"
`
const LATTE = TOKYO.replace('mode = "dark"', 'mode = "light"')
  .replace('#1a1b26', '#eff1f5')
  .replace('#a9b1d6', '#4c4f69')
  .replace('dark_background = "#13141c"\n', '')

describe('the theme', () => {
  test('colors.toml as key = "value" lines, comments left out', () => {
    const c = parseColors(TOKYO)
    expect([c.mode, c.accent, c.foreground]).toEqual(['dark', '#7aa2f7', '#a9b1d6'])
  })

  test('mixed as Omarchy mixes (its mix_color, run on the same colors)', () => {
    // omarchy-theme-set-templates' awk gives these for Tokyo Night and Catppuccin Latte.
    expect(mix('#a9b1d6', '#1a1b26', 0.34)).toBe('#787e9a')
    expect(mix('#a9b1d6', '#1a1b26', 0.52)).toBe('#5f637a')
    expect(mix('#1a1b26', '#a9b1d6', 0.3)).toBe('#45485b')
    expect(mix('#4c4f69', '#eff1f5', 0.34)).toBe('#838699')
    expect(mix('#eff1f5', '#4c4f69', 0.3)).toBe('#bec0cb')
  })

  test('the style’s colors: text, quiet text and borders as Omarchy’s apps take them; none without what it needs', () => {
    expect(omarchyTokens(parseColors(TOKYO))).toEqual({
      '--t-bg': '#1a1b26',
      '--t-text': '#a9b1d6',
      '--t-dim': '#787e9a',
      '--t-faint': '#5f637a',
      '--t-edge': '#45485b',
      '--t-accent': '#7aa2f7',
      '--t-green': '#9ece6a',
      '--t-amber': '#e0af68',
      '--t-red': '#f7768e',
      '--t-purple': '#ad8ee6',
      '--t-cyan': '#449dab',
      '--term-bg': '#13141c',
      '--term-edge': '#45485b',
    })
    expect(omarchyTokens(parseColors(TOKYO.replace('#7aa2f7', 'red; } body { color: red')))).toBeNull()
    expect(omarchyCss(parseColors('mode = "dark"'))).toBeNull()
  })

  test('its stylesheet styles only the Terminal style, in the theme’s own mode', () => {
    for (const [toml, mode, other] of [
      [TOKYO, 'dark', 'light'],
      [LATTE, 'light', 'dark'],
    ] as const) {
      const css = omarchyCss(parseColors(toml)) ?? ''
      const rules = rulesOf('omarchy-theme.css', css)
      expect(rules.length).toBe(3)
      for (const r of rules) expect(r.selector.startsWith(':root[data-look="terminal"]')).toBe(true)
      expect(css).toContain(`@media (prefers-color-scheme: ${mode}) {`)
      expect(css).toContain(`:root[data-look="terminal"]:not([data-theme="${other}"])`)
      expect(css).toContain(`:root[data-look="terminal"][data-theme="${mode}"] {`)
      expect(css).toContain('--t-mono: monospace, monospace;')
      expect([...css.matchAll(/@([\w-]+)/g)].map(m => m[1])).toEqual(['media'])
    }
  })
})

describe('the page', () => {
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n  <link rel="stylesheet" href="styles/look-terminal.css">\n</head>'

  test('neither Omarchy nor a look in config.json: the page as it is', () => {
    expect(pageWithLook(html, { look: undefined, omarchy: false })).toBe(html)
    expect(pageWithLook(html, { look: 'classic', omarchy: false })).toBe(html)
  })

  test('config.json’s look: Terminal is where a browser starts; Omarchy: its theme linked after the style', () => {
    expect(pageWithLook(html, { look: 'terminal', omarchy: false })).toBe(
      html.replace('<html lang', '<html data-look-default="terminal" lang'),
    )
    expect(pageWithLook(html, { look: undefined, omarchy: true })).toBe(
      html.replace('look-terminal.css">', 'look-terminal.css">\n  <link rel="stylesheet" href="omarchy-theme.css">'),
    )
  })
})
