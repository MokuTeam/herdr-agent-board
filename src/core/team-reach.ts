// What `board team join` found on its way to the hub (#356), said in one line: the name's
// addresses, whether TCP reached each, whether TLS went through. The probe that gathers it is
// adapters/hub-reach.ts; this only words it and decides whether another try makes sense.

/** One step of the way: whether it went through, how long it took, and why not. */
export interface ReachStep {
  ok: boolean
  ms: number
  /** Why not: `timeout` (no answer within the step's time), else the system's code or message. */
  error?: string
}

export interface ReachAddress {
  address: string
  family: 4 | 6
}

export interface Reach {
  host: string
  port: number
  /** wss: TLS is part of the way. */
  secure: boolean
  /** The step's time limit, for "no answer in 4 s". */
  stepMs: number
  /** The host was an address already: no lookup. */
  literal: boolean
  dns: ReachStep & { addresses: ReachAddress[] }
  /** One address of each family at most, the first the lookup gave. */
  tcp: Array<ReachStep & ReachAddress>
  /** Over the first address TCP reached; null when it is ws, or nothing was reached. */
  tls: (ReachStep & { address: string }) | null
}

const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`
const at = (a: ReachAddress, port: number): string =>
  a.family === 6 ? `[${a.address}]:${port}` : `${a.address}:${port}`

function why(step: ReachStep, stepMs: number): string {
  if (step.error === 'timeout') return `no answer in ${seconds(stepMs)}`
  if (step.error === 'ECONNREFUSED') return 'refused'
  if (step.error === 'ENETUNREACH' || step.error === 'EHOSTUNREACH') return 'no route'
  return step.error || 'failed'
}

/** The way to the hub in one line: DNS · TCP · TLS, and a hint when only one family gets through. */
export function describeReach(r: Reach): string {
  const parts: string[] = []
  if (!r.literal)
    parts.push(
      r.dns.ok
        ? `DNS ${r.host} → ${r.dns.addresses.map(a => a.address).join(', ')} in ${r.dns.ms} ms`
        : `DNS ${r.host}: ${r.dns.error === 'timeout' ? `no answer in ${seconds(r.stepMs)}` : (r.dns.error ?? 'failed')}`,
    )
  if (r.tcp.length)
    parts.push(`TCP ${r.tcp.map(s => `${at(s, r.port)} ${s.ok ? `ok in ${s.ms} ms` : why(s, r.stepMs)}`).join(', ')}`)
  if (r.tls) parts.push(`TLS ${r.tls.ok ? `ok in ${r.tls.ms} ms` : why(r.tls, r.stepMs)}`)
  const v4 = r.tcp.find(s => s.family === 4)
  const v6 = r.tcp.find(s => s.family === 6)
  if (v4 && v6 && v4.ok !== v6.ok)
    parts.push(`IPv${v4.ok ? 6 : 4} does not get through from here, IPv${v4.ok ? 4 : 6} does`)
  return parts.join(' · ')
}

/** Whether the way is open up to the WebSocket: another try is worth it only then. */
export const reachable = (r: Reach): boolean => r.dns.ok && r.tcp.some(s => s.ok) && (!r.secure || r.tls?.ok === true)
