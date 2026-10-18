import { afterEach, describe, setSystemTime, test } from 'bun:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../../src/core/categories.ts'
import { t } from '../../src/core/lang.ts'
import { boardFiles, checkSetup, type SetupFacts, type SetupSummary, setupSummary } from '../../src/core/setup.ts'
import { createSetupChecks } from '../../src/services/setup-check.ts'
import { until } from '../support/sandbox.ts'

// The setup check's rules with a gather of its own: nothing of this computer is read.
const ROOT = '/plugins/agent-board'

/** A computer with nothing of the board set up. */
const fresh = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  platform: 'linux',
  root: ROOT,
  node: '22.5.0',
  binDir: '/home/u/.local/bin',
  path: '/usr/bin',
  files: boardFiles(ROOT),
  commands: {},
  settingsFile: '/home/u/.claude/settings.json',
  settings: null,
  settingsError: '',
  herdrConfigFile: '/home/u/.config/herdr/config.toml',
  herdrConfig: null,
  wakeUrl: null,
  wake: null,
  launcher: null,
  ...over,
})

/** A gather that answers when the test says so, counting its calls. */
function heldGather() {
  const releases: ((facts: SetupFacts) => void)[] = []
  return {
    calls: () => releases.length,
    release: (facts: SetupFacts = fresh()) => releases.shift()?.(facts),
    gather: () => new Promise<SetupFacts>(resolve => releases.push(resolve)),
  }
}

/** The checks with that gather; `published` holds the summary each time the board went out. */
function checksWith(gather: () => Promise<SetupFacts>) {
  const published: (SetupSummary | null)[] = []
  const logged: string[] = []
  const checks = createSetupChecks({
    deps: { cfg: DEFAULT_CONFIG, log: text => logged.push(text) },
    onChange: () => published.push(checks.summary()),
    gather,
  })
  return { checks, published, logged }
}

afterEach(() => {
  setSystemTime()
})

describe('the setup check', () => {
  test('no summary before the first check ends; one check at a time; the summary set before the board goes out', async () => {
    const held = heldGather()
    const { checks, published } = checksWith(held.gather)
    assert.equal(checks.summary(), null)
    const first = checks.now()
    const second = checks.now()
    assert.equal(second, first) // shares the check that runs
    assert.equal(held.calls(), 1)
    assert.equal(checks.summary(), null)
    held.release()
    const expected = setupSummary(checkSetup(fresh()))
    assert.ok(expected.todo > 0)
    // The list in the board's language; the summary from the English one.
    assert.deepEqual(await first, checkSetup(fresh(), t))
    assert.deepEqual(published, [expected])
    assert.deepEqual(checks.summary(), expected)
  })

  test('requests within 3 s share the last check; a later one runs it again', async () => {
    let calls = 0
    const { checks, published } = checksWith(async () => {
      calls++
      return fresh()
    })
    const start = Date.parse('2026-10-17T10:00:00Z')
    setSystemTime(start)
    await checks.now()
    setSystemTime(start + 2999)
    assert.deepEqual(await checks.now(), checkSetup(fresh(), t))
    assert.equal(calls, 1)
    assert.equal(published.length, 1)
    setSystemTime(start + 3000)
    await checks.now()
    assert.equal(calls, 2)
    assert.equal(published.length, 2)
  })

  test('a check that ends after stop() publishes nothing', async () => {
    const held = heldGather()
    const { checks, published } = checksWith(held.gather)
    checks.start()
    assert.equal(held.calls(), 1)
    const running = checks.now()
    checks.stop()
    held.release()
    await running
    assert.deepEqual(published, [])
  })

  test('a check that fails is logged, and the next request runs one again', async () => {
    let calls = 0
    const { checks, published, logged } = checksWith(async () => {
      if (++calls === 1) throw new Error('no settings')
      return fresh()
    })
    checks.start()
    await until(() => logged.length)
    assert.deepEqual(logged, ['setup check: no settings'])
    assert.equal(checks.summary(), null)
    await checks.now()
    assert.equal(calls, 2)
    assert.equal(published.length, 1)
    checks.stop()
  })
})
