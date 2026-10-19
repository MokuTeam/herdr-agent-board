// Renaming a session where its name is, without a page: where the field goes over the name, whether
// a rename does anything, and whether it can go to Claude and herdr too. The field itself is
// components/RenameField.tsx (the old page's rename.js).
import type { Item, Translator } from '../../../src/core/types.ts'
import { inTurn } from './card.ts'

export interface RenameBox {
  left: number
  top: number
  /** The box's: the field and the options under it. */
  width: number
  /** The field's: the name's own height and a little air. */
  fieldHeight: number
}

/**
 * The field sits on the name `r` (its rectangle): same place, same type, so nothing jumps. The
 * options under the field are wider than a short name: the box keeps both on screen.
 */
export function renameBox(
  r: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
): RenameBox {
  const width = Math.max(r.width + 24, 200)
  return {
    left: Math.max(8, Math.min(r.left - 5, viewportWidth - Math.max(width + 10, 290) - 8)),
    top: r.top - 3,
    width: width + 10,
    fieldHeight: r.height + 6,
  }
}

/** A rename does something when the name changed, or when it goes to Claude and herdr too. */
export const renameChanges = (name: string, value: string, claudeToo: boolean): boolean => name !== value || claudeToo

/**
 * The choice to rename it in Claude and herdr too: only for a Claude session in a pane (null
 * otherwise); gray with the reason while it sleeps, works, or herdr data is not fresh, since
 * /rename is typed into the session.
 */
export function claudeRename(it: Item, canMutate: boolean, t: Translator): { why: string } | null {
  const why = it.sleeping
    ? t('rename.why.asleep')
    : inTurn(it)
      ? t('rename.why.busy')
      : !canMutate
        ? t('mobile.readOnly')
        : ''
  return it.session && it.agent === 'claude' && it.pane ? { why } : null
}
