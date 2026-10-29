// The agents' own browsers on the board's server (core/desktop.ts): what the install says of
// their packages, and `board doctor`'s checks, in English and Russian; strings.ts merges them
// into the dictionaries. Package and program names stay English.
import type { Lang } from '../types.ts'

export const DESKTOP_STRINGS: Record<Lang, Record<string, string | string[]>> = {
  en: {
    'install.will.desktop':
      'Install what the agents’ own browsers need, as root with apt (about 300–500 MB of memory for each browser open): {packages}.',
    'install.step.desktop': 'the agents’ browsers: {packages}',
    'install.undo.will.desktop': 'Remove the packages the install added for the agents’ browsers: {packages}.',
    'install.will.chromium':
      'Put Chromium in place for the agents’ browsers, as {user} in its state folder: Chrome for Testing’s arm64 build, by Playwright {version} (Ubuntu’s own Chromium is a snap).',
    'install.undo.will.libs':
      'Hand the libraries the install added for Chromium back to apt (apt autoremove takes them once nothing needs them): {packages}.',
    'desktop.check.xvnc': 'The agents’ browsers: Xvnc (TigerVNC)',
    'desktop.check.noXvnc': 'The agents’ browsers: no Xvnc (TigerVNC)',
    'desktop.check.chrome': 'The agents’ browsers: the browser',
    'desktop.check.noChrome': 'The agents’ browsers: no Google Chrome or Chromium',
    'desktop.check.fonts': 'The agents’ browsers: Noto fonts',
    'desktop.check.noFonts': 'The agents’ browsers: no Noto fonts (pages may show boxes for letters)',
    'desktop.check.installFix':
      'Run the board’s install again on the server, as root (server-install.sh); it adds them.',
    'desktop.check.mcp': 'The agents’ browsers: chrome-devtools-mcp {version}',
    'desktop.check.noMcp': 'The agents’ browsers: chrome-devtools-mcp {version} is not in place',
    'desktop.check.mcpFix': 'The board’s install action puts it in place:',
    'desktop.check.profiles': 'The agents’ browsers: the MCP server {mcp} in every profile',
    'desktop.check.noProfiles': 'The agents’ browsers: no MCP server in {profiles}',
  },
  ru: {
    'install.will.desktop':
      'Установить нужное собственным браузерам агентов, от root через apt (каждый открытый браузер занимает около 300–500 МБ памяти): {packages}.',
    'install.step.desktop': 'браузеры агентов: {packages}',
    'install.undo.will.desktop': 'Удалить пакеты, которые установка добавила для браузеров агентов: {packages}.',
    'install.will.chromium':
      'Поставить Chromium для браузеров агентов, от {user} в его папку состояния: сборку Chrome for Testing для arm64, через Playwright {version} (Chromium самой Ubuntu — snap).',
    'install.undo.will.libs':
      'Вернуть apt библиотеки, которые установка добавила для Chromium (apt autoremove уберёт их, когда они никому не нужны): {packages}.',
    'desktop.check.xvnc': 'Браузеры агентов: Xvnc (TigerVNC)',
    'desktop.check.noXvnc': 'Браузеры агентов: нет Xvnc (TigerVNC)',
    'desktop.check.chrome': 'Браузеры агентов: браузер',
    'desktop.check.noChrome': 'Браузеры агентов: нет Google Chrome или Chromium',
    'desktop.check.fonts': 'Браузеры агентов: шрифты Noto',
    'desktop.check.noFonts': 'Браузеры агентов: нет шрифтов Noto (вместо букв на страницах могут быть квадраты)',
    'desktop.check.installFix':
      'Запустите установку доски на сервере ещё раз, от root (server-install.sh): она их добавит.',
    'desktop.check.mcp': 'Браузеры агентов: chrome-devtools-mcp {version}',
    'desktop.check.noMcp': 'Браузеры агентов: chrome-devtools-mcp {version} не установлен',
    'desktop.check.mcpFix': 'Его ставит действие установки доски:',
    'desktop.check.profiles': 'Браузеры агентов: MCP-сервер {mcp} во всех профилях',
    'desktop.check.noProfiles': 'Браузеры агентов: нет MCP-сервера в {profiles}',
  },
}
