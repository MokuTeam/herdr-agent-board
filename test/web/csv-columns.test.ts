// A CSV drawn block by block keeps its columns (components/files/Preview.tsx Table, #176): each
// is sized once for the widest values anywhere in the file, by the browser's own layout of a few
// rows put in for the measure and taken out again (measureColumns), the values chosen by length
// and by a rough width (models/files.ts widestCandidates).
import { describe, expect, test } from 'bun:test'
import { measureColumns } from '../../web/src/components/files/Preview.tsx'
import { roughWidth, widestCandidates } from '../../web/src/models/files.ts'

describe('the values a CSV’s columns are measured by', () => {
  test('the longest few and the widest few: twenty-nine W beat forty-eight i', () => {
    const rows = [
      ['narrow', 'wide'],
      ['i'.repeat(48), 'a'],
      ['W'.repeat(29), 'b'],
      ['x', '漢字'.repeat(8)],
      ['y', 'z'.repeat(20)],
    ]
    expect(roughWidth('W'.repeat(29))).toBeGreaterThan(roughWidth('i'.repeat(48)))
    expect(roughWidth('漢')).toBe(2)
    const [narrow = [], wide = []] = widestCandidates(rows, 1)
    expect(narrow).toEqual(['i'.repeat(48), 'W'.repeat(29)])
    expect(wide).toEqual(['z'.repeat(20), '漢字'.repeat(8)])
    // The header row is not a candidate: it is drawn already.
    expect(widestCandidates([['a header far longer than the rest'], ['x']])).toEqual([['x']])
  })
})

/** A table whose header cells lay out as wide as the widest value in their column, in rough letters of 7 px. */
function fakeTable(columns: number) {
  const body = { rows: [] as FakeRow[], append: (tr: FakeRow) => void body.rows.push(tr) }
  interface FakeRow {
    cells: { textContent: string }[]
    append(td: { textContent: string }): void
    remove(): void
  }
  const doc = {
    createElement: (tag: string) => {
      if (tag === 'td') return { textContent: '' }
      const tr: FakeRow = {
        cells: [],
        append: td => void tr.cells.push(td),
        remove: () => void body.rows.splice(body.rows.indexOf(tr), 1),
      }
      return tr
    },
  }
  const heads = Array.from({ length: columns }, (_, i) => ({
    get offsetWidth() {
      return Math.ceil(Math.max(40, ...body.rows.map(r => roughWidth(r.cells[i]?.textContent ?? '') * 7 + 28)))
    },
  }))
  return {
    table: {
      tBodies: [body],
      ownerDocument: doc,
      style: { width: '', minWidth: '' },
      querySelectorAll: () => heads,
    } as unknown as HTMLTableElement,
    body,
  }
}

describe('a CSV’s columns measured once', () => {
  test('each as wide as its widest candidate lays out, at most 420 px; the rows put in are taken out', () => {
    const { table, body } = fakeTable(3)
    const widths = measureColumns(table, [['W'.repeat(29), 'i'.repeat(48)], ['1234567890123456'], ['n'.repeat(200)]])
    expect(widths).toEqual([Math.ceil(29 * 1.4 * 7 + 28) + 1, 16 * 7 + 28 + 1, 420])
    expect(body.rows).toEqual([])
    expect([table.style.width, table.style.minWidth]).toEqual(['', ''])
  })
})
