// "Do it myself" as one command (the simple-setup spec's "'Do it myself': one command", its calls
// 8, 10 and 11): what the owner pastes into a root shell on their server (or a sudo user's: it runs
// itself again with sudo). It carries everything the board knows (the domain, the tunnel's user and
// socket, the public port, the board's public key) and the board's own scripts for every shape of
// server it sets up (core/server-oneshot-templates.ts). On the server it runs Look, reads it and
// chooses as the board would (core/server-oneshot-awk.ts), says the plan in plain words, asks once
// on the terminal, and runs the plan the board would have run, with its record, lock, rollback and
// checks; at the end, "done: <address>", or why it stopped and what was rolled back. On a server the
// board does not do, it stops before changing anything and says why. The Undo command is the same,
// for the record on the server.
//
// The command is one line: the script gzipped, in base64, decoded and run by `sh`. Pure, with no
// node: import: the gzip is the caller's.

import { STRINGS } from './i18n/strings.ts'
import { t } from './lang.ts'
import { lookScript1, SUPPORTED } from './server-look.ts'
import { AWK_BODY, awkString } from './server-oneshot-awk.ts'
import {
  applyShapes,
  applyTemplate,
  hashTemplates,
  launchTemplate,
  lookKey,
  lookShapes,
  lookTemplate,
  relyKey,
  relyShapes,
  relyTemplate,
  undoShapes,
  undoTemplate,
} from './server-oneshot-templates.ts'
import type { Wanted } from './server-plan.ts'
import { shQuote } from './server-shell.ts'
import {
  BACKUPS_DIR,
  BLOCK_BEGIN,
  BLOCK_END,
  CADDY_FILE,
  CADDY_IMAGE,
  CADDY_NAME,
  DOCKER_FILES,
  IMPORT_LINE,
  NGINX_FILE,
  ROLE_LABEL,
  SITE_FILE,
  SOCAT_IMAGE,
  SOCKET_NAME,
  VOLUMES,
} from './server-texts.ts'

/** What the board puts into the command. */
export interface OneshotInput {
  wanted: Wanted
  /** The tunnel's public key (the step that puts it on the server comes with the plan's step 1). */
  publicKey: string | null
}

/** The two scripts, readable ("What is inside"). */
export interface OneshotScripts {
  script: string
  undoScript: string
}

/** The texts the awk says, by key, in the board's language. */
function texts(): Record<string, string> {
  const out: Record<string, string> = {}
  const keys = Object.keys(STRINGS.en).filter(
    k =>
      k.startsWith('server.manual.') ||
      k.startsWith('server.warn.') ||
      k.startsWith('server.panel.holder.') ||
      k.startsWith('server.panel.ports.') ||
      k === 'server.panel.docker' ||
      k === 'server.panel.noDocker' ||
      k === 'server.oneshot.inPlace' ||
      k === 'server.oneshot.byHand' ||
      k === 'server.step.by-hand.title' ||
      k === 'server.oneshot.undid' ||
      k === 'server.oneshot.undoFailed',
  )
  for (const k of keys) out[k] = t(k)
  return out
}

