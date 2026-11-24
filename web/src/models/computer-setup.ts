// "Add a computer" on the page (#513, components/devices/AddComputer.tsx): types and helpers
// for GET/POST /api/nodes/computer/setup.
import type { ComputerSetupView } from '../../../src/core/node-computer-setup.ts'
import type { Translator } from '../../../src/core/types.ts'

export type { ComputerSetupView } from '../../../src/core/node-computer-setup.ts'

export const COMPUTER_POLL_PHASES: readonly ComputerSetupView['phase'][] = ['waiting', 'claiming', 'finishing']

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export const isComputerSetupView = (v: unknown): v is ComputerSetupView =>
  isObject(v) && typeof v.phase === 'string' && Array.isArray(v.master)

export const computerStepTitle = (id: string, t: Translator): string =>
  id === 'claim' ? t('node.computer.step.claim') : t(`node.setup.step.${id}`)
