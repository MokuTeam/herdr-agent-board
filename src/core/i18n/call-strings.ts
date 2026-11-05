// The texts of a MokuPilot call agent's card (#326), in English and Russian; strings.ts merges them
// into the dictionaries.
import type { Lang } from '../types.ts'

export const CALL_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'call.of': 'Call · {name}',
    'call.alone': 'MokuPilot call',
    'call.on': 'On a call',
    'call.onHint': 'MokuPilot’s agent on the call since {time}',
    'call.after': ['After the call: {n} helper finishing', 'After the call: {n} helpers finishing'],
    'call.afterHint': 'The call is over. The agent waits for its helpers, hands their results over and ends',
    'call.ending': 'After the call: handing over',
    'call.doing': 'Doing',
    'call.next': 'Next',
    'call.done': '{n} done',
    'call.more': '+{n}',
    'call.steps': '{done}/{total}',
  },
  ru: {
    'call.of': 'Звонок · {name}',
    'call.alone': 'Звонок MokuPilot',
    'call.on': 'На звонке',
    'call.onHint': 'Агент MokuPilot на звонке с {time}',
    'call.after': [
      'После звонка: доделывает {n} помощник',
      'После звонка: доделывают {n} помощника',
      'После звонка: доделывают {n} помощников',
    ],
    'call.afterHint': 'Звонок кончился. Агент ждёт своих помощников, передаёт их результаты и завершится',
    'call.ending': 'После звонка: передаёт итоги',
    'call.doing': 'Делает',
    'call.next': 'Дальше',
    'call.done': 'готово: {n}',
    'call.more': '+{n}',
    'call.steps': '{done}/{total}',
  },
}