/** The awk's BEGIN: the board's values, the names and paths of what it owns, the guard's lines, the hashes' inputs, the texts. */
function preamble(i: OneshotInput): string {
  const w = i.wanted
  const set = (name: string, value: string): string => `  ${name} = ${awkString(value)}`
  const lines = [
    'BEGIN {',
    '  init()',
    set('W_USER', w.user),
    set('W_SOCKET', w.socket),
    set('W_DOMAIN', w.domain),
    set('W_PORT', w.publicPort === null ? '' : String(w.publicPort)),
    set('W_KEY', i.publicKey ?? ''),
    set('CADDY_FILE', CADDY_FILE),
    set('SITE_FILE', SITE_FILE),
    set('NGINX_FILE', NGINX_FILE),
    set('IMPORT_LINE', IMPORT_LINE),
    set('BLOCK_BEGIN', BLOCK_BEGIN),
    set('BLOCK_END', BLOCK_END),
    set('BACKUPS_DIR', BACKUPS_DIR),
    set('CADDY_NAME', CADDY_NAME),
    set('SOCKET_NAME', SOCKET_NAME),
    set('VOLUME1', VOLUMES[0]),
    set('VOLUME2', VOLUMES[1]),
    set('CADDY_IMAGE', CADDY_IMAGE),
    set('SOCAT_IMAGE', SOCAT_IMAGE),
    set('ROLE_LABEL', ROLE_LABEL),
    // not in the awk's own text: a String.raw template there would keep it as ·
    set('DOT', '·'),
    `  SUPPORTED["debian"] = ${awkString(SUPPORTED.debian.join(' '))}`,
    `  SUPPORTED["ubuntu"] = ${awkString(SUPPORTED.ubuntu.join(' '))}`,
    ...['1', '1b', '2', '3a', '3b', '4a', '4b'].map(c => `  CASES[${awkString(c)}] = 1`),
    ...DOCKER_FILES.map(f => `  DOCKERFILE[${awkString(f)}] = 1`),
    ...relyShapes().map(r => `  RELY[${awkString(relyKey(r))}] = ${awkString(relyTemplate(r, w))}`),
    ...Object.entries(hashTemplates(w)).map(([k, v]) => `  HASH[${awkString(k)}] = ${awkString(v)}`),
    ...Object.entries(texts()).map(([k, v]) => `  TXT[${awkString(k)}] = ${awkString(v)}`),
    '}',
  ]
  return lines.join('\n')
}

/** The awk program the command carries. */
export function oneshotAwk(i: OneshotInput): string {
  return `${preamble(i)}\n${AWK_BODY}`
}

// ---------------------------------------------------------------------------------------------
// The shell around it

const END = 'AGENT_BOARD_TEMPLATE'
const MAIN_END = 'AGENT_BOARD_MAIN'

