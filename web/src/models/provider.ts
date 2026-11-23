// Provider identity for a session card (#651): maps an item's agent kind (claude, agy, codex, pi)
// to its monochrome mark id, display label, and tooltip ("Provider · Model", or just "Provider").
import type { Item, Translator } from '../../../src/core/types.ts'

export type ProviderId = 'claude' | 'agy' | 'codex' | 'pi'

export interface ProviderInfo {
  id: ProviderId
  labelKey: `prov.${ProviderId}`
}

const KNOWN: Record<string, ProviderInfo> = {
  claude: { id: 'claude', labelKey: 'prov.claude' },
  agy: { id: 'agy', labelKey: 'prov.agy' },
  antigravity: { id: 'agy', labelKey: 'prov.agy' },
  gemini: { id: 'agy', labelKey: 'prov.agy' },
  codex: { id: 'codex', labelKey: 'prov.codex' },
  openai: { id: 'codex', labelKey: 'prov.codex' },
  pi: { id: 'pi', labelKey: 'prov.pi' },
}

/** Recognised provider for an item, or null when the agent is absent or unknown. */
export function providerOf(item: Pick<Item, 'agent'>): ProviderInfo | null {
  const raw = typeof item.agent === 'string' ? item.agent.trim().toLowerCase() : ''
  return raw ? (KNOWN[raw] ?? null) : null
}

/** Tooltip text for a card's provider mark: "Provider · model" when model is known, else "Provider". */
export function providerTooltip(info: ProviderInfo, model: string | null | undefined, t: Translator): string {
  const name = t(info.labelKey)
  const cleanModel = typeof model === 'string' ? model.trim() : ''
  return cleanModel ? `${name} · ${cleanModel}` : name
}
