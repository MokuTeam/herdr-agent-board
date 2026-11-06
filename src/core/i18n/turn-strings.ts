// Texts of Stop on a working session and Send now on a message in its queue (#330), merged into
// the board's dictionaries by strings.ts (same rules: {name} placeholders, arrays are plural forms).

import type { Lang } from '../types.ts'

export const TURN_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    // Stop, on a working card and in its sheet: one press arms it, a second one stops
    'turn.stop': 'Stop',
    'turn.stop.hint': 'Stop this turn, as Esc does in the terminal: the session and its conversation stay',
    'turn.stop.confirm': 'Stop the turn?',
    'turn.stop.confirmShort': 'Stop?',
    'turn.stop.confirmHint': 'Press again to stop the turn',
    'turn.stopping': 'Stopping…',
    'turn.stopped': '{name} stopped',
    'turn.already': '{name} had finished its turn already',
    // Send now, on a queued message in the session's chat
    'turn.sendNow': 'Send now',
    'turn.sendNow.hint':
      'Into the running turn at once, with every message waiting in the queue (Ctrl+Enter in the terminal)',
    'turn.sendingNow': 'Sending now…',
    // why nothing was pressed, or what came of it
    'turn.err.unknown': 'The board does not know the key that stops {name}',
    'turn.err.asleep': '{name} is asleep: no turn runs',
    'turn.err.covered': 'Something is open over {name}’s input box: the board presses nothing into it',
    'turn.err.still': '{name} did not stop: it is still working {s} s after Esc',
    'turn.err.herdr': 'herdr did not press the key in {name}: {why}',
    'turn.sendNow.err.unknown': 'The board does not know the key that sends a queued message now in {name}',
    'turn.sendNow.err.draft': '{name} has unsent text in its input box: Send now would send that instead',
    'turn.sendNow.err.still': '{name} has not taken it in yet: it goes in once the running turn makes way, or after it',
    'turn.err.inFlight': 'The board is pressing a key in {name} already',
  },
  ru: {
    'turn.stop': 'Стоп',
    'turn.stop.hint': 'Остановить этот ход, как Esc в терминале: сессия и её переписка остаются',
    'turn.stop.confirm': 'Остановить ход?',
    'turn.stop.confirmShort': 'Стоп?',
    'turn.stop.confirmHint': 'Нажмите ещё раз, чтобы остановить ход',
    'turn.stopping': 'Останавливается…',
    'turn.stopped': '{name}: ход остановлен',
    'turn.already': '{name}: ход уже закончился',
    'turn.sendNow': 'Отправить сейчас',
    'turn.sendNow.hint': 'Сразу в идущий ход, вместе со всеми сообщениями в очереди (Ctrl+Enter в терминале)',
    'turn.sendingNow': 'Отправляется сейчас…',
    'turn.err.unknown': '{name}: доска не знает клавишу, которая останавливает эту программу',
    'turn.err.asleep': '{name} спит: хода нет',
    'turn.err.covered': '{name}: поле ввода чем-то закрыто, доска ничего туда не нажимает',
    'turn.err.still': '{name}: ход не остановился, через {s} с после Esc сессия всё ещё работает',
    'turn.err.herdr': '{name}: herdr не нажал клавишу: {why}',
    'turn.sendNow.err.unknown': '{name}: доска не знает клавишу, которая сразу отправляет сообщение из очереди',
    'turn.sendNow.err.draft': '{name}: в поле ввода недописанный текст, «Отправить сейчас» отправило бы его',
    'turn.sendNow.err.still':
      '{name}: сообщение пока в очереди, оно уйдёт, когда идущий ход уступит место, или после него',
    'turn.err.inFlight': '{name}: доска уже нажимает там клавишу',
  },
}
