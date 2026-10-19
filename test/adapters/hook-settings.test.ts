// A profile folder's settings.json: read, the board's entries written into it, and whether they
// are there. Only in temp folders.
import { expect, onTestFinished, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hooksInstalled, installInto, readSettings } from '../../src/adapters/hook-settings.ts'
import type { InstallPaths } from '../../src/core/install-plan.ts'
import { boardFiles } from '../../src/core/setup.ts'

const paths = (root: string): InstallPaths => ({ bun: 'C:\\bun.exe', ...boardFiles(root), binDir: 'C:\\bin' })
const A = paths('C:\\plugins\\agent-board')
const B = paths('D:\\elsewhere\\agent-board')

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-hook-settings-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('readSettings: none, one with a BOM, one that does not parse (where only)', () => {
  const dir = tempDir()
  const file = join(dir, 'settings.json')
  expect(readSettings(dir)).toEqual({ file, text: null, settings: null, error: '' })
  writeFileSync(file, '\uFEFF{ "model": "x" }')
  expect(readSettings(dir)).toEqual({ file, text: '{ "model": "x" }', settings: { model: 'x' }, error: '' })
  writeFileSync(file, '{ "model": ')
  const broken = readSettings(dir)
  expect(broken).toMatchObject({ file, text: '{ "model": ', settings: null })
  expect(broken.error).toMatch(/^not valid JSON( \(position \d+\))?$/)
})

test('installInto: the board’s entries, a backup first; a folder made only when asked', () => {
  const home = tempDir()
  const gone = join(home, '.claude-work')
  expect(installInto(gone, A)).toMatchObject({ file: join(gone, 'settings.json'), ok: false })
  expect(existsSync(gone)).toBe(false)

  const fresh = join(home, '.claude')
  const made = installInto(fresh, A, { create: true })
  expect(made).toEqual({ file: join(fresh, 'settings.json'), ok: true, error: '', statusLineSet: true, toast: false })
  expect(readdirSync(fresh)).toEqual(['settings.json']) // nothing to back up
  expect(hooksInstalled(fresh, A)).toBe(true)

  const dir = join(home, '.claude-x')
  mkdirSync(dir)
  const before = '{ "model": "x", "statusLine": { "type": "command", "command": "mine" } }'
  writeFileSync(join(dir, 'settings.json'), before)
  const out = installInto(dir, A, { toast: true })
  expect(out).toMatchObject({ ok: true, statusLineSet: false, toast: true })
  expect(readFileSync(join(dir, 'settings.json.bak-agent-board'), 'utf8')).toBe(before)
  const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  expect(after.model).toBe('x')
  expect(after.statusLine).toEqual({ type: 'command', command: 'mine' })
  expect(readdirSync(dir).sort()).toEqual(['settings.json', 'settings.json.bak-agent-board'])

  // One that does not parse, or is no object: left as it was, no backup.
  for (const text of ['{', '[]']) {
    const odd = join(home, `odd${text.length}`)
    mkdirSync(odd)
    writeFileSync(join(odd, 'settings.json'), text)
    const r = installInto(odd, A, { create: true })
    expect(r.ok).toBe(false)
    expect(r.error).not.toBe('')
    expect(readdirSync(odd)).toEqual(['settings.json'])
    expect(readFileSync(join(odd, 'settings.json'), 'utf8')).toBe(text)
  }
})

test('hooksInstalled: both events with this copy’s hook; read again only when the file changes', () => {
  const dir = tempDir()
  const file = join(dir, 'settings.json')
  // Each write gets a time of its own: a file system's clock may give two quick writes the same one.
  let n = 0
  const changed = (): void => {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, ++n))
    utimesSync(file, at, at)
  }
  expect(hooksInstalled(dir, A)).toBe(false) // no file
  writeFileSync(file, '{')
  changed()
  expect(hooksInstalled(dir, A)).toBe(false)
  writeFileSync(file, '{}')
  expect(installInto(dir, B).ok).toBe(true)
  changed()
  expect(hooksInstalled(dir, A)).toBe(false) // another copy's
  expect(hooksInstalled(dir, B)).toBe(true)
  installInto(dir, A)
  changed()
  expect(hooksInstalled(dir, A)).toBe(true)
  // Only SessionStart: not installed.
  const text = readFileSync(file, 'utf8')
  const lone = text.replace('"UserPromptSubmit"', '"UserPromptSubmiX"')
  writeFileSync(file, lone)
  changed()
  expect(hooksInstalled(dir, A)).toBe(false)
  // The same modification time: the answer from before, the file not read again.
  const { mtime } = statSync(file)
  writeFileSync(file, text)
  utimesSync(file, mtime, mtime)
  expect(hooksInstalled(dir, A)).toBe(false)
  changed()
  expect(hooksInstalled(dir, A)).toBe(true)
})
