import { describe, test } from 'bun:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { root, sandbox } from '../support/sandbox.ts'

// Claude Code waits for its hooks and its status line: an empty or broken input must end them at
// once, quietly, with exit code 0 (main printed nothing either, on stdout or stderr).
const scripts = ['hook', 'statusline'].map(name => join(root, 'src', 'entrypoints', `${name}.ts`))

describe('hook and status line with an empty or malformed stdin', () => {
  for (const script of scripts) {
    for (const stdin of ['', '{not json']) {
      for (const pane of [false, true]) {
        test(`${script.slice(root.length)} stdin=${JSON.stringify(stdin)} in a herdr pane=${pane}`, async () => {
          const box = await sandbox()
          const started = Date.now()
          const proc = Bun.spawn([process.execPath, script], {
            cwd: root,
            env: { ...box.env, ...(pane ? { HERDR_PANE_ID: 'p1' } : {}) },
            stdin: new TextEncoder().encode(stdin),
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ])
          const code = await proc.exited
          assert.equal(code, 0, stderr)
          assert.equal(stdout, '')
          assert.equal(stderr, '')
          assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`)
        })
      }
    }
  }
})
