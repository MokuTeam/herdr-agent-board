// What travels for the owner's git identity and GitHub login and what a node decides with it
// (core/git-access.ts, #609): gh's hosts file read for hosts and accounts only, the steps a node
// takes by SHA-256, what a device's row says it lacks, the identity in a bundle and its report line,
// and gh in the install's packages where the system's own repositories have it.
import { describe, expect, test } from 'bun:test'
import { buildManifest, bundleHash, manifestOf } from '../../src/core/bundle.ts'
import {
  credentialInput,
  ghHostsOf,
  gitFactsOf,
  gitLacks,
  identityOf,
  identityStep,
  loginStep,
} from '../../src/core/git-access.ts'
import { ghPackaged, NODE_PACKAGES, nodePackages } from '../../src/core/node-texts.ts'

const CANARY = 'gho_canaryCoreGitAccess0123456789'

describe("gh's hosts file", () => {
  test('hosts and accounts, a token kept there (no keyring) is never read into the answer', () => {
    const yml = [
      'github.com:',
      '    users:',
      '        Eithery-rc:',
      `            oauth_token: ${CANARY}`,
      `    oauth_token: ${CANARY}`,
      '    git_protocol: https',
      '    user: Eithery-rc',
      'ghe.example.com:',
      '    git_protocol: https',
      '    user: worker',
      '',
    ].join('\n')
    const hosts = ghHostsOf(yml)
    expect(hosts).toEqual([
      { host: 'github.com', user: 'Eithery-rc' },
      { host: 'ghe.example.com', user: 'worker' },
    ])
    expect(JSON.stringify(hosts)).not.toContain(CANARY)
  })

  test('nothing logged in, a host with no account, a name no host has: none', () => {
    expect(ghHostsOf('')).toEqual([])
    expect(ghHostsOf('github.com:\n    git_protocol: https\n')).toEqual([])
    expect(ghHostsOf('bad host:\n    user: x\n')).toEqual([])
    // A user under users: (deeper) is not the host's active account.
    expect(ghHostsOf('github.com:\n    users:\n        user: nested\n')).toEqual([])
  })
})

describe('what a node does, by SHA-256', () => {
  test('a login: the same there is taken over, none or the one given before is replaced, another is kept', () => {
    expect(loginStep('a', null, 'a')).toBe('same')
    expect(loginStep('a', null, null)).toBe('login')
    expect(loginStep('b', 'a', 'a')).toBe('login')
    expect(loginStep('a', null, 'own')).toBe('kept')
    expect(loginStep('b', 'a', 'own')).toBe('kept')
    // A login there whose token cannot be read (gh older than 2.17): the bundle's when it gave one.
    expect(loginStep('a', null, undefined)).toBe('kept')
    expect(loginStep('a', 'a', undefined)).toBe('same')
    expect(loginStep('b', 'a', undefined)).toBe('login')
  })

  test("an identity: the same is taken over, the bundle's own is followed, the owner's own is kept", () => {
    const owner = { name: 'Owner', email: 'o@example.com' }
    const other = { name: 'Other', email: 'x@example.com' }
    expect(identityStep(owner, null, owner)).toBe('same')
    expect(identityStep(owner, null, null)).toBe('set')
    expect(identityStep(owner, other, other)).toBe('set')
    expect(identityStep(owner, null, other)).toBe('kept')
    expect(identityStep(owner, owner, other)).toBe('kept')
  })

  test('an identity is two one-line values; a credential input refuses what would break its lines', () => {
    expect(identityOf(' Owner ', 'o@example.com')).toEqual({ name: 'Owner', email: 'o@example.com' })
    expect(identityOf('Owner', '')).toBeNull()
    expect(identityOf('Own\ner', 'o@example.com')).toBeNull()
    expect(credentialInput('github.com', 'owner', CANARY)).toBe(
      `protocol=https\nhost=github.com\nusername=owner\npassword=${CANARY}\n\n`,
    )
    expect(credentialInput('github.com', 'owner')).toBe('protocol=https\nhost=github.com\nusername=owner\n\n')
    expect(credentialInput('github.com\nhost=evil', 'owner', CANARY)).toBeNull()
    expect(credentialInput('github.com', 'owner', 'two words')).toBeNull()
  })
})

