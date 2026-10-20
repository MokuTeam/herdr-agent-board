// The fake ssh (fake-ssh.ts) as a real executable, for BOARD_SSH_BIN_PATH and
// BOARD_SSH_KEYGEN_BIN_PATH: one file serves as both ssh and ssh-keygen.
import { fileURLToPath } from 'node:url'
import { compileFake } from './fake-herdr-bin.ts'

const source = fileURLToPath(new URL('./fake-ssh.ts', import.meta.url))

export function fakeSshBin(): Promise<string> {
  return compileFake(source, 'fake-ssh')
}
