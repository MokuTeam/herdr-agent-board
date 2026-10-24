// Passkeys on the page through the owner's domain (WebAuthn in the browser): the board's options
// (src/services/access.ts; JSON, its bytes base64url) turned into what navigator.credentials takes,
// the credential it gives back turned into the JSON the board checks (src/core/webauthn.ts), and
// this browser's own note that it made one, which decides whether the login screen offers to add
// one (the board cannot tell devices apart). No node: import: this is the page's.

/** Bytes as base64url, without padding. */
export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  let text = ''
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url (padded or not) as bytes; throws on what is not base64url. */
export function fromB64url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes.buffer
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Credentials named by id ({ type, id }), their ids as bytes; null when the list is not one. */
function credentialList(list: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(list)) return null
  const out: Record<string, unknown>[] = []
  for (const credential of list) {
    if (!isObject(credential) || typeof credential.id !== 'string') return null
    out.push({ ...credential, id: fromB64url(credential.id) })
  }
  return out
}

// The options are the board's own (src/services/access.ts), WebAuthn's JSON with its bytes in
// base64url: what holds bytes is checked and made bytes here, the rest is passed on as the board
// wrote it, and navigator.credentials checks it.

/** The board's options to sign in (POST /api/login/passkey/options) for navigator.credentials.get; null for anything else. */
export function requestOptions(json: unknown): PublicKeyCredentialRequestOptions | null {
  if (!isObject(json) || typeof json.challenge !== 'string') return null
  try {
    const allow = json.allowCredentials === undefined ? undefined : credentialList(json.allowCredentials)
    if (allow === null) return null
    const options = { ...json, challenge: fromB64url(json.challenge), ...(allow && { allowCredentials: allow }) }
    return options as unknown as PublicKeyCredentialRequestOptions
  } catch {
    return null
  }
}

/** The board's options to add a passkey (POST /api/login/passkey/add/options) for navigator.credentials.create; null for anything else. */
export function creationOptions(json: unknown): PublicKeyCredentialCreationOptions | null {
  if (!isObject(json) || typeof json.challenge !== 'string') return null
  const { user } = json
  if (!isObject(user) || typeof user.id !== 'string') return null
  try {
    const exclude = json.excludeCredentials === undefined ? undefined : credentialList(json.excludeCredentials)
    if (exclude === null) return null
    const options = {
      ...json,
      challenge: fromB64url(json.challenge),
      user: { ...user, id: fromB64url(user.id) },
      ...(exclude && { excludeCredentials: exclude }),
    }
    return options as unknown as PublicKeyCredentialCreationOptions
  } catch {
    return null
  }
}

/** A sign-in (navigator.credentials.get) as the board reads it: POST /api/login/passkey. */
export function assertionJson(cred: PublicKeyCredential): Record<string, unknown> {
  const response = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      authenticatorData: toB64url(response.authenticatorData),
      signature: toB64url(response.signature),
      userHandle: response.userHandle ? toB64url(response.userHandle) : null,
    },
  }
}

/** A passkey made (navigator.credentials.create) as the board reads it: POST /api/login/passkey/add. */
export function attestationJson(cred: PublicKeyCredential): Record<string, unknown> {
  const response = cred.response as AuthenticatorAttestationResponse
  return {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      attestationObject: toB64url(response.attestationObject),
      // An older browser cannot say how the authenticator is reached.
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  }
}

/** This browser can make and use passkeys. */
export const passkeysHere = (): boolean =>
  typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function'

const MADE_KEY = 'agent-board:passkey-made'

/** This browser made a passkey for the board (Call 27): a password sign-in offers none then. */
export function passkeyMade(): boolean {
  try {
    return localStorage.getItem(MADE_KEY) === '1'
  } catch {
    return false
  }
}

export function markPasskeyMade(): void {
  try {
    localStorage.setItem(MADE_KEY, '1')
  } catch {}
}
