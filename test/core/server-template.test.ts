import { describe, expect, test } from 'bun:test'
import { shQuote } from '../../src/core/server-shell.ts'
import { fill, type Inputs, type Place, spell, templateOf } from '../../src/core/server-template.ts'

const q = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : shQuote(s))
const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'

/** A small "generator" like the board's: one value in many spellings, one derived from it, a list. */
function render(v: Record<string, string | string[]>): string {
  const file = v.file as string
  const cand = `${dirOf(file)}/.cand`
  const hosts = v.hosts as string[]
  return [
    `sudo cp -p ${q(file)} ${q(cand)}`,
    `echo ${shQuote(`The file ${file} is kept.`)}`,
    `sudo sh -c ${shQuote(`test -s ${q(cand)} && cat ${q(cand)} > ${q(file)}`)}`,
    `I1=${shQuote(JSON.stringify({ kind: 'line', file }))}`,
    `for h in ${hosts.map(shQuote).join(' ')}; do echo "$h"; done`,
    `gid ${v.gid}`,
  ].join('\n')
}

const INPUTS: Inputs = {
  file: { sentinel: '/zqdir/zqfile', alt: '/etc/caddy/Caddyfile', probe: '/p q/x y' },
  hosts: { sentinel: ['zqhost.example'], alt: ['a.example.com'], probe: ['b.example.com', 'c.example.com'] },
  gid: { sentinel: '7654321', alt: '997' },
}
const PLACES: Place[] = [
  { name: 'file', from: ['file'], text: v => v.file as string },
  { name: 'cand', from: ['file'], text: v => `${dirOf(v.file as string)}/.cand` },
  { name: 'hosts', from: ['hosts'], text: v => v.hosts as string[], spelling: 'sqwords' },
  { name: 'gid', from: ['gid'], text: v => v.gid as string },
]

describe('templates of the board’s scripts', () => {
  const t = templateOf(render, INPUTS, PLACES)

  test('each place named with how it spells its value', () => {
    expect(t.split('\n')).toEqual([
      'sudo cp -p @{file|q}@ @{cand|q}@',
      "echo 'The file @{file}@ is kept.'",
      "sudo sh -c 'test -s @{cand|sqq}@ && cat @{cand|sqq}@ > @{file|sqq}@'",
      `I1='{"kind":"line","file":"@{file}@"}'`,
      'for h in @{hosts|sqwords}@; do echo "$h"; done',
      'gid @{gid}@',
    ])
  })

  test('filled in, it is what the generator renders, for values that need quoting or not', () => {
    for (const values of [
      { file: '/srv/my web/Caddyfile', hosts: ['a.example.com', 'b.example.com'], gid: '995' },
      { file: '/etc/caddy/Caddyfile', hosts: ['x.example.org'], gid: '0' },
      { file: '/Caddyfile', hosts: [], gid: '1' },
    ]) {
      const derived = { ...values, cand: `${dirOf(values.file)}/.cand` }
      expect(fill(t, derived)).toBe(render(values))
    }
  })

  test('a stand-in that comes out of the generator unchanged elsewhere is refused', () => {
    const leaky = (v: Record<string, string | string[]>): string => `${render(v)}\n# /zqdir/zqfile`
    expect(() => templateOf(leaky, INPUTS, PLACES)).toThrow()
  })

  test('spellings', () => {
    expect(spell('/a b', 'q')).toBe("'/a b'")
    expect(spell('/a/b', 'q')).toBe('/a/b')
    expect(spell('/a b', 'sqq')).toBe("'\\''/a b'\\''")
    expect(spell(['a', 'b c'], 'qwords')).toBe("a 'b c'")
    expect(spell(['80', '[::]:80'], 'listen')).toBe("'    listen 80;' '    listen [::]:80;'")
    expect(spell([], 'sqwords')).toBe('')
  })

  test('lines: a place that is a whole line takes any number of lines, or none', () => {
    const tpl = 'a\n@{relies|lines}@\nb'
    expect(fill(tpl, { relies: 'x\ny' })).toBe('a\nx\ny\nb')
    expect(fill(tpl, { relies: '' })).toBe('a\nb')
  })

  test('a place with no value is an error, not an empty word', () => {
    expect(() => fill('cp @{file|q}@ x', {})).toThrow()
  })
})
