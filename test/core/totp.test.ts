import { expect, test } from 'bun:test'
import { qrMatrix } from '../../src/core/qr.ts'
import { base32, base32Bytes, totpCode, totpMatch, totpStep, totpUri } from '../../src/core/totp.ts'

const RFC = new TextEncoder().encode('12345678901234567890')
const B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

test('RFC 6238 Appendix B, SHA-1, 8 digits; 6 digits are their last six', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]
  for (const [s, code] of vectors) {
    expect(totpCode(RFC, totpStep(s * 1000), 8)).toBe(code)
    expect(totpCode(RFC, totpStep(s * 1000))).toBe(code.slice(2))
  }
})
test('base32 both ways', () => {
  expect(base32(RFC)).toBe(B32)
  expect(base32Bytes(` ${B32.toLowerCase().slice(0, 16)} ${B32.slice(16)}`)).toEqual(RFC)
  expect(base32Bytes('GEZ1')).toBeNull()
})
test('one step of drift either way, never a step already used', () => {
  const now = 1111111111_000
  const step = totpStep(now)
  const code = (s: number) => totpCode(RFC, s)
  for (const s of [step - 1, step, step + 1]) expect(totpMatch(RFC, code(s), now, 0)).toBe(s)
  for (const s of [step - 2, step + 2]) expect(totpMatch(RFC, code(s), now, 0)).toBeNull()
  expect(totpMatch(RFC, code(step), now, step)).toBeNull()
  expect(totpMatch(RFC, code(step + 1), now, step)).toBe(step + 1)
  expect(totpMatch(RFC, ` ${code(step).slice(0, 3)} ${code(step).slice(3)} `, now, 0)).toBe(step)
  for (const bad of ['abcdef', '12345', 123456, null, '1234567']) expect(totpMatch(RFC, bad, now, 0)).toBeNull()
})
test('the URI fits a QR code, the domain in its label while it fits', () => {
  const uri = totpUri(B32, 'board.example.com')
  expect(uri).toBe(
    `otpauth://totp/Agent%20board%3Aboard.example.com?secret=${B32}&issuer=Agent%20board&algorithm=SHA1&digits=6&period=30`,
  )
  const long = totpUri(B32, `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`)
  expect(long).toBe(`otpauth://totp/Agent%20board?secret=${B32}&issuer=Agent%20board&algorithm=SHA1&digits=6&period=30`)
  for (const u of [uri, long]) expect(() => qrMatrix(u)).not.toThrow()
})
