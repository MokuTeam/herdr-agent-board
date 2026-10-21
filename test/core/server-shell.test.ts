import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { isContainerId, isPlainPath, isUnitName, shQuote } from '../../src/core/server-shell.ts'

describe('shell words for the server’s scripts', () => {
  test("a quote becomes '\\'' and the word stays one word", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'")
  })
  test('spaces, %, $, backticks, double quotes and other alphabets stay as they are', () => {
    expect(shQuote('a b%$`"Ж')).toBe("'a b%$`\"Ж'")
  })
  test('a newline, a carriage return or a NUL never reaches the server', () => {
    expect(() => shQuote('a\nb')).toThrow()
    expect(() => shQuote('a\rb')).toThrow()
    expect(() => shQuote('a\0b')).toThrow()
  })
  test('a container id is 64 lowercase hex characters', () => {
    const id = 'a'.repeat(32) + '0123456789abcdef'.repeat(2)
    expect(isContainerId(id)).toBe(true)
    expect(isContainerId(id.slice(1))).toBe(false)
    expect(isContainerId(id.toUpperCase())).toBe(false)
    expect(isContainerId('abc;rm')).toBe(false)
    expect(isContainerId('')).toBe(false)
  })
  test('a plain path is absolute, with no newline and no .. part', () => {
    expect(isPlainPath('/srv/my web/Caddyfile')).toBe(true)
    expect(isPlainPath('/etc/caddy/Caddyfile')).toBe(true)
    expect(isPlainPath('srv/x')).toBe(false)
    expect(isPlainPath('/a/../b')).toBe(false)
    expect(isPlainPath('/a\nb')).toBe(false)
  })
  test('a unit name is a service', () => {
    expect(isUnitName('caddy.service')).toBe(true)
    expect(isUnitName('getty@tty1.service')).toBe(true)
    expect(isUnitName('docker-0a.scope')).toBe(false)
    expect(isUnitName('a b.service')).toBe(false)
    expect(isUnitName("x';rm.service")).toBe(false)
  })
  test('no node: import: the page renders “Do it myself” from it', () => {
    expect(readFileSync('src/core/server-shell.ts', 'utf8')).not.toMatch(/from 'node:/)
    expect(readFileSync('src/core/server-facts.ts', 'utf8')).not.toMatch(/from 'node:/)
  })
})