describe("a device's row (#609)", () => {
  const status = (programs: string[], identity: boolean, logins: { host: string; user: string }[]) => ({
    programs,
    git: { identity, logins },
  })
  test('what an agent there cannot do, in order of what it needs first', () => {
    expect(gitLacks(status(['bash'], false, []))).toEqual(['git'])
    expect(gitLacks(status(['git'], false, []))).toEqual(['identity', 'login'])
    expect(gitLacks(status(['git'], true, [{ host: 'github.com', user: 'o' }]))).toEqual(['gh'])
    expect(gitLacks(status(['git', 'gh'], true, [{ host: 'github.com', user: 'o' }]))).toEqual([])
  })
  test('a node of an older board, or no status: nothing said', () => {
    expect(gitLacks(null)).toEqual([])
    expect(gitLacks({ programs: ['python3'] })).toEqual([])
  })
  test("a status's git is checked field by field", () => {
    expect(
      gitFactsOf({
        identity: true,
        logins: [
          { host: 'github.com', user: 'o' },
          { host: 'x y', user: 'o' },
        ],
      }),
    ).toEqual({
      identity: true,
      logins: [{ host: 'github.com', user: 'o' }],
    })
    expect(gitFactsOf({ identity: 'yes', logins: [] })).toBeUndefined()
    expect(gitFactsOf(null)).toBeUndefined()
  })
})

describe('the identity with the bundle (#609)', () => {
  const parts = { files: [], followed: [], skipped: [], settings: {}, mcpServers: {} }
  const ctx = { from: 'win32', to: 'linux', profileDir: 'C:/Users/o/.claude' }
  const board = { config: {}, sinks: {} }
  test('given: in the manifest and a report line; the hash moves with it', () => {
    const before = buildManifest(parts as never, board, ctx)
    const m = buildManifest(parts as never, board, { ...ctx, identity: { name: 'Owner', email: 'o@example.com' } })
    expect(m.git).toEqual({ name: 'Owner', email: 'o@example.com' })
    expect(m.report).toContainEqual({ kind: 'git', name: 'identity', verdict: 'sent', why: 'identity' })
    expect(bundleHash(m)).not.toBe(bundleHash(before))
    expect(bundleHash({ ...m, git: { name: 'Owner', email: 'other@example.com' } })).not.toBe(bundleHash(m))
    expect(manifestOf({ ...m, report: [] })?.git).toEqual({ name: 'Owner', email: 'o@example.com' })
  })
  test('none on the master: no identity, and the report says so', () => {
    const m = buildManifest(parts as never, board, { ...ctx, identity: null })
    expect('git' in m).toBe(false)
    expect(m.report).toContainEqual({ kind: 'git', name: 'identity', verdict: 'not-sent', why: 'no-identity' })
    expect(bundleHash(m)).toBe(bundleHash(buildManifest(parts as never, board, ctx)))
  })
  test('not asked (no git on the sync): the bundle as before, no line', () => {
    const m = buildManifest(parts as never, board, ctx)
    expect('git' in m).toBe(false)
    expect(m.report.some(r => r.kind === 'git')).toBe(false)
  })
  test("a manifest's git that is not two plain values is not taken", () => {
    const m = buildManifest(parts as never, board, ctx)
    expect(manifestOf({ ...m, git: { name: 'a\nb', email: 'x' } })?.git).toBeUndefined()
    expect(manifestOf({ ...m, git: 'Owner' })?.git).toBeUndefined()
  })
})

describe("gh in the install's packages (#609)", () => {
  test("Debian 12 and 13, Ubuntu 24.04 to 26.04: from the system's own repositories", () => {
    for (const os of [
      { id: 'debian', version: '12' },
      { id: 'debian', version: '13' },
      { id: 'ubuntu', version: '24.04' },
      { id: 'ubuntu', version: '25.10' },
      { id: 'ubuntu', version: '26.04' },
    ])
      expect(nodePackages(os)).toEqual([...NODE_PACKAGES, 'gh'])
  })
  test('elsewhere, and where its gh is older than 2.17 (Ubuntu 22.04): not in the list', () => {
    expect(ghPackaged({ id: 'ubuntu', version: '22.04' })).toBe(false)
    expect(ghPackaged({ id: 'debian', version: '11' })).toBe(false)
    expect(ghPackaged({ id: 'fedora', version: '41' })).toBe(false)
    expect(nodePackages({ id: 'debian', version: '11' })).toEqual([...NODE_PACKAGES])
  })
})
