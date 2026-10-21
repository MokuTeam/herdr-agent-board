// Omarchy (omarchy.org) on this computer: the theme it has on now, for the web board's Terminal style
// (src/core/omarchy-theme.ts). Omarchy keeps it in ~/.local/state/omarchy/current/theme, which a
// theme switch puts in place anew; the board watches for that and tells the pages. A computer
// without Omarchy gets null: one look for the folder when the board starts, and nothing after.
import { createHash } from 'node:crypto'
import { existsSync, type FSWatcher, readFileSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { omarchyCss, parseColors } from '../core/omarchy-theme.ts'

export interface OmarchyTheme {
  /** The stylesheet of the theme on now; null when its colors cannot be read. */
  css(): string | null
  /** Changes with the stylesheet: the pages load it again (the payload's `omarchy`). */
  stamp(): string | null
  close(): void
}

/** Where Omarchy keeps the theme on now. */
export const omarchyCurrent = (home: string): string => join(home, '.local', 'state', 'omarchy', 'current')

/** The theme on now, watched; null without Omarchy here. `onChange` runs when a switch changed its colors. */
export function omarchyTheme(
  onChange: () => void,
  { home = homedir(), platform = process.platform }: { home?: string; platform?: string } = {},
): OmarchyTheme | null {
  if (platform !== 'linux') return null
  const current = omarchyCurrent(home)
  if (!existsSync(current)) return null
  let css: string | null = null
  let stamp: string | null = null
  const read = (): void => {
    try {
      css = omarchyCss(parseColors(readFileSync(join(current, 'theme', 'colors.toml'), 'utf8')))
    } catch {
      css = null
    }
    stamp = css ? createHash('sha1').update(css).digest('hex').slice(0, 12) : null
  }
  read()
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: FSWatcher | null = null
  try {
    // A switch writes the next theme beside it, then moves it in: read once it has settled.
    watcher = watch(current, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const before = stamp
        read()
        if (stamp !== before) onChange()
      }, 300)
    })
  } catch {}
  return {
    css: () => css,
    stamp: () => stamp,
    close() {
      clearTimeout(timer)
      watcher?.close()
    },
  }
}
