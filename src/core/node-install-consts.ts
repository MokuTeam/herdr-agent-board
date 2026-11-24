// Shared installer constants and user-unit/profile builders (#509, #513). Pure, no node: imports.

/** Bun's installer version pin; an existing Bun is kept when at least this version. */
export const BUN_VERSION = '1.4.3'
/** herdr's `--env` for a new tab came in 0.9.5. */
export const HERDR_MIN = '0.9.5'
export const BUN_INSTALLER = 'https://bun.sh/install'
export const HERDR_INSTALLER = 'https://herdr.dev/install.sh'
export const CLAUDE_INSTALLER = 'https://claude.ai/install.sh'

/** The markers of the board's lines in ~/.profile. */
export const PROFILE_BEGIN = '# >>> agent-board node'
export const PROFILE_END = '# <<< agent-board node'

/** herdr's user systemd unit for Linux nodes. */
export function herdrUnit(note = 'Added by "Add a server"; its Undo removes it.'): string {
  return [
    `# agent-board: herdr for the node's user. ${note}`,
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

/** PATH and Claude auto-updater opt-out lines in ~/.profile. */
export function profileBlock(): string {
  return [
    PROFILE_BEGIN,
    'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
    'export DISABLE_AUTOUPDATER=1',
    PROFILE_END,
    '',
  ].join('\n')
}
