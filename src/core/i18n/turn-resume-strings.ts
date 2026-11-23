// Strings for Continue after restart (#633), merged into STRINGS in strings.ts.
import type { Lang } from '../types.ts'

export const TURN_RESUME_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'set.turnResume': 'Continue after restart',
    'set.turnResume.note': 'Send one continue message to Claude sessions that were mid-turn before a crash or reboot',
    'err.turnResume': 'Continue after restart must be on or off',
  },
  ru: {
    'set.turnResume': 'Продолжать после перезапуска',
    'set.turnResume.note': 'Отправить одно сообщение «продолжай» сессиям Claude, прерванным сбоем или перезагрузкой',
    'err.turnResume': 'Настройка «Продолжать после перезапуска» должна быть включена или выключена',
  },
}
