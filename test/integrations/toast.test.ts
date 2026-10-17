import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardFiles } from '../../src/core/setup.ts'
import { root } from '../support/sandbox.ts'

// The notification script is only parsed here, never run: it registers a URL protocol and shows
// notifications, which belong to the owner's computer (T30).
const script = boardFiles(root).toast
const windows = process.platform === 'win32'
const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

test.skipIf(!windows)(
  'toast.ps1 parses in Windows PowerShell',
  () => {
    const parse = Bun.spawnSync([
      powershell,
      '-NoProfile',
      '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); $e.Count`,
    ])
    assert.equal(parse.stdout.toString().trim(), '0', parse.stderr.toString())
  },
  20_000,
)

test('toast.ps1: its link handler takes a pane id only, and a click goes to this copy’s web board first', () => {
  const text = readFileSync(script, 'utf8')
  const rule = /-notmatch '(\^claude-pane:[^']+)'/.exec(text)?.[1]
  assert.ok(rule)
  const re = new RegExp(rule)
  for (const ok of ['claude-pane:wP:p3G', 'claude-pane:w12:p1/']) assert.match(ok, re)
  for (const bad of [
    'claude-pane:w1:p2;calc',
    'claude-pane:w1:p2&x',
    'claude-pane:../x',
    'claude-pane:w1:p2 x',
    'other:w1:p2',
  ])
    assert.doesNotMatch(bad, re)
  assert.ok(text.includes('Join-Path $BoardDir "src\\entrypoints\\web-open.ts"'))
  assert.ok(text.includes('$BoardDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)'))
})
