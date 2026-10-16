/** `class` from the names that apply: `classNames('card', compact && 'compact')`. */
export const classNames = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(' ')
