// The texts of verified done (#492, docs/design/threads 3.8): the panel's verification block, the
// feed's verdict lines and the launch's refusal, merged into the dictionaries by strings.ts.
import type { Lang } from '../types.ts'

export const VERIFY_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'verify.err.launcher':
      "The board's launcher here cannot start Claude under a session id the board chose (launch.agent is not Claude or its arguments pick the session, or launch.command has no {sessionId}): it cannot start a verifier",
    'wt.verify.on': 'Verified done',
    'wt.verify.off': 'Verification off',
    'wt.verify.lane': 'from its lane',
    'wt.verify.accept': 'Acceptance',
    'wt.verify.none': 'No acceptance lines: the verifier judges by what the thread asks',
    'wt.verify.held': 'says it is done; a verifier checks it first: {why}',
    'wt.verify.running': 'Verification running: {name} until {until}',
    'wt.verify.waiting': 'Waiting for a verifier',
    'wt.verify.last': 'Last verdict: {verdict}',
    'wt.verify.fails': ['{n} failed in a row', '{n} failed in a row'],
    'wt.did.verifier': 'started the verifier',
    'wt.did.verdict': 'verdict: {verdict} · {status}',
    'wt.verdict.pass': 'pass',
    'wt.verdict.fail': 'fail',
    'wt.verdict.unsure': 'could not check',
    'wt.verdict.timeout': 'no verdict in time',
    'wt.verdict.error': 'no verifier',
  },
  ru: {
    'verify.err.launcher':
      'Здешний запуск доски не может стартовать Claude с id сессии, выбранным доской (launch.agent не Claude или его аргументы сами выбирают сессию, либо в launch.command нет {sessionId}): верификатора так не запустить',
    'wt.verify.on': 'Проверка готовности',
    'wt.verify.off': 'Проверка выключена',
    'wt.verify.lane': 'от полосы',
    'wt.verify.accept': 'Приёмка',
    'wt.verify.none': 'Строк приёмки нет: проверяющий судит по тому, что просит тред',
    'wt.verify.held': 'говорит, что готово; сначала проверяет проверяющий: {why}',
    'wt.verify.running': 'Идёт проверка: {name} до {until}',
    'wt.verify.waiting': 'Ждёт проверяющего',
    'wt.verify.last': 'Последний вердикт: {verdict}',
    'wt.verify.fails': ['{n} провал подряд', '{n} провала подряд', '{n} провалов подряд'],
    'wt.did.verifier': 'запустил проверяющего',
    'wt.did.verdict': 'вердикт: {verdict} · {status}',
    'wt.verdict.pass': 'принято',
    'wt.verdict.fail': 'не принято',
    'wt.verdict.unsure': 'не смог проверить',
    'wt.verdict.timeout': 'нет вердикта вовремя',
    'wt.verdict.error': 'нет проверяющего',
  },
}
