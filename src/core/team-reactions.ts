// Reactions on Team messages (#687): pure emoji validation, Slack shortcodes, quick reactions,
// and searchable emoji list (English and Russian keywords). Zero node: imports so both backend
// and web UI share one source of truth.

export const MAX_EMOJI_LEN = 32
export const MAX_REACTIONS_PER_MSG = 50
export const QUICK_REACTIONS = ['👍', '👀', '✅', '❤️', '🔥', '🎉'] as const

export type EmojiGroup = 'common' | 'faces' | 'gestures' | 'work' | 'symbols'

export interface EmojiEntry {
  emoji: string
  short: string
  keywords: string
  group: EmojiGroup
}

export const EMOJI_LIST: readonly EmojiEntry[] = [
  // Common
  { emoji: '👍', short: 'thumbsup', keywords: 'like yes approve ok plus +1 лайк да ок хорошо', group: 'common' },
  { emoji: '👎', short: 'thumbsdown', keywords: 'dislike no -1 дизлайк нет плохо', group: 'common' },
  { emoji: '👀', short: 'eyes', keywords: 'look see watching seen глаза смотрю вижу гляну', group: 'common' },
  {
    emoji: '✅',
    short: 'white_check_mark',
    keywords: 'check done yes complete готово ок сделано галочка',
    group: 'common',
  },
  { emoji: '❤️', short: 'heart', keywords: 'love like red сердце любовь нравится', group: 'common' },
  { emoji: '🔥', short: 'fire', keywords: 'hot lit flame огонь круто супер', group: 'common' },
  { emoji: '🎉', short: 'tada', keywords: 'party celebrate congrats ура праздник поздравляю', group: 'common' },
  { emoji: '🚀', short: 'rocket', keywords: 'launch ship deploy fast ракета запуск релиз деплой', group: 'common' },
  { emoji: '👏', short: 'clap', keywords: 'applause bravo congrats аплодисменты браво', group: 'common' },
  { emoji: '💯', short: '100', keywords: 'hundred perfect exact сотка точно идеально', group: 'common' },
  { emoji: '🙏', short: 'pray', keywords: 'thanks please hope спасибо пожалуйста прошу', group: 'common' },
  { emoji: '😂', short: 'joy', keywords: 'laugh haha funny lol смех хаха смешно', group: 'common' },

  // Faces
  { emoji: '😄', short: 'smile', keywords: 'happy grin улыбка радость', group: 'faces' },
  { emoji: '😊', short: 'blush', keywords: 'happy warm smile смущение улыбка тепло', group: 'faces' },
  { emoji: '🙂', short: 'slightly_smiling_face', keywords: 'smile ok fine улыбка ок', group: 'faces' },
  { emoji: '😉', short: 'wink', keywords: 'flirt joke подмигиваю шутка', group: 'faces' },
  { emoji: '😍', short: 'heart_eyes', keywords: 'love awesome обожаю восторг', group: 'faces' },
  { emoji: '🤩', short: 'star_struck', keywords: 'wow amazing звезды восторг вау', group: 'faces' },
  { emoji: '🥳', short: 'partying_face', keywords: 'party celebrate праздник вечеринка', group: 'faces' },
  { emoji: '😎', short: 'sunglasses', keywords: 'cool chill крутой очки', group: 'faces' },
  { emoji: '🤔', short: 'thinking', keywords: 'hmm think wonder думаю вопрос размышляю', group: 'faces' },
  { emoji: '🤨', short: 'raised_eyebrow', keywords: 'skeptic doubt hmm сомнение бровь', group: 'faces' },
  { emoji: '😐', short: 'neutral_face', keywords: 'meh blank ровно нейтрально', group: 'faces' },
  { emoji: '🙄', short: 'roll_eyes', keywords: 'eyeroll whatever закатил глаза', group: 'faces' },
  { emoji: '😬', short: 'grimacing', keywords: 'awkward oops ой неловко', group: 'faces' },
  { emoji: '😅', short: 'sweat_smile', keywords: 'phew close nervous уф пронесло', group: 'faces' },
  { emoji: '🥲', short: 'smiling_face_with_tear', keywords: 'touched bittersweet слеза улыбка', group: 'faces' },
  { emoji: '😢', short: 'cry', keywords: 'sad tear грустно слеза плач', group: 'faces' },
  { emoji: '😭', short: 'sob', keywords: 'cry sad loud рыдаю грустно', group: 'faces' },
  { emoji: '😱', short: 'scream', keywords: 'shock omg ужас шок', group: 'faces' },
  { emoji: '🤯', short: 'exploding_head', keywords: 'mindblown shock взрыв мозга шок', group: 'faces' },
  { emoji: '😳', short: 'flushed', keywords: 'surprised oops смущен удивлен', group: 'faces' },
  { emoji: '😴', short: 'sleeping', keywords: 'sleep tired zzz сплю устал', group: 'faces' },
  { emoji: '🫡', short: 'saluting_face', keywords: 'salute aye sir on it есть понял выполняю', group: 'faces' },
  { emoji: '🫠', short: 'melting_face', keywords: 'melt heat awkward таю', group: 'faces' },
  { emoji: '🤝', short: 'handshake', keywords: 'deal agree partner договорились сделка', group: 'faces' },

  // Gestures
  { emoji: '👋', short: 'wave', keywords: 'hi hello bye привет пока машу', group: 'gestures' },
  { emoji: '👌', short: 'ok_hand', keywords: 'ok fine perfect ок хорошо супер', group: 'gestures' },
  { emoji: '✌️', short: 'v', keywords: 'peace victory два мир победа', group: 'gestures' },
  { emoji: '🤞', short: 'crossed_fingers', keywords: 'luck hope скрестил пальцы удача', group: 'gestures' },
  { emoji: '🙌', short: 'raised_hands', keywords: 'hooray celebrate руки вверх ура', group: 'gestures' },
  { emoji: '💪', short: 'muscle', keywords: 'strong power flex сила мощь', group: 'gestures' },
  { emoji: '🫶', short: 'heart_hands', keywords: 'love support сердечко руками', group: 'gestures' },
  { emoji: '☝️', short: 'point_up', keywords: 'note attention важно внимание', group: 'gestures' },
  { emoji: '👇', short: 'point_down', keywords: 'below down вниз ниже', group: 'gestures' },
  { emoji: '👉', short: 'point_right', keywords: 'next right направо далее', group: 'gestures' },
  { emoji: '👈', short: 'point_left', keywords: 'back left налево назад', group: 'gestures' },
  { emoji: '✋', short: 'raised_hand', keywords: 'stop wait hand стоп подожди рука', group: 'gestures' },
  { emoji: '🤦', short: 'facepalm', keywords: 'doh facepalm фейспалм', group: 'gestures' },
  { emoji: '🤷', short: 'shrug', keywords: 'dunno idk не знаю пожимаю плечами', group: 'gestures' },

  // Work & Dev
  { emoji: '⚡', short: 'zap', keywords: 'fast lightning power молния быстро', group: 'work' },
  { emoji: '✨', short: 'sparkles', keywords: 'clean magic new блеск чисто красиво', group: 'work' },
  { emoji: '💡', short: 'bulb', keywords: 'idea tip light идея лампочка мысль', group: 'work' },
  { emoji: '🐛', short: 'bug', keywords: 'issue error defect баг ошибка', group: 'work' },
  { emoji: '🔧', short: 'wrench', keywords: 'fix tool config фикс настройка ключ', group: 'work' },
  { emoji: '🔨', short: 'hammer', keywords: 'build fix молоток сборка', group: 'work' },
  { emoji: '⚙️', short: 'gear', keywords: 'settings config шестеренка настройки', group: 'work' },
  { emoji: '🧪', short: 'test_tube', keywords: 'test experiment тест эксперимент', group: 'work' },
  { emoji: '📝', short: 'memo', keywords: 'note write doc заметка документ', group: 'work' },
  { emoji: '📌', short: 'pushpin', keywords: 'pin save пин закрепить', group: 'work' },
  { emoji: '📍', short: 'round_pushpin', keywords: 'pin location метка', group: 'work' },
  { emoji: '🔗', short: 'link', keywords: 'url chain ссылка цепь', group: 'work' },
  { emoji: '📎', short: 'paperclip', keywords: 'attach file скрепка файл', group: 'work' },
  { emoji: '📁', short: 'file_folder', keywords: 'folder dir папка', group: 'work' },
  { emoji: '🔒', short: 'lock', keywords: 'secure private locked замок закрыто', group: 'work' },
  { emoji: '🔓', short: 'unlock', keywords: 'open unlocked открыто', group: 'work' },
  { emoji: '🔑', short: 'key', keywords: 'auth secret access ключ доступ', group: 'work' },
  { emoji: '⏳', short: 'hourglass', keywords: 'wait loading time жду песочные часы', group: 'work' },
  { emoji: '⏰', short: 'alarm_clock', keywords: 'deadline time reminder будильник время', group: 'work' },
  { emoji: '📅', short: 'date', keywords: 'calendar schedule дата календарь', group: 'work' },
  { emoji: '📊', short: 'bar_chart', keywords: 'stats metrics data график метрики', group: 'work' },
  { emoji: '📈', short: 'chart_with_upwards_trend', keywords: 'up growth рост вверх', group: 'work' },
  { emoji: '📉', short: 'chart_with_downwards_trend', keywords: 'down drop падение вниз', group: 'work' },
  { emoji: '🚢', short: 'ship', keywords: 'deploy release ship корабль релиз', group: 'work' },
  { emoji: '📦', short: 'package', keywords: 'box bundle release пакет коробка', group: 'work' },
  { emoji: '🧹', short: 'broom', keywords: 'cleanup tidy уборка чистка', group: 'work' },
  { emoji: '🛡️', short: 'shield', keywords: 'security protect щит защита', group: 'work' },
  { emoji: '🔍', short: 'mag', keywords: 'search find lookup поиск лупа', group: 'work' },
  { emoji: '💬', short: 'speech_balloon', keywords: 'chat comment message чат сообщение', group: 'work' },
  { emoji: '📣', short: 'mega', keywords: 'announce loud рупор анонс', group: 'work' },
  { emoji: '☕', short: 'coffee', keywords: 'break morning кофе перерыв', group: 'work' },

  // Symbols
  { emoji: '⚠️', short: 'warning', keywords: 'warn alert caution внимание предупреждение', group: 'symbols' },
  { emoji: '❌', short: 'x', keywords: 'no wrong cancel cross нет ошибка отмена крест', group: 'symbols' },
  { emoji: '⭕', short: 'o', keywords: 'circle ok круг', group: 'symbols' },
  { emoji: '❓', short: 'question', keywords: 'what ask why вопрос', group: 'symbols' },
  { emoji: '❗', short: 'exclamation', keywords: 'important alert восклицательный важно', group: 'symbols' },
  { emoji: '➕', short: 'heavy_plus_sign', keywords: 'plus add плюс добавить', group: 'symbols' },
  { emoji: '➖', short: 'heavy_minus_sign', keywords: 'minus remove минус убрать', group: 'symbols' },
  { emoji: '⭐', short: 'star', keywords: 'favorite best звезда избранное', group: 'symbols' },
  { emoji: '🌟', short: 'star2', keywords: 'shine great звезда супер', group: 'symbols' },
  { emoji: '🎯', short: 'dart', keywords: 'goal target hit цель точно', group: 'symbols' },
  { emoji: '🏆', short: 'trophy', keywords: 'win award кубок победа', group: 'symbols' },
  { emoji: '🥇', short: '1st_place_medal', keywords: 'gold first золото первый', group: 'symbols' },
  { emoji: '🟢', short: 'green_circle', keywords: 'green go online зеленый', group: 'symbols' },
  { emoji: '🟡', short: 'yellow_circle', keywords: 'yellow wait желтый', group: 'symbols' },
  { emoji: '🔴', short: 'red_circle', keywords: 'red stop error красный', group: 'symbols' },
  { emoji: '🔵', short: 'blue_circle', keywords: 'blue info синий', group: 'symbols' },
  { emoji: '🟣', short: 'purple_circle', keywords: 'purple фиолетовый', group: 'symbols' },
  { emoji: '💚', short: 'green_heart', keywords: 'heart green зеленое сердце', group: 'symbols' },
  { emoji: '💙', short: 'blue_heart', keywords: 'heart blue синее сердце', group: 'symbols' },
  { emoji: '💜', short: 'purple_heart', keywords: 'heart purple фиолетовое сердце', group: 'symbols' },
  { emoji: '🧡', short: 'orange_heart', keywords: 'heart orange оранжевое сердце', group: 'symbols' },
  { emoji: '💛', short: 'yellow_heart', keywords: 'heart yellow желтое сердце', group: 'symbols' },
  { emoji: '🤍', short: 'white_heart', keywords: 'heart white белое сердце', group: 'symbols' },
  { emoji: '☑️', short: 'ballot_box_with_check', keywords: 'check done галочка', group: 'symbols' },
  { emoji: '🔁', short: 'repeat', keywords: 'retry loop повтор', group: 'symbols' },
  { emoji: '🛑', short: 'octagonal_sign', keywords: 'stop halt стоп', group: 'symbols' },
  { emoji: '🚧', short: 'construction', keywords: 'wip work in progress стройка в работе', group: 'symbols' },
  { emoji: '🔔', short: 'bell', keywords: 'notify alert звонок уведомление', group: 'symbols' },
  { emoji: '💤', short: 'zzz', keywords: 'sleep idle сон пауза', group: 'symbols' },
] as const

