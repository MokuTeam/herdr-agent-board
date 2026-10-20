// Turning the board in a phone's browser on and off (core/pwa.ts): `tailscale serve` for the
// computer's HTTPS name, and config.json, alike from `board remote pwa` and the Phones panel.
// Serve keeps what it is given across restarts, so the board sets it only when asked, never on
// its own, and takes back only what forwards to it.
import { setPwaOn, setRemoteOn } from '../adapters/config-file.ts'
import { serveOff, serveOn, serveStatus, tailscaleStatus } from '../adapters/tailscale.ts'
import { ADMIN_DNS, type PhoneFacts, pwaPort, pwaTarget, pwaUrl, serveUse } from '../core/pwa.ts'
import { remoteConfig } from '../core/remote.ts'
import type { Config } from '../core/types.ts'

export type PwaResult = { ok: true; url: string } | { ok: false; error: string }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** This computer's Tailscale name, once Tailscale runs here; an error to show when it does not. */
async function selfName(): Promise<{ dnsName: string; certs: boolean } | { error: string }> {
  let status: Awaited<ReturnType<typeof tailscaleStatus>>
  try {
    status = await tailscaleStatus()
  } catch (err) {
    return { error: `Tailscale is not available: ${messageOf(err)}` }
  }
  const dnsName = status.self?.dnsName ?? ''
  if (!status.running || !dnsName) return { error: 'Tailscale is not connected on this computer' }
  return { dnsName, certs: status.certDomains.includes(dnsName) }
}

/**
 * Serve forwards the HTTPS name to the board, and config.json turns it on (the remote mode too).
 * Refused while the tailnet gives no HTTPS certificates, or when serve's port is someone else's.
 */
export async function pwaOn(cfg: Config, webPort: number): Promise<PwaResult> {
  const conf = remoteConfig(cfg.remote)
  const self = await selfName()
  if ('error' in self) return { ok: false, error: self.error }
  if (!self.certs)
    return {
      ok: false,
      error: `HTTPS certificates are off for this tailnet: turn on HTTPS Certificates on the DNS page of the Tailscale admin console (${ADMIN_DNS}), then try again`,
    }
  const https = conf.pwa.https
  if (https === (conf.port ?? webPort))
    return { ok: false, error: `remote.pwa.https (${https}) is the remote listener's port: give it another one` }
  const target = pwaTarget(pwaPort(conf.pwa, webPort))
  try {
    const use = serveUse((await serveStatus()).get(https), target)
    if (use === 'other')
      return {
        ok: false,
        error: `port ${https} of ${self.dnsName} already serves something else (tailscale serve status): set remote.pwa.https to another port, such as 8443`,
      }
    if (use === 'free') await serveOn(https, target)
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
  const saved = setPwaOn(true)
  return saved.ok ? { ok: true, url: pwaUrl(self.dnsName, https) } : saved
}

/** Serve stops forwarding the HTTPS name to the board, if it does, and config.json turns it off. */
export async function pwaOff(cfg: Config, webPort: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const conf = remoteConfig(cfg.remote)
  const saved = setPwaOn(false)
  if (!saved.ok) return saved
  try {
    const use = serveUse((await serveStatus()).get(conf.pwa.https), pwaTarget(pwaPort(conf.pwa, webPort)))
    if (use === 'ours') await serveOff(conf.pwa.https)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `off in config.json, but tailscale serve: ${messageOf(err)}` }
  }
}

/** The remote mode off: nothing listens, and serve no longer forwards the HTTPS name here. */
export async function remoteOff(cfg: Config, webPort: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const off = remoteConfig(cfg.remote).pwa.on ? await pwaOff(cfg, webPort) : ({ ok: true } as const)
  const saved = setRemoteOn(false)
  return saved.ok ? off : saved
}

/** What `board doctor` says of the remote mode (core/pwa.ts phoneChecks). */
export async function phoneFacts(cfg: Config, webPort: number): Promise<PhoneFacts> {
  const conf = remoteConfig(cfg.remote).pwa
  const self = await selfName()
  if ('error' in self) return { tailscale: { ok: false, why: self.error }, certs: false, conf, serve: null, url: null }
  let serve: PhoneFacts['serve'] = null
  if (conf.on)
    serve = await serveStatus().then(
      ports => serveUse(ports.get(conf.https), pwaTarget(pwaPort(conf, webPort))),
      () => null,
    )
  return {
    tailscale: { ok: true, dnsName: self.dnsName },
    certs: self.certs,
    conf,
    serve,
    url: pwaUrl(self.dnsName, conf.https),
  }
}
