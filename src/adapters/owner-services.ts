// The board keeps only token hashes. Session keys are public and never recycled.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isOwnerServiceKey, OWNER_SERVICE_PREFIX, type OwnerService } from '../core/owner-services.ts'
import { validName } from '../core/team.ts'
import { MAX_SERVICES } from '../core/team-services.ts'
import { isRecord, readJson, updateJson } from './json-store.ts'
import { stateDir } from './paths.ts'
import { audit } from './team-store.ts'

interface Stored extends OwnerService {
  hash: string
}

const file = () => join(stateDir(), 'owner-services.json')
const tokenShape = /^bos_[A-Za-z0-9_-]{43}$/
const hash = (token: string) => createHash('sha256').update(token).digest('base64url')
const stored = (value: unknown): value is Stored[] =>
  Array.isArray(value) &&
  value.every(
    s =>
      isRecord(s) &&
      typeof s.key === 'string' &&
      isOwnerServiceKey(s.key) &&
      validName(s.name) &&
      typeof s.hash === 'string',
  )

const read = () => readJson(file(), stored) ?? []
export const ownerServices = (): OwnerService[] => read().map(({ key, name }) => ({ key, name }))

export function authenticateOwnerService(token: string): OwnerService | null {
  if (!tokenShape.test(token)) return null
  const digest = hash(token)
  const service = read().find(s => s.hash === digest)
  return service ? { key: service.key, name: service.name } : null
}

export function ownerServiceNameError(services: readonly OwnerService[], name: string): string | null {
  if (services.some(s => s.name.toLowerCase() === name.toLowerCase())) return 'taken'
  return services.length >= MAX_SERVICES ? 'full' : null
}

export function addOwnerService(name: string) {
  mkdirSync(stateDir(), { recursive: true })
  const token = `bos_${randomBytes(32).toString('base64url')}`
  const service = { key: OWNER_SERVICE_PREFIX + randomUUID(), name }
  let error: string | null = null
  updateJson(
    file(),
    current => {
      const services = current ?? []
      error = ownerServiceNameError(services, name)
      return error ? undefined : [...services, { ...service, hash: hash(token) }]
    },
    stored,
    { mode: 0o600 },
  )
  if (error) return { ok: false as const, error }
  audit('owner-service', null, { op: 'add', ...service })
  return { ok: true as const, service, token }
}

export function revokeOwnerService(key: string): boolean {
  mkdirSync(stateDir(), { recursive: true })
  let removed: OwnerService | undefined
  updateJson(
    file(),
    current => {
      removed = current?.find(s => s.key === key)
      return removed ? current?.filter(s => s.key !== key) : undefined
    },
    stored,
    { mode: 0o600 },
  )
  if (!removed) return false
  audit('owner-service', null, { op: 'revoke', key, name: removed.name })
  return true
}
