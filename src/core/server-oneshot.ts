// "Do it myself" as one command (the simple-setup spec's "'Do it myself': one command", its calls
// 8, 10 and 11): what the owner pastes into a root shell on their server (or a sudo user's: it runs
// itself again with sudo). It carries everything the board knows (the domain, the tunnel's user and
// socket, the public port, the board's public key) and the board's own steps for every shape of
// server it sets up (core/server-oneshot-templates.ts). On the server it runs Look, reads it and
// chooses as the board would, makes the plan the board would make, step 1's parts the server lacks
// first (core/server-oneshot-awk.ts), says it in plain words as the panel does, asks once on the
// terminal, and runs it as the board would, with its record, lock, rollback and checks; at the end,
// "done: <address>", or why it stopped and what was rolled back. On a server the board does not do,
// it stops before changing anything and says why. The Undo command is the same, for the record on
// the server.
//
// The command is one line: the script gzipped, in base64, decoded and run by `sh`. Pure, with no
// node: import: the gzip is the caller's.

import { STRINGS } from './i18n/strings.ts'
import { t } from './lang.ts'
import { fenceWanted, lookScript1, SUPPORTED } from './server-look.ts'
import { AWK_BODY, awkString } from './server-oneshot-awk.ts'
import {
  dictionary,
  hashTemplates,
  launchTemplate,
  lookKey,
  lookShapes,
  lookTemplate,
  relyKey,
  relyShapes,
  relyTemplate,
} from './server-oneshot-templates.ts'
import type { Wanted } from './server-plan.ts'
import { END, LAST_LINE, SKIP_S } from './server-script.ts'
import { shQuote } from './server-shell.ts'
import {
  BACKUPS_DIR,
  BLOCK_BEGIN,
  BLOCK_END,
  BOARD_DIR,
  CADDY_FILE,
  CADDY_IMAGE,
  CADDY_NAME,
  DOCKER_FILES,
  FENCE_FILE,
  IMPORT_LINE,
  KEYS_DIR,
  LOCK_FILE,
  NGINX_FILE,
  RECORD_FILE,
  ROLE_LABEL,
  RUNS_DIR,
  SITE_FILE,
  SOCAT_IMAGE,
  SOCKET_NAME,
  SSHD_CONFIG,
  VOLUMES,
} from './server-texts.ts'

/** What the board puts into the command. */
export interface OneshotInput {
  wanted: Wanted
  /** The board's public key: step 1's keys file holds it (none: the command makes no step 1, as the board). */
  publicKey: string | null
}

/** The two scripts, readable ("What is inside"). */
export interface OneshotScripts {
  script: string
  undoScript: string
}

/** What the panel wants, with the board's key when it has one. */
const wantedOf = (i: OneshotInput): Wanted => {
  const { publicKey: _, ...w } = i.wanted
  return i.publicKey === null ? w : { ...w, publicKey: i.publicKey }
}

/** The texts the awk says, by key, in the board's language. */
function texts(): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = Object.keys(STRINGS.en).filter(
    k =>
      k.startsWith('server.manual.') ||
      k.startsWith('server.warn.') ||
      k.startsWith('server.plain.') ||
      k === 'server.step.guard.title' ||
      k === 'server.step.by-hand.title' ||
      k === 'server.oneshot.inPlace' ||
      k === 'server.oneshot.byHand' ||
      k === 'server.oneshot.undid' ||
      k === 'server.oneshot.undoFailed',
  )
  for (const k of keys) out[k] = t(k)
  return out
}