/** A heredoc that prints the text as it is. */
function printing(text: string, end = END): string[] {
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
function head(i: OneshotInput, what: string[]): string[] {
  const w = i.wanted
  const port = w.publicPort === null ? '443' : String(w.publicPort)
  return [
    '#!/bin/sh',
    ...what.map(l => `# ${l}`),
    '#',
    `# The board's address: https://${w.domain}${port === '443' ? '' : `:${port}`}`,
    `# The tunnel's user and socket: ${w.user}, ${w.socket}`,
    `# The board's key: ${i.publicKey ?? '(none yet)'}`,
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

/** The part both scripts share: tools, Look's two rounds, the ids of a run, the question. */
function common(i: OneshotInput): string[] {
  const w = i.wanted
  return [
    'set -u',
    'umask 077',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    'say() { printf \'%s\\n\' "$@"; }',
    message('m_missing', 'server.oneshot.missing', 'tool'),
    message('m_refuse', 'server.oneshot.refuse', 'what'),
    message('m_internal', 'server.oneshot.internal', 'what'),
    "# the reader and chooser (core/server-oneshot-awk.ts), with the board's values",
    `AWKP=$(${printing(oneshotAwk(i), 'AGENT_BOARD_AWK').join('\n')}`,
    ')',
    "# Look's first round, the board's own script (core/server-look.ts lookScript1)",
    'look1() {',
    ...printing(lookScript1({ user: w.user, socket: w.socket, domain: w.domain })),
    '}',
    "# Look's second round, for what the first found (lookScript2), by its shape",
    ...dispatch(
      'look2',
      lookShapes().map(s => [lookKey(s), lookTemplate(s, { user: w.user, socket: w.socket, domain: w.domain })]),
    ),
    '# the launch that starts a run apart from this shell and follows it (core/server-script.ts launchScript)',
    'launch() {',
    ...printing(launchTemplate(w)),
    '}',
    '# a template filled in with the values: bind <values> <template function> <key>',
    'bind() { { printf \'%s\\n\' "$1"; echo \'@@ab-template\'; "$2" "$3"; } | awk -v mode=bind "$AWKP"; }',
    "# what follows a decision's first word",
    "restof() { printf '%s\\n' \"$1\" | sed 's/^[^ ]* *//'; }",
    'look() {',
    '  for c in awk sed grep od date head tr; do',
    '    if ! command -v "$c" >/dev/null 2>&1; then m_missing "$c"; exit 1; fi',
    '  done',
    `  ${say('server.oneshot.looking')}`,
    '  R1=$(sh -c "$(look1)" 2>/dev/null)',
    '  D=$(printf \'%s\\n\' "$R1" | awk -v mode=r2 "$AWKP")',
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
    '# asked once, on the terminal: a paste never changes anything without a yes',
    'ask() {',
    `  printf '%s' ${shQuote(t('server.oneshot.ask'))} >/dev/tty 2>/dev/null || return 1`,
    '  a=',
    '  read -r a </dev/tty 2>/dev/null || return 1',
    '  case $a in y|Y|yes|Yes|YES|д|Д|да|Да|ДА) return 0 ;; *) return 1 ;; esac',
    '}',
    '# the plan in plain words: what was found, why this plan, its steps (TITLES), notes',
    'plain() {',
    "  F=$(printf '%s\\n' \"$P\" | sed -n 's/^found //p')",
    `  [ -z "$F" ] || { say '' ${shQuote(t('server.oneshot.found'))}; printf '  %s\\n' "$F"; }`,
    '}',
    '# runs the bound run through the launch, its steps shown as they end; its status',
    'runit() {',
    '  RUN=$(bind "$V" "$1" "$KEY") || { m_internal "$KEY"; exit 1; }',
    '  L=$(printf \'v run_id %s\\nl run\\n%s\\n@@ab-end-value\' "$RID" "$RUN")',
    '  LAUNCH=$(bind "$L" launch -) || { m_internal launch; exit 1; }',
    `  say '' ${shQuote(t('server.oneshot.running'))}`,
    '  sh -c "$LAUNCH" | AB_TITLES="$TITLES" awk -v mode=progress "$AWKP"',
    '}',
  ]
}

/** The step titles' and the why's template per key: a line of flags, the why, a title per step. */
function textOf(flags: string, why: string, titles: string[]): string {
  return [flags, why, ...titles].join('\n')
}

/** The one command's script ("What is inside"). */
export function applyScript(i: OneshotInput): string {
  const w = i.wanted
  const templates = applyShapes().map(s => applyTemplate(s, w))
  return [
    ...head(i, [
      'agent-board: "Do it myself" as one command. It looks at this server, chooses what the board',
      '"Set up the server" would do here, says it, asks once, and does it: the board\'s address on',
      "this server through its tunnel, with the board's own record, lock, rollback and checks",
      '(/etc/agent-board). It changes nothing before you say yes, and nothing on a server the board',
      'does not set up. Safe to paste again.',
    ]),
    ...common(i),
    '# the run of each plan, as the board renders it (core/server-plan.ts buildPlan, core/server-script.ts runScript)',
    ...dispatch(
      'run',
      templates.map(x => [x.key, x.run]),
    ),
    '# what each plan says (its why, its steps)',
    ...dispatch(
      'text',
      templates.map(x => [
        x.key,
        textOf(
          x.docker ? 'docker' : '-',
          x.why,
          x.steps.map(s => s.title),
        ),
      ]),
    ),
    message('m_done', 'server.oneshot.done', 'address'),
    message('m_same', 'server.oneshot.same', 'address'),
    message('m_unfinished', 'server.oneshot.unfinished', 'state'),
    'main() {',
    '  look',
    '  P=$( { printf \'%s\\n\' "$R1"; echo \'@@ab-round2\'; printf \'%s\\n\' "$R2"; } | awk -v mode=apply "$AWKP")',
    '  plain',
    "  first=$(printf '%s\\n' \"$P\" | grep -E '^(plan|stop|same|busy|unfinished|interrupted|unreadable|refuse|internal)( |$)' | head -n 1)",
    '  rest=$(restof "$first")',
    '  case $first in',
    "  'plan '*) KEY=$rest ;;",
    `  'stop '*) say '' ${shQuote(t('server.oneshot.stop'))}; printf '%s\\n' "$P" | sed -n 's/^why /  - /p'; ${say('server.oneshot.stopHint')}; exit 1 ;;`,
    `  interrupted) say '' ${shQuote(t('server.oneshot.interrupted'))}; exit 1 ;;`,
    `  busy) say '' ${shQuote(t('server.oneshot.busy'))}; exit 1 ;;`,
    "  'unfinished '*) say ''; m_unfinished \"$rest\"; exit 1 ;;",
    "  'same '*) say ''; m_same \"$rest\"; exit 0 ;;",
    '  refuse*) m_refuse "$rest"; exit 1 ;;',
    '  internal*) m_internal "$rest"; exit 1 ;;',
    `  *) ${say('server.oneshot.unreadable')}; exit 1 ;;`,
    '  esac',
    '  run "$KEY" >/dev/null && text "$KEY" >/dev/null || { m_internal "$KEY"; exit 1; }',
    "  ADDRESS=$(printf '%s\\n' \"$P\" | sed -n 's/^address //p' | head -n 1)",
    '  PID=$(newid); RID=$(newid); AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)',
    '  V=$(printf \'%s\\nv plan_id %s\\nv run_id %s\\nv at %s\' "$P" "$PID" "$RID" "$AT")',
    '  X=$(bind "$V" text "$KEY") || { m_internal "$KEY"; exit 1; }',
    '  FLAGS=$(printf \'%s\\n\' "$X" | sed -n 1p); WHYLINE=$(printf \'%s\\n\' "$X" | sed -n 2p); TITLES=$(printf \'%s\\n\' "$X" | sed 1,2d)',
    `  say '' ${shQuote(t('server.oneshot.plan'))} "  $WHYLINE"`,
    // plainPlan: the plain plan (core/server-plain.ts, the step-1 task) goes here, in place of the step titles
    '  printf \'%s\\n\' "$TITLES" | awk \'{ printf "  %2d. %s\\n", NR, $0 }\'',
    `  if [ "$FLAGS" = docker ]; then ${say('server.oneshot.docker')}; fi`,
    "  N=$(printf '%s\\n' \"$P\" | sed -n 's/^warn /  - /p')",
    `  [ -z "$N" ] || { say '' ${shQuote(t('server.oneshot.notes'))}; printf '%s\\n' "$N"; }`,
    `  say '' ${shQuote(t('server.oneshot.unchanged'))}`,
    `  ask || { say '' ${shQuote(t('server.oneshot.no'))}; exit 1; }`,
    '  runit run',
    '  r=$?',
    "  say ''",
    '  case $r in',
    `  0) m_done "$ADDRESS"; ${say('server.oneshot.test')} ;;`,
    `  1) ${say('server.oneshot.rolledBack')} ;;`,
    `  2) ${say('server.oneshot.rollbackFailed')} ;;`,
    `  3) ${say('server.oneshot.busy')} ;;`,
    `  4) ${say('server.oneshot.changed')} ;;`,
    `  *) ${say('server.oneshot.lost')} ;;`,
    '  esac',
    '  exit $r',
    '}',
    'main </dev/null',
    MAIN_END,
    '',
  ].join('\n')
}

/** The Undo command's script. */
export function undoScriptOf(i: OneshotInput): string {
  const w = i.wanted
  const templates = undoShapes(w).map(s => undoTemplate(s, w))
  const why = t('server.oneshot.undo.what', { address: '@{rec_address}@' })
  return [
    ...head(i, [
      "agent-board: Undo as one command. It looks at this server and removes what the board's",
      "record (/etc/agent-board/setup.json) names, as the board's Undo would: their Caddyfile's line",
      "or block taken out of it as it is now, the board's containers, volumes, images and files, then",
      'the record. It changes nothing before you say yes. Docker, and files of the board you changed',
      'since, stay.',
    ]),
    ...common(i),
    '# the Undo run of each record, as the board renders it (core/server-plan.ts undoPlan, core/server-script.ts runScript)',
    ...dispatch(
      'undo',
      templates.map(x => [x.key, x.run]),
    ),
    '# what each Undo says (its steps)',
    ...dispatch(
      'text',
      templates.map(x => [
        x.key,
        textOf(
          '-',
          why,
          x.steps.map(s => s.title),
        ),
      ]),
    ),
    message('m_unknown', 'server.oneshot.undo.unknown', 'what'),
    'main() {',
    '  look',
    '  P=$( { printf \'%s\\n\' "$R1"; echo \'@@ab-round2\'; printf \'%s\\n\' "$R2"; } | awk -v mode=undo "$AWKP")',
    '  plain',
    "  first=$(printf '%s\\n' \"$P\" | grep -E '^(plan|stop|nothing|busy|unreadable|refuse|internal)( |$)' | head -n 1)",
    '  rest=$(restof "$first")',
    '  case $first in',
    "  'plan '*) KEY=$rest ;;",
    `  nothing) say '' ${shQuote(t('server.oneshot.undo.nothing'))}; exit 0 ;;`,
    `  'stop '*) say '' ${shQuote(t('server.oneshot.undo.stop'))}; printf '%s\\n' "$P" | sed -n 's/^why /  - /p'; exit 1 ;;`,
    `  busy) say '' ${shQuote(t('server.oneshot.busy'))}; exit 1 ;;`,
    '  refuse*) m_refuse "$rest"; exit 1 ;;',
    '  internal*) m_internal "$rest"; exit 1 ;;',
    `  *) ${say('server.oneshot.unreadable')}; exit 1 ;;`,
    '  esac',
    '  undo "$KEY" >/dev/null && text "$KEY" >/dev/null || { say \'\'; m_unknown "$KEY"; exit 1; }',
    '  PID=$(newid); RID=$(newid); AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)',
    '  V=$(printf \'%s\\nv plan_id %s\\nv run_id %s\\nv at %s\' "$P" "$PID" "$RID" "$AT")',
    '  X=$(bind "$V" text "$KEY") || { m_internal "$KEY"; exit 1; }',
    '  WHYLINE=$(printf \'%s\\n\' "$X" | sed -n 2p); TITLES=$(printf \'%s\\n\' "$X" | sed 1,2d)',
    '  say \'\' "$WHYLINE"',
    '  printf \'%s\\n\' "$TITLES" | awk \'{ printf "  %2d. %s\\n", NR, $0 }\'',
    `  say '' ${shQuote(t('server.oneshot.undo.kept'))} ${shQuote(t('server.oneshot.unchanged'))}`,
    `  ask || { say '' ${shQuote(t('server.oneshot.no'))}; exit 1; }`,
    '  runit undo',
    '  r=$?',
    "  say ''",
    '  case $r in',
    `  0) ${say('server.oneshot.undo.done')} ;;`,
    `  1) ${say('server.oneshot.rolledBack')} ;;`,
    `  2) ${say('server.oneshot.rollbackFailed')} ;;`,
    `  3) ${say('server.oneshot.busy')} ;;`,
    `  4) ${say('server.oneshot.changed')} ;;`,
    `  *) ${say('server.oneshot.lost')} ;;`,
    '  esac',
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
