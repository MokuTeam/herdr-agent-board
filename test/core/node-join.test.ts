// Unit tests for #513 join codes, socket names, and HMAC proofs (src/core/node-join.ts).
import { describe, expect, test } from 'bun:test'
import {
  generateJoinCode,
  generateSocketName,
  JOIN_CODE,
  JOIN_HEX64,
  joinProof,
  parseHelloJoin,
  parseJoinRecord,
  sameJoinCode,
  verifyJoinProof,
} from '../../src/core/node-join.ts'
import { RELAY_KEY_NAME } from '../../src/core/relay-texts.ts'

describe('node join codes and HMAC proofs (#513)', () => {
  test('generates valid join codes and relay socket names', () => {
    for (let i = 0; i < 10; i++) {
      const code = generateJoinCode()
      expect(JOIN_CODE.test(code)).toBe(true)
      const sock = generateSocketName('Anna Laptop!!')
      expect(RELAY_KEY_NAME.test(sock)).toBe(true)
      expect(sock.startsWith('anna-laptop-')).toBe(true)
    }
    expect(RELAY_KEY_NAME.test(generateSocketName('---'))).toBe(true)
    expect(generateSocketName('---').startsWith('node-')).toBe(true)
  })

  test('joinProof binds code, certificate fingerprint, and node id; tampering fails', () => {
    const code = generateJoinCode()
    const fp = 'a1'.repeat(32)
    const fpOther = 'b2'.repeat(32)
    const proof = joinProof(code, fp.toUpperCase(), 'macbook-anna')
    expect(JOIN_HEX64.test(proof)).toBe(true)

    expect(verifyJoinProof(code, fp, 'macbook-anna', proof)).toBe(true)
    expect(verifyJoinProof(code, fp.toUpperCase(), 'macbook-anna', proof.toUpperCase())).toBe(true)

    // Wrong code, wrong cert fingerprint, wrong node id, or tampered proof must all fail
    expect(verifyJoinProof(generateJoinCode(), fp, 'macbook-anna', proof)).toBe(false)
    expect(verifyJoinProof(code, fpOther, 'macbook-anna', proof)).toBe(false)
    expect(verifyJoinProof(code, fp, 'other-node', proof)).toBe(false)
    expect(verifyJoinProof(code, fp, 'macbook-anna', `${'0'.repeat(63)}f`)).toBe(false)
    expect(verifyJoinProof('short', fp, 'macbook-anna', proof)).toBe(false)
  })

  test('sameJoinCode compares constantly and rejects empty/mismatched codes', () => {
    const c = generateJoinCode()
    expect(sameJoinCode(c, c)).toBe(true)
    expect(sameJoinCode(c, `${c}x`)).toBe(false)
    expect(sameJoinCode('', '')).toBe(false)
  })

  test('parseJoinRecord and parseHelloJoin validate shapes strictly', () => {
    const code = generateJoinCode()
    const fp = 'ab'.repeat(32)
    const proof = joinProof(code, fp, 'n1')
    expect(parseJoinRecord({ code, expiresAt: 1000, attempts: 0 })).toEqual({ code, expiresAt: 1000, attempts: 0 })
    expect(parseJoinRecord({ code: 'bad', expiresAt: 1000, attempts: 0 })).toBeNull()
    expect(parseJoinRecord({ code, expiresAt: -1, attempts: 0 })).toBeNull()
    expect(parseJoinRecord({ code, expiresAt: 1000, attempts: -1 })).toBeNull()

    expect(parseHelloJoin({ fingerprint: fp.toUpperCase(), proof: proof.toUpperCase(), expiresAt: 1000 })).toEqual({
      fingerprint: fp,
      proof,
      expiresAt: 1000,
    })
    expect(parseHelloJoin({ fingerprint: 'nope', proof, expiresAt: 1000 })).toBeNull()
    expect(parseHelloJoin({ fingerprint: fp, proof: 'nope', expiresAt: 1000 })).toBeNull()
  })
})