/** The awk's BEGIN: the board's values, the names and paths of what it owns, the guard's lines, the hashes' inputs, the texts. */
function preamble(w: Wanted): string {
  const set = (name: string, value: string): string => `  ${name} = ${awkString(value)}`
  const lines = [
    'BEGIN {',
    '  init()',
    set('W_USER', w.user),
    set('W_SOCKET', w.socket),
    set('W_DOMAIN', w.domain),
    set('W_PORT', w.publicPort === null ? '' : String(w.publicPort)),
    set('W_KEY', w.publicKey ?? ''),
    set('CADDY_FILE', CADDY_FILE),
    set('SITE_FILE', SITE_FILE),
    set('NGINX_FILE', NGINX_FILE),
    set('IMPORT_LINE', IMPORT_LINE),
    set('BLOCK_BEGIN', BLOCK_BEGIN),
    set('BLOCK_END', BLOCK_END),
    set('BACKUPS_DIR', BACKUPS_DIR),
    set('BOARD_DIR', BOARD_DIR),
    set('RECORD_FILE', RECORD_FILE),
    set('LOCK_FILE', LOCK_FILE),
    set('RUNS_DIR', RUNS_DIR),
    set('KEYS_DIR', KEYS_DIR),
    set('FENCE_FILE', FENCE_FILE),
    set('SSHD_CONFIG', SSHD_CONFIG),
    set('CADDY_NAME', CADDY_NAME),
    set('SOCKET_NAME', SOCKET_NAME),
    set('VOLUME1', VOLUMES[0]),
    set('VOLUME2', VOLUMES[1]),
    set('CADDY_IMAGE', CADDY_IMAGE),
    set('SOCAT_IMAGE', SOCAT_IMAGE),
    set('ROLE_LABEL', ROLE_LABEL),
    // the run's own words (core/server-script.ts)
    set('LAST_LINE', LAST_LINE),
    set('STEP_END', END),
    set('SKIP_S', String(SKIP_S)),
    `  SUPPORTED["debian"] = ${awkString(SUPPORTED.debian.join(' '))}`,
    `  SUPPORTED["ubuntu"] = ${awkString(SUPPORTED.ubuntu.join(' '))}`,
    ...['1', '1b', '2', '3a', '3b', '4a', '4b'].map(c => `  CASES[${awkString(c)}] = 1`),
    ...DOCKER_FILES.map(f => `  DOCKERFILE[${awkString(f)}] = 1`),
    // sshd's fence as it must be in force for the tunnel user (core/server-look.ts fenceWanted)
    ...Object.entries(fenceWanted(w.user)).map(([k, v]) => `  FENCEW[${awkString(k)}] = ${awkString(v)}`),
    ...relyShapes().map(r => `  RELY[${awkString(relyKey(r))}] = ${awkString(relyTemplate(r, w))}`),
    ...Object.entries(hashTemplates(w)).map(([k, v]) => `  HASH[${awkString(k)}] = ${awkString(v)}`),
    ...Object.entries(texts()).map(([k, v]) => `  TXT[${awkString(k)}] = ${awkString(v)}`),
    '}',
  ]
  return lines.join('\n')
}

/** The awk program the command carries. */
export function oneshotAwk(i: OneshotInput): string {
  return `${preamble(wantedOf(i))}\n${AWK_BODY}`
}

/** What the awk reads before Look's output in the apply and undo modes: every step template and shape. */
export function oneshotDictionary(i: OneshotInput): string {
  return `@@ab-dict\n${dictionary(wantedOf(i))}`
}

// ---------------------------------------------------------------------------------------------
// The shell around it

const END_TEMPLATE = 'AGENT_BOARD_TEMPLATE'
const MAIN_END = 'AGENT_BOARD_MAIN'

/** A heredoc that prints the text as it is. */
function printing(text: string, end = END_TEMPLATE): string[] {
  if (text.split('\n').includes(end)) throw new Error(`a text holds ${end}`)
  return [`cat <<'${end}'`, text, end]
}

/** Functions that print a template by its key (`name <key>`; status 1 for a key it does not have), each text once. */
function dispatch(name: string, entries: [string, string][]): string[] {
  const texts = new Map<string, string[]>()
  for (const [key, text] of entries) texts.set(text, [...(texts.get(text) ?? []), key])
  const out: string[] = []
  const cases: string[] = []
  let n = 0
  for (const [text, keys] of texts) {
    n++
    out.push(`${name}_${n}() {`, ...printing(text), '}')
    cases.push(`  ${keys.join('|')}) ${name}_${n} ;;`)
  }
  out.push(`${name}() {`, '  case $1 in', ...cases, '  *) return 1 ;;', '  esac', '}')
  return out
}

/** A message with one value: `name <value>` prints it. */
function message(name: string, key: string, param: string): string {
  const mark = '\u0001'
  const [before = '', after = ''] = t(key, { [param]: mark }).split(mark)
  return `${name}() { printf '%s%s%s\\n' ${shQuote(before)} "$1" ${shQuote(after)}; }`
}
const say = (key: string): string => `say ${shQuote(t(key))}`

/** What every script starts with: who it is for, then root, then the main part in a heredoc. */
function head(w: Wanted, what: string[]): string[] {
  const port = w.publicPort === null ? '443' : String(w.publicPort)
  return [
    '#!/bin/sh',
    ...what.map(l => `# ${l}`),
    '#',
    `# The board's address: https://${w.domain}${port === '443' ? '' : `:${port}`}`,
    `# The tunnel's user and socket: ${w.user}, ${w.socket}`,
    `# The board's key: ${w.publicKey ?? '(none yet)'}`,
    '#',
    '# It runs as root: run by a user with sudo, it runs itself again with sudo.',
    'umask 077',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    'if [ "$(id -u)" = 0 ]; then r=sh',
    `elif command -v sudo >/dev/null 2>&1; then printf '%s\\n' ${shQuote(t('server.oneshot.root'))}; r='sudo sh'`,
    `else printf '%s\\n' ${shQuote(t('server.oneshot.noSudo'))}; exit 1`,
    'fi',
    `exec $r <<'${MAIN_END}'`,
  ]
}

