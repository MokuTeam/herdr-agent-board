import { describe, expect, test } from 'bun:test'
import { checklistActive, MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_TEXT, parseChecklist } from '../../src/core/checklist.ts'

describe('parseChecklist', () => {
  test('extracts counts, activeForm for in_progress, and ordered items', () => {
    const at = Date.UTC(2026, 10, 24, 8, 0, 0)
    const got = parseChecklist(
      {
        todos: [
          { content: 'Read transcript', status: 'completed' },
          { content: 'Parse TodoWrite', status: 'completed', activeForm: 'Parsing TodoWrite' },
          { content: 'Render progress', status: 'in_progress', activeForm: 'Rendering progress' },
          { content: 'Run tests', status: 'pending' },
        ],
      },
      at,
    )
    expect(got).toEqual({
      found: true,
      checklist: {
        done: 2,
        total: 4,
        current: 'Rendering progress',
        items: [
          { content: 'Read transcript', status: 'completed' },
          { content: 'Parse TodoWrite', status: 'completed', activeForm: 'Parsing TodoWrite' },
          { content: 'Render progress', status: 'in_progress', activeForm: 'Rendering progress' },
          { content: 'Run tests', status: 'pending' },
        ],
        at,
      },
    })
  })

  test('falls back to content when in_progress has no activeForm, or first pending item', () => {
    const noActiveForm = parseChecklist({
      todos: [
        { content: 'Step 1', status: 'completed' },
        { content: 'Step 2', status: 'in_progress' },
      ],
    })
    expect(noActiveForm.checklist?.current).toBe('Step 2')

    const onlyPending = parseChecklist({
      todos: [
        { content: 'Step 1', status: 'completed' },
        { content: 'Step 2', status: 'pending', activeForm: 'Doing step 2' },
        { content: 'Step 3', status: 'pending' },
      ],
    })
    expect(onlyPending.checklist?.current).toBe('Step 2')
    expect(onlyPending.checklist?.at).toBeUndefined()
  })

  test('returns found:true without checklist when empty or all items are completed', () => {
    expect(parseChecklist({ todos: [] })).toEqual({ found: true })
    expect(
      parseChecklist({
        todos: [
          { content: 'One', status: 'completed' },
          { content: 'Two', status: 'completed' },
        ],
      }),
    ).toEqual({ found: true })
  })

  test('returns found:false when input is not a TodoWrite payload', () => {
    expect(parseChecklist(null)).toEqual({ found: false })
    expect(parseChecklist('todos')).toEqual({ found: false })
    expect(parseChecklist({})).toEqual({ found: false })
    expect(parseChecklist({ todos: 'bad' })).toEqual({ found: false })
  })

  test('skips malformed entries, collapses whitespace, and enforces item and text caps', () => {
    const longText = `  ${'a'.repeat(MAX_CHECKLIST_TEXT + 40)}\n  more  `
    const todos = [
      null,
      { content: '   ', status: 'pending' },
      { content: 'bad status', status: 'unknown' },
      { content: 'valid\n  multiline\tstep', status: 'in_progress', activeForm: longText },
      ...Array.from({ length: MAX_CHECKLIST_ITEMS + 10 }, (_, i) => ({
        content: `Item ${i}`,
        status: 'pending' as const,
      })),
    ]
    const got = parseChecklist({ todos })
    expect(got.found).toBe(true)
    expect(got.checklist?.total).toBe(MAX_CHECKLIST_ITEMS)
    expect(got.checklist?.items).toHaveLength(MAX_CHECKLIST_ITEMS)
    expect(got.checklist?.items[0]?.content).toBe('valid multiline step')
    expect(got.checklist?.current.length).toBe(MAX_CHECKLIST_TEXT)
    expect(got.checklist?.current.endsWith('…')).toBe(true)
  })
})

describe('checklistActive', () => {
  test('checks remaining work and non-empty items', () => {
    expect(checklistActive(undefined)).toBe(false)
    expect(checklistActive(null)).toBe(false)
    expect(checklistActive({ done: 0, total: 0, current: '', items: [] })).toBe(false)
    expect(
      checklistActive({
        done: 2,
        total: 2,
        current: '',
        items: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'completed' },
        ],
      }),
    ).toBe(false)
    expect(
      checklistActive({
        done: 1,
        total: 2,
        current: 'B',
        items: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'in_progress' },
        ],
      }),
    ).toBe(true)
  })
})
