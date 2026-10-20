// How the web board folds a session asleep in "Waiting" (web/src/models/fold.ts), config.json's
// `foldWaiting`: the card unfolds making room, the cards below moving apart ('push', the default),
// it unfolds over them ('over'), or it is never folded ('off').
export const FOLD_MODES = ['push', 'over', 'off'] as const
export type FoldMode = (typeof FOLD_MODES)[number]

export const isFoldMode = (value: unknown): value is FoldMode => FOLD_MODES.some(m => m === value)

/** The mode config.json gives; none, or one not known, is the default. */
export const foldModeOf = (value: unknown): FoldMode => (isFoldMode(value) ? value : 'push')