const SHORTCODE_ALIASES: Record<string, string> = {
  '+1': '👍',
  '-1': '👎',
  check: '✅',
  checkmark: '✅',
  ok: '👌',
  thanks: '🙏',
  thank_you: '🙏',
  laugh: '😂',
  lol: '😂',
  party: '🎉',
  congrats: '🎉',
  salute: '🫡',
  think: '🤔',
  pin: '📌',
  warn: '⚠️',
  stop: '🛑',
  shipit: '🚢',
  lgtm: '👍',
}

export const SHORTCODE_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ...EMOJI_LIST.map(e => [e.short, e.emoji] as const),
  ...Object.entries(SHORTCODE_ALIASES),
])

const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const KEYCAP = /^[#*0-9]\uFE0F?\u20E3$/u
const FLAG = /^\p{Regional_Indicator}{2}$/u
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Whether `v` is a single non-whitespace, printable Unicode emoji grapheme within MAX_EMOJI_LEN. */
export function validEmoji(v: unknown): v is string {
  if (typeof v !== 'string' || v.length < 1 || v.length > MAX_EMOJI_LEN) return false
  if (v.trim() !== v || /\s/.test(v) || !v.isWellFormed() || new RegExp(UNPRINTABLE).test(v)) return false
  let count = 0
  for (const _ of GRAPHEMES.segment(v)) {
    count++
    if (count > 1) return false
  }
  if (count !== 1) return false
  return PICTOGRAPHIC.test(v) || KEYCAP.test(v) || FLAG.test(v)
}

/** Normalizes a raw emoji or Slack `:shortcode:` into a valid emoji, or null when unknown/invalid. */
export function normalizeEmoji(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const short = /^:([a-z0-9_+-]{1,40}):$/i.exec(trimmed)
  if (short?.[1]) return SHORTCODE_MAP.get(short[1].toLowerCase()) ?? null
  return validEmoji(trimmed) ? trimmed : null
}

/** Searches EMOJI_LIST by shortcode, English/Russian keywords, or emoji itself. */
export function searchEmoji(query: string): readonly EmojiEntry[] {
  const clean = query
    .trim()
    .replace(/^:+|:+$/g, '')
    .toLowerCase()
  if (!clean) return EMOJI_LIST
  const words = clean.split(/\s+/).filter(Boolean)
  if (!words.length) return EMOJI_LIST
  return EMOJI_LIST.filter(entry => {
    const hay = `${entry.short} ${entry.keywords.toLowerCase()} ${entry.emoji}`
    return words.every(w => hay.includes(w))
  })
}
