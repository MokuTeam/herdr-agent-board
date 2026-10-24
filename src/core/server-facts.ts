// What Look found on a server. Types only, no node: import: core/server-look.ts parses into these, core/server-plan.ts plans from them.
export type Port = 80 | 443 | 8443 | 8480 | 8481
export type Holder =
  | { kind: 'free' }
  | { kind: 'unit'; unit: string; program: string }
  | { kind: 'container'; id: string; program: string }
  | { kind: 'process'; program: string }
  | { kind: 'split'; programs: string[] }
export interface Distro {
  id: string
  version: string
  codename: string
  arch: string
  supported: boolean
}
export interface Network {
  name: string
  driver: string
  userDefined: boolean
}
export interface Mount {
  type: 'bind' | 'volume'
  source: string
  destination: string
}
export interface Container {
  id: string
  name: string
  image: string
  cmd: string[]
  hostNetwork: boolean
  networks: Network[]
  mounts: Mount[]
  ports: { private: number; public: number; ip: string }[]
  labels: Record<string, string>
}
export interface Unit {
  execStart: string[]
  execReload: string[]
  user: string
  group: string
  active: string
  workingDirectory: string
}
export interface DockerFacts {
  version: string
  podman: boolean
  rootless: boolean
  userns: boolean
  containers: Container[]
}
export interface HostFacts {
  selinux: 'enforcing' | 'permissive' | 'disabled' | null
  forwarding: boolean
  forwarders: string[]
  fetch: 'curl' | 'wget' | null
  missing: string[]
  sudo: 'sudo' | 'sudo-rs' | null
  coreutils: 'gnu' | 'rust' | null
  conflicts: string[]
}
/**
 * Step 1's parts as Look found them, besides the fence (`fence`, sshd's settings for the tunnel
 * user) and the socket's folder (`folder`): what tells the plan which of them the board makes.
 */
export interface StepOneFacts {
  /**
   * The tunnel user: its uid, its group's name, its shell, whether the board made it (its comment,
   * core/server-texts.ts USER_COMMENT) and whether it is the login Look ran as (or sudo ran it
   * for); null when there is none.
   */
  user: { uid: number; group: string; shell: string; ours: boolean; admin: boolean } | null
  /** No tunnel user, but a group of its name left (by a userdel, say): useradd cannot make it then. */
  groupLeft?: true
  /** Its keys file: none, the board's key line alone, or anything else (also when Look had no key to compare with). */
  keys: 'none' | 'same' | 'other'
  /** /etc/ssh/authorized_keys is there. */
  keysDir: boolean
  /** sshd_config includes sshd_config.d/*.conf before any Match line, and that folder is there. */
  include: boolean
}
export interface RoundOne {
  distro: Distro
  ports: Record<Port, Holder>
  docker: DockerFacts | null
  systemd: boolean
  units: { caddy: Unit | null; nginx: Unit | null }
  fence: Record<string, string>
  folder: { mode: string; owner: string; group: string; gid: number; members: string[] } | null
  socket: { mode: string; owner: string; group: string } | null
  /** Absent from a Look that did not read them (its output has no `@@user` line): step 1 taken as done by hand. */
  stepOne?: StepOneFacts
  record: unknown
  lockHeld: boolean
  host: HostFacts
  dns: { domain: string[]; local: string[] }
}
export interface CaddyFacts {
  where: 'unit' | 'container'
  container: string | null
  config: string
  hostPath: string | null
  mount: 'file' | 'folder' | 'volume' | null
  adapter: string
  resume: boolean
  version: string
  hosts: string[]
  adminOff: boolean
  autoHttpsOff: boolean
  sha256: string
  endsWithNewline: boolean
  address: string
}
export interface NginxFacts {
  confD: boolean
  listen80: string[]
  serverNames: string[]
}
export interface ServerFacts extends RoundOne {
  caddy: CaddyFacts | null
  nginx: NginxFacts | null
}
