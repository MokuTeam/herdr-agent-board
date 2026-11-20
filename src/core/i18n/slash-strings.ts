// Texts of the chat box's slash command list (#191), merged into the board's dictionaries by
// strings.ts (same rules: {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const SLASH_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'slash.label': 'Commands',
    'slash.user': 'personal',
    'slash.project': 'this folder',
    'slash.keys': '↑↓ to pick · Tab to complete · Esc to close',
  },
  ru: {
    'slash.label': 'Команды',
    'slash.user': 'своя',
    'slash.project': 'из папки',
    'slash.keys': '↑↓ выбрать · Tab дописать · Esc закрыть',
  },
}
