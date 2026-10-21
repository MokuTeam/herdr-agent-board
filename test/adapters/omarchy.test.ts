// Omarchy on this computer (src/adapters/omarchy.ts, #161): its theme on now read and followed; on a
// computer without it, nothing at all.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { omarchyCurrent, omarchyTheme } from '../../src/adapters/omarchy.ts'

const COLORS = (accent: string) =>
  `background = "#1a1b26"\nforeground = "#a9b1d6"\naccent = "${accent}"\nred = "#f7768e"\nyellow = "#e0af68"\ngreen = "#9ece6a"\ncyan = "#449dab"\nmagenta = "#ad8ee6"\n`

test('no Omarchy, or not Linux: none', () => {
  const home = mkdtempSync(join(tmpdir(), 'omarchy-'))
  try {
    expect(omarchyTheme(() => {}, { home, platform: 'linux' })).toBeNull()
    mkdirSync(join(omarchyCurrent(home), 'theme'), { recursive: true })
    expect(omarchyTheme(() => {}, { home, platform: 'win32' })).toBeNull()
    expect(omarchyTheme(() => {}, { home, platform: 'darwin' })).toBeNull()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the theme on now; a switch puts another in place, and the board hears of it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'omarchy-'))
  const current = omarchyCurrent(home)
  mkdirSync(join(current, 'theme'), { recursive: true })
  writeFileSync(join(current, 'theme', 'colors.toml'), COLORS('#7aa2f7'))
  let heard = 0
  const theme = omarchyTheme(() => heard++, { home, platform: 'linux' })
  try {
    expect(theme?.css()).toContain('--t-accent: #7aa2f7;')
    const first = theme?.stamp()
    expect(first).toMatch(/^[0-9a-f]{12}$/)
    // As omarchy-theme-set does: the next theme beside it, then moved in.
    mkdirSync(join(current, 'next-theme'))
    writeFileSync(join(current, 'next-theme', 'colors.toml'), COLORS('#e8a33d'))
    rmSync(join(current, 'theme'), { recursive: true })
    renameSync(join(current, 'next-theme'), join(current, 'theme'))
    for (let i = 0; i < 40 && !heard; i++) await Bun.sleep(50)
    expect(heard).toBe(1)
    expect(theme?.css()).toContain('--t-accent: #e8a33d;')
    expect(theme?.stamp()).not.toBe(first)
  } finally {
    theme?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
