// What the node's install writes on a server (core/node-plan.ts), each as a function of its values:
// the ceiling for everything the node's user runs (a drop-in for its systemd slice), herdr's user
// unit, sshd's fence for the link user and that user's key line, the lines added to the node user's
// profile, and the names and paths both users, the record and Undo go by. T0 set a server up by
// hand with exactly these (design: docs/design/nodes/README.md, 11.1). Pure, with no node: import.
import {
  BUN_INSTALLER,
  BUN_VERSION,
  CLAUDE_INSTALLER,
  HERDR_INSTALLER,
  HERDR_MIN,
  herdrUnit,
  PROFILE_BEGIN,
  PROFILE_END,
  profileBlock,
} from './node-install-consts.ts'
import { keysFile } from './tunnel-snippets.ts'

export {
  BUN_INSTALLER,
  BUN_VERSION,
  CLAUDE_INSTALLER,
  HERDR_INSTALLER,
  HERDR_MIN,
  PROFILE_BEGIN,
  PROFILE_END,
  profileBlock,
}

/** The login user who owns herdr, the board, the agents and the work. */
export const NODE_USER = 'agent-board'
/** Its comment: Apply uses, and Undo removes, only a user that has it. */
export const NODE_COMMENT = 'agent-board node'
export const NODE_HOME = `/home/${NODE_USER}`
/** The folder of the node's work: Undo leaves it unless the owner ticks it. */
export const WORK_DIR = `${NODE_HOME}/work`
/** The system user the master's link logs in as: no shell, no home, one forward to the door. */
export const LINK_USER = 'agent-board-link'
export const LINK_COMMENT = 'agent-board node link'
/** The install's own folder and its record, apart from the tunnel's /etc/agent-board and the backup's. */
export const NODE_ETC = '/etc/agent-board-node'
export const NODE_RECORD = `${NODE_ETC}/setup.json`
export const KEYS_DIR = '/etc/ssh/authorized_keys'
export const LINK_KEYS = keysFile(LINK_USER)
export const LINK_FENCE = '/etc/ssh/sshd_config.d/00-agent-board-node.conf'
/** The slice drop-in's file name, under /etc/systemd/system/user-<uid>.slice.d/. */
export const SLICE_FILE = '50-agent-board-node.conf'
export const slicePath = (uid: number | string): string => `/etc/systemd/system/user-${uid}.slice.d/${SLICE_FILE}`
/** In the node user's home. */
export const UNIT_PATH = `${NODE_HOME}/.config/systemd/user/herdr.service`
export const PLUGIN_DIR = `${NODE_HOME}/agent-board`
/** The archive's sha256 the plugin folder was unpacked from: a second Apply with the same archive skips. */
export const PLUGIN_STAMP = `${PLUGIN_DIR}/.archive-sha256`
/**
 * The master's commit the archive was made at (#509): a plugin unpacked from `git archive` has no
 * .git, so the node's status reads its commit from here (adapters/git.ts archiveStamp).
 */
export const ARCHIVE_COMMIT_FILE = '.archive-commit'
export const PLUGIN_COMMIT = `${PLUGIN_DIR}/${ARCHIVE_COMMIT_FILE}`
export const CONFIG_PATH = `${NODE_HOME}/.config/herdr/plugins/config/agent-board/config.json`
export const MASTERS_PATH = `${NODE_HOME}/.local/state/herdr/plugins/agent-board/node/masters.json`
export const PROFILE_PATH = `${NODE_HOME}/.profile`
export const BUN_BIN = `${NODE_HOME}/.bun/bin/bun`
export const HERDR_BIN = `${NODE_HOME}/.local/bin/herdr`
export const CLAUDE_BIN = `${NODE_HOME}/.local/bin/claude`

/** What the packages tick installs with apt. */
export const NODE_PACKAGES = ['git', 'curl', 'unzip', 'ca-certificates'] as const

/**
 * The systems whose own repositories have a gh this board can use (#609): 2.17 or later, for
 * `gh auth token`. Checked in their package lists on 2026-11-21: Debian 12 (2.23) and 13 (2.46),
 * Ubuntu 24.04 (2.45), 25.10 and 26.04 (2.46), universe. Ubuntu 22.04 has 2.4. No third-party repository.
 */
export const GH_PACKAGED: Readonly<Record<string, readonly string[]>> = {
  debian: ['12', '13'],
  ubuntu: ['24.04', '25.10', '26.04'],
}

/** Whether the system's own repositories have a gh this board can use. */
export const ghPackaged = (os: { id: string; version: string }): boolean =>
  GH_PACKAGED[os.id]?.includes(os.version) === true

/** The packages the plan installs behind its tick: gh with them where the system has it (#609). */
export const nodePackages = (os: { id: string; version: string }): string[] => [
  ...NODE_PACKAGES,
  ...(ghPackaged(os) ? ['gh'] : []),
]

const NOTE = 'Added by "Add a server"; its Undo removes it.'

/** The ceiling's figures, in MB, and the scheduler's share. */
export interface Ceiling {
  memoryMaxMb: number
  memoryHighMb: number
  swapMaxMb: number
  cpuWeight: number
  tasksMax: number
}

/**
 * The drop-in for the node user's slice: whatever that user runs (herdr, the board, every session
 * and its tests) shares one ceiling, so it cannot starve what else lives on the server. Past
 * MemoryHigh the kernel reclaims and slows the slice; MemoryMax is the hard limit.
 */
export function sliceDropIn(c: Ceiling): string {
  return [
    `# agent-board: the ceiling for everything the node's user runs. ${NOTE}`,
    '[Slice]',
    `MemoryHigh=${c.memoryHighMb}M`,
    `MemoryMax=${c.memoryMaxMb}M`,
    `MemorySwapMax=${c.swapMaxMb}M`,
    `CPUWeight=${c.cpuWeight}`,
    `TasksMax=${c.tasksMax}`,
    '',
  ].join('\n')
}

export { herdrUnit }

/**
 * sshd's settings for the link user: its key only, a local forward to the door and nothing else (no
 * remote or socket forward, no agent, X11, tunnel or terminal, no command).
 */
export function linkFenceSettings(port: number): (readonly [string, string])[] {
  return [
    ['AuthorizedKeysFile', LINK_KEYS],
    ['AuthenticationMethods', 'publickey'],
    ['AllowTcpForwarding', 'local'],
    ['PermitOpen', `127.0.0.1:${port}`],
    ['AllowStreamLocalForwarding', 'no'],
    ['X11Forwarding', 'no'],
    ['AllowAgentForwarding', 'no'],
    ['PermitTunnel', 'no'],
    ['PermitTTY', 'no'],
    ['ForceCommand', '/bin/false'],
  ]
}

/** The fence in its own drop-in: a comment line, the Match block, `Match all` so nothing after it is caught. */
export function linkFence(port: number): string {
  return [
    `# agent-board: sshd's fence for the node's link user. ${NOTE}`,
    `Match User ${LINK_USER}`,
    ...linkFenceSettings(port).map(([k, v]) => `    ${k} ${v}`),
    'Match all',
    '',
  ].join('\n')
}

/** The link key's line: forwards only, to the door only, even were sshd's fence gone. */
export const linkKeysLine = (publicKey: string, port: number): string =>
  `restrict,port-forwarding,permitopen="127.0.0.1:${port}" ${publicKey.trim()}`
