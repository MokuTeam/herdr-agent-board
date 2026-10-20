// The QR encoder (core/qr.ts). Every length it takes (versions 1 to 10) was also read back by an
// independent decoder while it was written; here the pieces a reader depends on.
import { expect, test } from 'bun:test'
import { qrMatrix, qrPath, qrText, reedSolomon } from '../../src/core/qr.ts'

test('Reed-Solomon: the codewords of the standard worked example (1-M)', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
  expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
})

/** The 7x7 finder at (x, y): dark ring, light ring, dark 3x3 core. */
function hasFinder(m: boolean[][], x: number, y: number): boolean {
  for (let dy = 0; dy < 7; dy++)
    for (let dx = 0; dx < 7; dx++) {
      const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
      if (m[y + dy]?.[x + dx] !== (d !== 2)) return false
    }
  return true
}

test('the smallest version that holds the text, its finders, timing and dark module', () => {
  const texts = ['a', 'https://box.tail0.ts.net', 'https://a-long-computer-name.tail0abc1.ts.net:8443', 'x'.repeat(150)]
  expect(texts.map(s => qrMatrix(s).length)).toEqual([21, 25, 33, 49])
  for (const text of ['https://box.tail0.ts.net', 'x'.repeat(150)]) {
    const m = qrMatrix(text)
    const n = m.length
    expect(hasFinder(m, 0, 0) && hasFinder(m, n - 7, 0) && hasFinder(m, 0, n - 7)).toBe(true)
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]?.[i]).toBe(i % 2 === 0)
      expect(m[i]?.[6]).toBe(i % 2 === 0)
    }
    expect(m[n - 8]?.[8]).toBe(true)
  }
  expect(() => qrMatrix('x'.repeat(214))).toThrow('too long')
})

test('drawn as SVG with a quiet zone, and for a terminal black on white', () => {
  const m = qrMatrix('https://box.tail0.ts.net')
  const { d, size } = qrPath(m)
  expect(size).toBe(m.length + 8)
  expect(d.startsWith('M4 4h1v1h-1z')).toBe(true)
  const lines = qrText(m).split('\n')
  expect(lines).toHaveLength(Math.ceil((m.length + 8) / 2))
  expect(lines.every(l => l.startsWith('\x1b[30;107m') && l.endsWith('\x1b[0m'))).toBe(true)
})
