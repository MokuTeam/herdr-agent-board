// View types and guard for Settings, Devices -> Move master role (#697).
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface HandoverCheckItem {
  id: string
  ok: boolean
  detail: string
  blocking: boolean
}

export interface HandoverSummaryItem {
  category: string
  files: number
  bytes: number
}

export interface HandoverPlan {
  ok: boolean
  from: string
  to: string
  targetTitle: string
  commit: string
  nodePort?: number
  checks: HandoverCheckItem[]
  items: HandoverSummaryItem[]
  totalFiles: number
  totalBytes: number
  requiredFreeMb: number
  targetFreeMb: number | null
  relaySetup?: {
    host: string
    sshPort: number
    user: string
    needsSudoPassword: boolean
  }
  errors: string[]
  warnings: string[]
}

export interface HandoverVerifyCheck {
  name: string
  ok: boolean
  skipped?: boolean
  detail: string
}

export interface HandoverVerifyResult {
  ok: boolean
  checks: HandoverVerifyCheck[]
}

export interface HandoverView {
  phase: 'idle' | 'checking' | 'checked' | 'running' | 'done' | 'failed' | 'rolled-back'
  step: string | null
  id: string | null
  target: string | null
  plan: HandoverPlan | null
  verify: HandoverVerifyResult | null
  error: string | null
  rolledBack: boolean
  canRollback: boolean
  rollbackNeedsConfirm?: boolean
  rollbackReason?: string
  need?: 'sudoPassword'
}

const PHASES = new Set(['idle', 'checking', 'checked', 'running', 'done', 'failed', 'rolled-back'])

export function isHandoverView(v: unknown): v is HandoverView {
  return (
    isObj(v) &&
    typeof v.phase === 'string' &&
    PHASES.has(v.phase) &&
    typeof v.rolledBack === 'boolean' &&
    typeof v.canRollback === 'boolean'
  )
}
