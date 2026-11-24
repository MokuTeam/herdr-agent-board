// Strings for background task status and stuck-task warnings (#676), merged into STRINGS in strings.ts.
import type { Lang } from '../types.ts'

export const BG_TASK_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'card.bgTask': 'Background task',
    'card.bgTaskAge': 'Background task · {age}',
    'card.bgTasks': ['{n} background task', '{n} background tasks'],
    'card.bgTasksAge': ['{n} background task · {age}', '{n} background tasks · {age}'],
    'card.bgTaskStuck': 'Task may be stuck · {age}',
    'card.bgTaskStuckNoAge': 'Task may be stuck',
    'card.bgTasksStuck': ['{n} task may be stuck · {age}', '{n} tasks · may be stuck ({age})'],
    'card.bgTaskStuckHint': 'Running past the {min} min threshold',
    'sheet.bgTask': 'Task',
    'err.bgTaskStuckMin': 'Stuck task threshold must be 0 (off) or 1 to {max} minutes',
  },
  ru: {
    'card.bgTask': 'Фоновая задача',
    'card.bgTaskAge': 'Фоновая задача · {age}',
    'card.bgTasks': ['{n} фоновая задача', '{n} фоновые задачи', '{n} фоновых задач'],
    'card.bgTasksAge': ['{n} фоновая задача · {age}', '{n} фоновые задачи · {age}', '{n} фоновых задач · {age}'],
    'card.bgTaskStuck': 'Задача могла зависнуть · {age}',
    'card.bgTaskStuckNoAge': 'Задача могла зависнуть',
    'card.bgTasksStuck': [
      '{n} задача могла зависнуть · {age}',
      '{n} задачи · могла зависнуть ({age})',
      '{n} задач · могла зависнуть ({age})',
    ],
    'card.bgTaskStuckHint': 'Идёт дольше порога в {min} мин',
    'sheet.bgTask': 'Задача',
    'err.bgTaskStuckMin': 'Порог зависшей задачи должен быть 0 (выкл.) или от 1 до {max} минут',
  },
}
