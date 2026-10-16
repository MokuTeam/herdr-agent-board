// Going to the board and back. Opening it remembers where the user was (return.json); leaving
// the board (q, or the board key again) goes back there.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type HerdrSnapshot, herdr } from '../adapters/herdr.ts'
import { stateDir } from '../adapters/paths.ts'

const RETURN_FILE = join(stateDir(), 'return.json')

interface ReturnTarget {
  pane: string
  tab: string | undefined
  agent: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function asReturnTarget(value: unknown): ReturnTarget | null {
  if (!isRecord(value) || typeof value.pane !== 'string') return null
  return { pane: value.pane, tab: typeof value.tab === 'string' ? value.tab : undefined, agent: !!value.agent }
}

export function rememberReturn(snap: HerdrSnapshot, boardPane: string | null): void {
  const pane = snap.panes.find(p => p.pane_id === snap.focused_pane_id)
  if (!pane || pane.pane_id === boardPane) return
  try {
    writeFileSync(RETURN_FILE, JSON.stringify({ pane: pane.pane_id, tab: pane.tab_id, agent: !!pane.agent }))
  } catch {}
}

/** Focus the pane the user came from. False when there is nowhere to go back to. */
export async function goBack(): Promise<boolean> {
  let ret: ReturnTarget | null = null
  try {
    ret = asReturnTarget(JSON.parse(readFileSync(RETURN_FILE, 'utf8')))
  } catch {
    return false
  }
  if (!ret) return false
  if (ret.agent) {
    try {
      await herdr(['agent', 'focus', ret.pane])
      return true
    } catch {}
  }
  if (ret.tab === undefined) return false
  try {
    await herdr(['tab', 'focus', ret.tab])
    return true
  } catch {
    return false
  }
}
