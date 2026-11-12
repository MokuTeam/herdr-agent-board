// Texts of auto-compact (#378, core/compact.ts): Settings' default, a session's own limit on its
// sheet, the board's last /compact, and the compaction's line in the conversation. Merged into the
// board's dictionaries by strings.ts (same rules: {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const COMPACT_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // Settings (the gear): the default every session without a limit of its own compacts at
    'set.compact': 'Auto-compact',
    'set.compact.off': 'Off',
    'set.compact.tokens': 'At {tokens} tokens',
    'set.compact.share': 'At {share} of the window',
    'err.compactAt':
      '"{value}" is no limit: tokens (300k, 1.2m, at least 10k), a share of the window (5% to 95%) or never',
    'err.compactNote': 'The instructions are longer than {max} characters',
    // the sheet's card
    'compact.label': 'Compact at',
    'compact.keeps': 'Keep',
    'compact.last': 'Compacted',
    'compact.byDefault': 'Default: {limit} (300k, 60% or never)',
    'compact.offHint': 'Off: 300k, 60% or never',
    'compact.notePh': 'What the summary must keep (optional)',
    'compact.run.sent': '/compact typed {when} at {from}, waiting',
    'compact.run.failed': '/compact typed {when} at {from}, no compaction followed: paused',
    'compact.run.failedFree': '/compact typed {when} at {from}, no compaction followed',
    'compact.noWindow': 'Waits for the window size: the status line has not said it for this session yet',
    'compact.run.high': '{when}: {from} → {to}, still above {limit}: paused',
    'compact.run.done': '{when}: {from} → {to}',
    'compact.held': 'No other /compact until the context is below {limit} or the limit changes',
    // the conversation
    'compact.notice': 'Compacted',
    'compact.noticeBoard': 'Compacted by the board',
    'compact.noticeAuto': 'Compacted by Claude Code',
  },
  ru: {
    'set.compact': 'Автокомпакт',
    'set.compact.off': 'Выключен',
    'set.compact.tokens': 'На {tokens} токенов',
    'set.compact.share': 'На {share} окна',
    'err.compactAt': '«{value}» не порог: токены (300k, 1.2m, не меньше 10k), доля окна (от 5% до 95%) или never',
    'err.compactNote': 'Инструкции длиннее {max} символов',
    'compact.label': 'Сжать на',
    'compact.keeps': 'Сохранить',
    'compact.last': 'Сжато',
    'compact.byDefault': 'По умолчанию: {limit} (300k, 60% или never)',
    'compact.offHint': 'Выключено: 300k, 60% или never',
    'compact.notePh': 'Что должно остаться в сводке (необязательно)',
    'compact.run.sent': '/compact набран {when} на {from}, ждём',
    'compact.run.failed': '/compact набран {when} на {from}, сжатия не было: пауза',
    'compact.run.failedFree': '/compact набран {when} на {from}, сжатия не было',
    'compact.noWindow': 'Ждёт размер окна: статус-строка этой сессии его ещё не сообщила',
    'compact.run.high': '{when}: {from} → {to}, всё ещё выше {limit}: пауза',
    'compact.run.done': '{when}: {from} → {to}',
    'compact.held': 'Нового /compact не будет, пока контекст не станет меньше {limit} или не сменится порог',
    'compact.notice': 'Сжато',
    'compact.noticeBoard': 'Сжато доской',
    'compact.noticeAuto': 'Сжато Claude Code',
  },
}