/** The part both scripts share: tools, Look's two rounds, the steps, the question, the plan in plain words, the run. */
function common(i: OneshotInput, mode: 'apply' | 'undo'): string[] {
  const w = wantedOf(i)
  const look = { user: w.user, socket: w.socket, domain: w.domain }
  return [
    'set -u',
    'umask 077',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    'say() { printf \'%s\\n\' "$@"; }',
    message('m_missing', 'server.oneshot.missing', 'tool'),
    message('m_refuse', 'server.oneshot.refuse', 'what'),
    message('m_internal', 'server.oneshot.internal', 'what'),
    "# the reader and chooser (core/server-oneshot-awk.ts), with the board's values: in a file of its",
    '# own for awk -f (100 KB and more is past one argument of a command line), gone when this ends',
    'command -v mktemp >/dev/null 2>&1 || { m_missing mktemp; exit 1; }',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own ${…}
    'AWKF=$(mktemp "${TMPDIR:-/tmp}/agent-board.XXXXXXXX") || exit 1',
    `trap 'rm -f "$AWKF"' EXIT`,
    "trap 'exit 1' HUP INT TERM",
    `cat > "$AWKF" <<'AGENT_BOARD_AWK'`,
    ...printing(oneshotAwk(i), 'AGENT_BOARD_AWK').slice(1),
    "# Look's first round, the board's own script (core/server-look.ts lookScript1)",
    'look1() {',
    ...printing(lookScript1({ ...look, ...(w.publicKey !== undefined && { publicKey: w.publicKey }) })),
    '}',
    "# Look's second round, for what the first found (lookScript2), by its shape",
    ...dispatch(
      'look2',
      lookShapes().map(s => [lookKey(s), lookTemplate(s, look)]),
    ),
    '# the launch that starts a run apart from this shell and follows it (core/server-script.ts launchScript)',
    'launch() {',
    ...printing(launchTemplate(w)),
    '}',
    "# the board's steps for every plan, and which a plan has (core/server-oneshot-templates.ts dictionary)",
    'steps() {',
    ...printing(oneshotDictionary(i)),
    '}',
    '# a template filled in with the values: bind <values> <template function> <key>',
    'bind() { { printf \'%s\\n\' "$1"; echo \'@@ab-template\'; "$2" "$3"; } | awk -v mode=bind -f "$AWKF"; }',
    "# what follows a decision's first word",
    "restof() { printf '%s\\n' \"$1\" | sed 's/^[^ ]* *//'; }",
    "# the lines of the plan's answer that start with a word, without it",
    'said() { printf \'%s\\n\' "$I" | sed -n "s/^$1 //p"; }',
    'look() {',
    '  for c in awk sed grep od date head tr gzip base64; do',
    '    if ! command -v "$c" >/dev/null 2>&1; then m_missing "$c"; exit 1; fi',
    '  done',
    `  ${say(mode === 'undo' ? 'server.oneshot.undo.looking' : 'server.oneshot.looking')}`,
    '  R1=$(sh -c "$(look1)" 2>/dev/null)',
    '  D=$(printf \'%s\\n\' "$R1" | awk -v mode=r2 -f "$AWKF")',
    '  first=$(printf \'%s\\n\' "$D" | head -n 1)',
    '  R2=',
    '  case $first in',
    "  'r2 none') ;;",
    "  'r2 '*)",
    '    k=$(restof "$first")',
    '    look2 "$k" >/dev/null || { m_internal "$k"; exit 1; }',
    '    S2=$(bind "$D" look2 "$k") || { m_internal "$k"; exit 1; }',
    '    R2=$(sh -c "$S2" 2>/dev/null) ;;',
    '  refuse*) m_refuse "$(restof "$first")"; exit 1 ;;',
    `  *) ${say('server.oneshot.unreadable')}; exit 1 ;;`,
    '  esac',
    '}',
    '# the ids of a plan and its run (letters, digits, `-`), and when',
    'newid() { printf \'%s-%s\' "$(date -u +%Y%m%d-%H%M%S)" "$(od -An -N2 -tx1 /dev/urandom | tr -d \' \\n\')"; }',
    "# the plan the board would make of Look's two rounds: P, what it says in I, the run in RUN",
    'plan() {',
    '  PID=$(newid); RID=$(newid); AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)',
    `  P=$( { steps; echo '@@ab-round1'; printf '%s\\n' "$R1"; echo '@@ab-round2'; printf '%s\\n' "$R2"; } | awk -v mode=${mode} -v PLAN_ID="$PID" -v RUN_ID="$RID" -v RUN_AT="$AT" -f "$AWKF")`,
    "  I=$(printf '%s\\n' \"$P\" | sed '/^@@ab-run$/,$d')",
    '}',
    '# what was found, in plain words',
    'found() {',
    '  F=$(said pfound)',
    `  [ -z "$F" ] || { say '' ${shQuote(t('server.oneshot.found'))}; printf '  %s\\n' "$F"; }`,
    '}',
    '# asked once, on the terminal: a paste never changes anything without a yes; 2: no terminal',
    'ask() {',
    '  if ! { true >/dev/tty; } 2>/dev/null; then return 2; fi',
    `  printf '%s' ${shQuote(t('server.oneshot.ask'))} >/dev/tty 2>/dev/null || return 1`,
    '  a=',
    '  read -r a </dev/tty 2>/dev/null || return 1',
    '  case $a in y|Y|yes|Yes|YES|д|Д|да|Да|ДА) return 0 ;; *) return 1 ;; esac',
    '}',
    '# runs the plan through the launch, packed as the board packs it, its steps shown as they end; its status',
    'runit() {',
    "  RUN=$(printf '%s\\n' \"$P\" | sed '1,/^@@ab-run$/d')",
    '  TITLES=$(said title)',
    "  PK=$(printf '%s\\n' \"$RUN\" | gzip -c | base64 | tr -d '\\n')",
    '  L=$(printf \'v run_id %s\\nv packed %s\' "$RID" "$PK")',
    '  LAUNCH=$(bind "$L" launch -) || { m_internal launch; exit 1; }',
    `  say '' ${shQuote(t('server.oneshot.running'))}`,
    '  sh -c "$LAUNCH" | AB_TITLES="$TITLES" awk -v mode=progress -f "$AWKF"',
    '}',
    '# how the run ended',
    'ended() {',
    "  say ''",
    '  case $1 in',
    `  1) ${say('server.oneshot.rolledBack')} ;;`,
    `  2) ${say('server.oneshot.rollbackFailed')} ;;`,
    `  3) ${say('server.oneshot.busy')} ;;`,
    `  4) ${say('server.oneshot.changed')} ;;`,
    `  6) ${say('server.oneshot.stoppedFirst')} ;;`,
    `  *) ${say('server.oneshot.lost')} ;;`,
    '  esac',
    '}',
  ]
}

