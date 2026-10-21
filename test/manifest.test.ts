import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import manifest from '../herdr-plugin.toml'

type Entry = { id?: string; command: string[] }
const entries = (key: string): Entry[] => (manifest as Record<string, Entry[]>)[key] ?? []
const root = join(import.meta.dir, '..')

describe('herdr-plugin.toml', () => {
  test('every startup, action and pane command runs an existing Bun entrypoint', () => {
    const all = [...entries('startup'), ...entries('actions'), ...entries('panes')]
    expect(all.length).toBe(7)
    for (const { command } of all) {
      expect(command[0]).toBe('bun')
      expect(command[1]).toMatch(/^src\/entrypoints\/[\w-]+\.ts$/)
      expect(existsSync(join(root, command[1] ?? ''))).toBe(true)
    }
  })

  test('installs the production dependencies when herdr builds the plugin', () => {
    expect(entries('build').map(b => b.command)).toEqual([['bun', 'install', '--production']])
  })

  test('platforms and ids are unchanged', () => {
    expect(manifest.platforms).toEqual(['windows', 'linux', 'macos'])
    expect(entries('actions').map(a => a.id)).toEqual(['open', 'web', 'install', 'notifications', 'doctor'])
    expect(entries('panes').map(p => p.id)).toEqual(['board'])
  })
})

// Wake's entries (#119) live on a copy until the takeover puts them in the board's own manifest.
describe('herdr-plugin.toml with wake’s entries, on a copy (test/fixtures/wake-manifest.toml)', () => {
  const read = (file: string): string => readFileSync(join(root, file), 'utf8')
  const parse = (text: string) => Bun.TOML.parse(text) as Record<string, Entry[] | undefined>
  const fragment = parse(read('test/fixtures/wake-manifest.toml'))
  const copy = parse(`${read('herdr-plugin.toml')}\n${read('test/fixtures/wake-manifest.toml')}`)
  const of = (m: Record<string, Entry[] | undefined>, key: string): Entry[] => m[key] ?? []

  test('the wake entries on a copy run existing Bun entrypoints', () => {
    const wake = [...of(fragment, 'startup'), ...of(fragment, 'actions'), ...of(fragment, 'panes')]
    expect(wake).toHaveLength(4)
    for (const { command } of wake) {
      expect(command[0]).toBe('bun')
      expect(command[1]).toMatch(/^src\/entrypoints\/[\w-]+\.ts$/)
      expect(existsSync(join(root, command[1] ?? ''))).toBe(true)
    }
    expect(of(fragment, 'startup').map(s => s.command)).toEqual([['bun', 'src/entrypoints/wake-start.ts']])
    expect(of(fragment, 'actions').map(a => a.id)).toEqual(['sleep', 'wake'])
    expect(of(fragment, 'panes').map(p => p.id)).toEqual(['wake'])

    // The board's own entries come first, as they are, in the same numbers.
    for (const key of ['build', 'startup', 'actions', 'panes']) {
      const board = entries(key)
      expect(of(copy, key).slice(0, board.length)).toEqual(board)
      expect(of(copy, key)).toHaveLength(board.length + of(fragment, key).length)
    }
    expect(copy.platforms).toEqual(manifest.platforms)
  })
})
