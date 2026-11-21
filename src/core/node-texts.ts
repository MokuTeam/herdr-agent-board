// What the node's install writes on a server (core/node-plan.ts), each as a function of its values:
// the ceiling for everything the node's user runs (a drop-in for its systemd slice), herdr's user
// unit, sshd's fence for the link user and that user's key line, the lines added to the node user's
// profile, and the names and paths both users, the record and Undo go by. T0 set a server up by
// hand with exactly these (design: docs/design/nodes/README.md, 11.1). Pure, with no node: import.
import { keysFile } from './tunnel-snippets.ts'

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
export const CONFIG_PATH = `${NODE_HOME}/.config/herdr/plugins/config/agent-board/config.json`
export const MASTERS_PATH = `${NODE_HOME}/.local/state/herdr/plugins/agent-board/node/masters.json`
export const PROFILE_PATH = `${NODE_HOME}/.profile`
export const BUN_BIN = `${NODE_HOME}/.bun/bin/bun`
export const HERDR_BIN = `${NODE_HOME}/.local/bin/herdr`
export const CLAUDE_BIN = `${NODE_HOME}/.local/bin/claude`

/** Bun's installer is given this version; a Bun already on the server is copied when it is at least this. */
export const BUN_VERSION = '1.4.3'
/** herdr's `--env` for a new tab came in 0.9.5. */
export const HERDR_MIN = '0.9.5'
export const BUN_INSTALLER = 'https://bun.sh/install'
export const HERDR_INSTALLER = 'https://herdr.dev/install.sh'
export const CLAUDE_INSTALLER = 'https://claude.ai/install.sh'
/** What the packages tick installs with apt. */
export const NODE_PACKAGES = ['git', 'curl', 'unzip', 'ca-certificates'] as const

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

/**
 * herdr's user unit. Nothing else is needed for the board: with the plugin linked, herdr's startup
 * opens the Board workspace, whose process serves the web board and the door, and the Wake
 * workspace (T0). Claude Code changes on a node only when the owner means it: no self-update.
 */
export function herdrUnit(): string {
  return [
    `# agent-board: herdr for the node's user. ${NOTE}`,
    '[Unit]',
    'Description=herdr server for agent-board',
    '',
    '[Service]',
    'ExecStart=%h/.local/bin/herdr server',
    'Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin',
    'Environment=TERM=xterm-256color',
    'Environment=DISABLE_AUTOUPDATER=1',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** The markers of the board's lines in the node user's ~/.profile. */
export const PROFILE_BEGIN = '# >>> agent-board node'
export const PROFILE_END = '# <<< agent-board node'

/** The node user's own shell finds the tools, and Claude Code does not update itself there either. */
export function profileBlock(): string {
  return [
    PROFILE_BEGIN,
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
    'export DISABLE_AUTOUPDATER=1',
    PROFILE_END,
    '',
  ].join('\n')
}

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