/** The question, and what its answer does: a yes goes on; a no, or no terminal to ask on, stops there. */
const asked = (): string[] => [
  '  ask; a=$?',
  `  if [ "$a" = 2 ]; then say '' ${shQuote(t('server.oneshot.noTerminal'))}; exit 1; fi`,
  `  if [ "$a" != 0 ]; then say '' ${shQuote(t('server.oneshot.no'))}; exit 1; fi`,
]

/** The one command's script ("What is inside"). */
export function applyScript(i: OneshotInput): string {
  return [
    ...head(wantedOf(i), [
      'agent-board: "Do it myself" as one command. It looks at this server, chooses what the board',
      '"Set up the server" would do here, says it, asks once, and does it: the board\'s own login on',
      "this server (its tunnel user, made only where it is missing) and the board's address through",
      "its tunnel, with the board's own record, lock, rollback and checks (/etc/agent-board). It",
      'changes nothing before you say yes, and nothing on a server the board does not set up. Safe',
      'to paste again.',
    ]),
    ...common(i, 'apply'),
    message('m_done', 'server.oneshot.done', 'address'),
    message('m_same', 'server.oneshot.same', 'address'),
    message('m_unfinished', 'server.oneshot.unfinished', 'state'),
    'main() {',
    '  look',
    '  plan',
    "  first=$(printf '%s\\n' \"$I\" | grep -E '^(plan|stop|same|busy|unfinished|interrupted|unreadable|refuse|internal)( |$)' | head -n 1)",
    '  rest=$(restof "$first")',
    '  found',
    '  case $first in',
    "  'plan '*) ;;",
    `  'stop '*) say ''; said pstop; said why | sed 's/^/  - /'; ${say('server.oneshot.no')}; ${say('server.oneshot.stopHint')}; exit 1 ;;`,
    `  interrupted) say '' ${shQuote(t('server.oneshot.interrupted'))}; exit 1 ;;`,
    `  busy) say '' ${shQuote(t('server.oneshot.busy'))}; exit 1 ;;`,
    "  'unfinished '*) say ''; m_unfinished \"$rest\"; exit 1 ;;",
    "  'same '*) say ''; m_same \"$rest\"; exit 0 ;;",
    '  refuse*) m_refuse "$rest"; exit 1 ;;',
    '  internal*) m_internal "$rest"; exit 1 ;;',
    `  *) ${say('server.oneshot.unreadable')}; exit 1 ;;`,
    '  esac',
    '  ADDRESS=$(said address | head -n 1)',
    // plainPlan: the plan in plain words, as the panel says it (core/server-plain.ts)
    `  say '' ${shQuote(t('server.oneshot.plan'))}`,
    "  said pwill | sed 's/^/  - /'",
    "  said pdocker | sed 's/^/  - /'",
    "  said puntouched | sed 's/^/  /'",
    "  N=$(said warn | sed 's/^/  - /')",
    `  [ -z "$N" ] || { say '' ${shQuote(t('server.oneshot.notes'))}; printf '%s\\n' "$N"; }`,
    `  say '' ${shQuote(t('server.oneshot.unchanged'))}`,
    ...asked(),
    '  runit',
    '  r=$?',
    `  if [ "$r" = 0 ]; then say ''; m_done "$ADDRESS"; ${say('server.oneshot.test')}; else ended "$r"; fi`,
    '  exit $r',
    '}',
    'main </dev/null',
    MAIN_END,
    '',
  ].join('\n')
}

