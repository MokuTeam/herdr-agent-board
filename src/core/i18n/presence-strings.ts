// The texts of the user's presence (#172): the toolbar's switch and its offer, Settings → Presence,
// the refusals and `board presence`, in English and Russian; strings.ts merges them into the
// dictionaries.
import type { Lang } from '../types.ts'

export const PRESENCE_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'presence.here': 'At the computer',
    'presence.away': 'Away',
    'presence.call': 'On a call',
    'presence.hereHint': 'Agents keep to the board and the terminal. Press when you leave the computer',
    'presence.awayHint': 'Agents also send what you need to see to Telegram. Press when you are back',
    'presence.callHint':
      'Agents know you answer late, notifications go quietly to the notification center. Press when the call is over',
    'presence.setCall': 'On a call: agents know you answer late, notifications stay quiet',
    'presence.suggestAway': 'Looks like you are away: switch?',
    'presence.suggestHere': 'Looks like you are back: switch?',
    'set.presence': 'Presence',
    'set.presence.none': 'Off',
    'set.presence.auto': 'Notice it by itself',
    'set.presence.suggest': 'Only offer to switch',
    'set.presence.off': 'Switch by hand only',
    'set.presence.idle': 'Away after {min} minutes without input',
    'err.presenceState': 'Presence is here, away or call',
    'err.presenceOff': 'Presence is off (Settings → Presence)',
    'err.presenceSetting': 'Presence: on or off, and a mode of auto, suggest or off',
    'err.presenceMinutes': 'Presence: a whole number of minutes, 1 to {max}',
  },
  ru: {
    'presence.here': 'За компьютером',
    'presence.away': 'Отошёл',
    'presence.call': 'На звонке',
    'presence.hereHint': 'Агенты пишут только в доску и терминал. Нажмите, когда отойдёте',
    'presence.awayHint': 'Агенты дублируют важное в Telegram. Нажмите, когда вернётесь',
    'presence.callHint':
      'Агенты знают, что вы ответите не сразу, уведомления тихо копятся. Нажмите, когда звонок кончится',
    'presence.setCall': 'На звонке: агенты знают, что вы ответите не сразу, уведомления не всплывают',
    'presence.suggestAway': 'Похоже, вы отошли: переключить?',
    'presence.suggestHere': 'Похоже, вы вернулись: переключить?',
    'set.presence': 'Присутствие',
    'set.presence.none': 'Выключено',
    'set.presence.auto': 'Замечать самой',
    'set.presence.suggest': 'Только предлагать',
    'set.presence.off': 'Только вручную',
    'set.presence.idle': 'Отошёл после {min} минут без ввода',
    'err.presenceState': 'Присутствие: here, away или call',
    'err.presenceOff': 'Присутствие выключено (Настройки → Присутствие)',
    'err.presenceSetting': 'Присутствие: вкл или выкл, режим auto, suggest или off',
    'err.presenceMinutes': 'Присутствие: целое число минут, от 1 до {max}',
  },
}
