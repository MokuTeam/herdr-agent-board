// What `board doctor` and `board tunnel` find of the tunnel (core/tunnel.ts tunnelChecks reads it):
// the ssh binary, the key as ssh-keygen reads it, the settings' checks, the login set up, and what
// the running board says of the tunnel (GET /api/access, the local board's only).
import { accessReady } from '../adapters/access-store.ts'
import { type LocalFetch, localFetch } from '../adapters/local-key.ts'
import { keyPath, publicKeyOf, sshBin } from '../adapters/ssh.ts'
import { type AccessView, isAccessView } from '../core/access.ts'
import { boardPorts, type TunnelFacts, tunnelConfig, tunnelProblems } from '../core/tunnel.ts'
import type { Config } from '../core/types.ts'

/** How long the running board has to answer. */
const ANSWER_MS = 3000

/**
 * The running board's Remote access view (GET /api/access on 127.0.0.1); null when no board answers
 * with one. `fetchFn`: adapters/local-key.ts localFetch, the board's key on its own server.
 */
export async function boardAccessView(webPort: number, fetchFn: LocalFetch = fetch): Promise<AccessView | null> {
  try {
    const res = await fetchFn(`http://127.0.0.1:${webPort}/api/access`, { signal: AbortSignal.timeout(ANSWER_MS) })
    const view: unknown = await res.json()
    return isAccessView(view) ? view : null
  } catch {
    return null
  }
}

/**
 * The facts on this computer. A key path that fails its own check is never handed to ssh-keygen:
 * its problem is the key's error.
 */
export async function tunnelFacts(cfg: Config, webPort: number): Promise<TunnelFacts> {
  const conf = tunnelConfig(cfg.tunnel)
  const problems = tunnelProblems(conf, boardPorts(cfg.remote, webPort))
  const keyProblem = problems.find(p => p.field === 'key')
  const [key, view] = await Promise.all([
    keyProblem ? { ok: false as const, error: keyProblem.message, hint: null } : publicKeyOf(keyPath(conf)),
    boardAccessView(webPort, localFetch(cfg)),
  ])
  return {
    ssh: sshBin(),
    key: key.ok ? { ok: true } : key,
    problems,
    ready: accessReady(),
    status: view?.tunnel.status ?? null,
  }
}
