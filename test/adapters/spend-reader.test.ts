import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearSpendCache, readTranscriptSpend } from '../../src/adapters/spend-reader.ts'

const dirs: string[] = []
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'spend-reader-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  clearSpendCache()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const claudeRow = (id: string, input: number, output: number, ts = '2026-11-23T10:00:00Z') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      id,
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })

describe('spend-reader incremental cache', () => {
  test('reads incrementally on append, waits on half-written JSON lines, and resets on truncation', async () => {
    const dir = makeDir()
    const file = join(dir, 's1.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: 'anna-fix' })}\n${claudeRow('m1', 100, 20)}\n`)

    const r1 = await readTranscriptSpend(file, 'claude', { zone: 'UTC' })
    expect(r1?.title).toBe('anna-fix')
    expect(r1?.spend.total.total).toBe(120)

    // Cache hit returns identical spend.
    const r1Again = await readTranscriptSpend(file, 'claude', { zone: 'UTC' })
    expect(r1Again?.spend.total.total).toBe(120)

    // Append a half-written line (invalid JSON without trailing newline): should keep previous total.
    const fullSecond = `${claudeRow('m2', 200, 30)}\n`
    const half = fullSecond.slice(0, 20)
    appendFileSync(file, half)
    const rHalf = await readTranscriptSpend(file, 'claude', { zone: 'UTC' })
    expect(rHalf?.spend.total.total).toBe(120)

    // Complete the second line: incremental read adds m2 without re-counting m1.
    appendFileSync(file, fullSecond.slice(20))
    const r2 = await readTranscriptSpend(file, 'claude', { zone: 'UTC' })
    expect(r2?.spend.total).toEqual({
      input: 300,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      total: 350,
      responses: 2,
    })

    // Truncate / rewrite file smaller: resets parser cleanly.
    writeFileSync(file, `${claudeRow('m3', 40, 10)}\n`)
    const rReset = await readTranscriptSpend(file, 'claude', { zone: 'UTC' })
    expect(rReset?.spend.total.total).toBe(50)
    expect(rReset?.spend.total.responses).toBe(1)
  })

  test('returns null for missing or empty files', async () => {
    const dir = makeDir()
    expect(await readTranscriptSpend(join(dir, 'nope.jsonl'), 'claude')).toBeNull()
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '')
    expect(await readTranscriptSpend(empty, 'claude')).toBeNull()
  })
})
