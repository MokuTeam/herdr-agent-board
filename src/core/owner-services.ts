// The owner service's session key is reserved at the MCP door, even after revocation.
export const OWNER_SERVICE_HEADER = 'x-board-owner-service'
export const OWNER_SERVICE_PREFIX = 'owner-service-'
const KEY = /^owner-service-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export const isOwnerServiceKey = (key: string | undefined): key is `owner-service-${string}` =>
  typeof key === 'string' && KEY.test(key)

export interface OwnerService {
  key: string
  name: string
}

export const ownerServiceBy = (name: string): string => `service ${name}`