/** The Undo command's script. */
export function undoScriptOf(i: OneshotInput): string {
  return [
    ...head(wantedOf(i), [
      "agent-board: Undo as one command. It looks at this server and removes what the board's",
      "record (/etc/agent-board/setup.json) names, as the board's Undo would: their Caddyfile's line",
      "or block taken out of it as it is now, the board's containers, volumes, images and files, the",
      "board's own login on this server where the board made it, then the record. It changes nothing",
      'before you say yes. Docker, and files of the board you changed since, stay.',
    ]),
    ...common(i, 'undo'),
    message('m_unknown', 'server.oneshot.undo.unknown', 'what'),
    'main() {',
    '  look',
    '  plan',
    "  first=$(printf '%s\\n' \"$I\" | grep -E '^(plan|stop|nothing|busy|unreadable|refuse|internal|unknown)( |$)' | head -n 1)",
    '  rest=$(restof "$first")',
    '  found',
    '  case $first in',
    "  'plan '*) ;;",
    `  nothing) say '' ${shQuote(t('server.oneshot.undo.nothing'))}; exit 0 ;;`,
    `  'stop '*) say '' ${shQuote(t('server.oneshot.undo.stop'))}; said why | sed 's/^/  - /'; exit 1 ;;`,
    `  busy) say '' ${shQuote(t('server.oneshot.busy'))}; exit 1 ;;`,
    '  refuse*) m_refuse "$rest"; exit 1 ;;',
    '  internal*) m_internal "$rest"; exit 1 ;;',
    "  'unknown '*) say ''; m_unknown \"$rest\"; exit 1 ;;",
    `  *) ${say('server.oneshot.unreadable')}; exit 1 ;;`,
    '  esac',
    // plainPlan: what Undo will do, in plain words
    `  say '' ${shQuote(t('server.oneshot.plan'))}`,
    "  said pwill | sed 's/^/  - /'",
    "  said puntouched | sed 's/^/  /'",
    `  say '' ${shQuote(t('server.oneshot.undo.kept'))} ${shQuote(t('server.oneshot.unchanged'))}`,
    ...asked(),
    '  runit',
    '  r=$?',
    `  if [ "$r" = 0 ]; then say ''; ${say('server.oneshot.undo.done')}; else ended "$r"; fi`,
    '  exit $r',
    '}',
    'main </dev/null',
    MAIN_END,
    '',
  ].join('\n')
}

/** Both scripts. */
export function oneshotScripts(i: OneshotInput): OneshotScripts {
  return { script: applyScript(i), undoScript: undoScriptOf(i) }
}

/** Standard base64 of bytes, in one line. */
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/**
 * The one line the owner pastes: the script gzipped (the caller's gzip), in base64, decoded and run
 * by `sh`. Only base64's own characters, spaces and `|`: it pastes alike into bash, zsh, fish and
 * dash, in Windows Terminal, PuTTY or macOS' Terminal.
 */
export function oneLine(script: string, gzip: (bytes: Uint8Array) => Uint8Array): string {
  return `echo ${base64(gzip(new TextEncoder().encode(script)))} | base64 -d | gunzip | sh`
}
