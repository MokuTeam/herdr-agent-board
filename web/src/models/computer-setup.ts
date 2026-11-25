// "Add a computer" on the page (#513, components/devices/AddComputer.tsx): types and helpers
// for GET/POST /api/nodes/computer/setup.
import { BOARD_PORTS, type ComputerSetupView, computerPortOf } from '../../../src/core/node-computer-setup.ts'
import { DEVICE_ID, LOCAL } from '../../../src/core/node-key.ts'
import type { Text } from '../../../src/core/server-plan.ts'
import type { Translator } from '../../../src/core/types.ts'

export type { ComputerSetupView } from '../../../src/core/node-computer-setup.ts'

export const COMPUTER_POLL_PHASES: readonly ComputerSetupView['phase'][] = ['waiting', 'claiming', 'finishing']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const isComputerSetupView = (v: unknown): v is ComputerSetupView =>
  isObject(v) && typeof v.phase === 'string' && Array.isArray(v.master)

export const computerStepTitle = (id: string, t: Translator): string =>
  id === 'claim' ? t('node.computer.step.claim') : t(`node.setup.step.${id}`)

/**
 * Validates optional device id and door port before asking the board to create a join command.
 * Returns null when valid, or a localized Text error.
 */
export function validateComputerStart(
  fields: { id: string; port: string },
  existingIds: readonly string[] = [],
): Text | null {
  const id = fields.id.trim()
  if (id) {
    if (!DEVICE_ID.test(id) || id === LOCAL) return { key: 'node.setup.refuse.id', params: { id } }
    if (existingIds.includes(id)) return { key: 'node.setup.refuse.idTaken', params: { id } }
  }
  const rawPort = fields.port.trim()
  if (rawPort) {
    if (!/^\d+$/.test(rawPort)) return { key: 'node.setup.err.port' }
    const num = Number(rawPort)
    if (BOARD_PORTS.includes(num)) return { key: 'node.computer.err.portReserved', params: { port: rawPort } }
    if (computerPortOf(num) === null) return { key: 'node.setup.err.port' }
  }
  return null
}
