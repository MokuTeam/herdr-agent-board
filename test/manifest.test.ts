import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
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
