// A plan (core/server-plan.ts) as what runs on the server and as "Do it myself": the run script
// (the steps under the server's lock, each with its timeout, a failure rolled back newest first,
// the record written as it goes), the launch that starts it detached and follows its log (calls 8
// and 10), the progress the board reads from the run's `@@` lines, and the blocks the owner copies.
// The run's steps are the plan's own lines, verbatim; `sudo` is a function there, since the run is
// root already. POSIX sh only, and only the coreutils flags GNU and Rust coreutils both take.
// Pure, with no node: import: the page renders "Do it myself" from it.
import {
  byHand,
  type Plan,
  type PlanStep,
  type RecordItem,
  type Text,
  type Wanted,
  wantedProblem,
} from './server-plan.ts'
import { shQuote } from './server-shell.ts'
import { BOARD_DIR, LOCK_FILE, RECORD_FILE, RUNS_DIR } from './server-texts.ts'

const PLAIN_ID = /^[A-Za-z0-9._-]{1,64}$/
/** A run at most 20 minutes; a skip check at most a minute. */
const RUN_MOST_S = 1200
export const SKIP_S = 60
/** A run past its 20 minutes is told to stop (TERM) and rolls back; it is killed only this much later. */
const KILL_AFTER_S = 300
/** The run's last line: the launch starts only a copy of the run that ends with it (not one cut short). */
export const LAST_LINE = '# agent-board: end'
/** What the launch says, at once, when it cannot write the run or its copy is not whole (70: sysexits' EX_SOFTWARE). */
const LAUNCH_FAILED = "{ echo '@@exit 70'; exit 70; }"
/** A step's output kept for the panel. */
const OUT_MOST = 200
/** Ends each step's text in the run, and the run in the launch: lines no step has. */
export const END = 'AGENT_BOARD_END'
const RUN_END = 'AGENT_BOARD_RUN'

function checkId(id: string): void {
  if (!PLAIN_ID.test(id)) throw new Error(`not a plain id: ${JSON.stringify(id)}`)
}

/** A variable holding text verbatim: a quoted here-document, so nothing in it is expanded. */
const verbatim = (name: string, lines: readonly string[]): string[] => [`${name}=$(cat <<'${END}'`, ...lines, END, ')']

/** Items of a step the run records only when the step ran: a group changed, a backup made, Docker installed. */
const ranOnly = (i: RecordItem): boolean => i.kind === 'group' || i.kind === 'backup' || i.kind === 'docker'
/**
 * Step 1's parts: on the record before their step runs (a run cut short names what it was making;
 * the guard saw each missing), and off it again when the step skips, finding the part there: one
 * the board did not make is never the board's to remove (an earlier run's item stays).
 */
const madeOnly = (i: RecordItem): boolean =>
  i.kind === 'user' || i.kind === 'folder' || i.kind === 'keys' || i.kind === 'fence'

/** What identifies a record item: a later step's item with the same key supersedes (or, in Undo, takes off) it. */
export const keyOf = (i: RecordItem): string =>
  i.kind === 'file'
    ? `file ${i.path}`
    : i.kind === 'line' || i.kind === 'block'
      ? `${i.kind} ${i.file}`
      : i.kind === 'backup' || i.kind === 'group' || i.kind === 'folder' || i.kind === 'keys' || i.kind === 'fence'
        ? `${i.kind} ${i.path}`
        : i.kind === 'container' || i.kind === 'volume' || i.kind === 'user'
          ? `${i.kind} ${i.name}`
          : i.kind === 'image'
            ? `image ${i.ref}`
            : 'docker'

/**
 * An item as the shell word that makes its JSON. What only the server knows is filled in there: a
 * file's sha256 as written, whether an image was there before (the step that pulls it skipped), the
 * run a container was made by.
 */
export function itemWord(i: RecordItem, live: boolean): string {
  const json = JSON.stringify(i)
  if (!live) return shQuote(json)
  if (i.kind === 'file') {
    const head = JSON.stringify({ kind: 'file', path: i.path, sha256: '' }).slice(0, -2)
    return `${shQuote(head)}"$(sudo cat ${shQuote(i.path)} | sha256sum | cut -c1-64)"${shQuote('"}')}`
  }
  if (i.kind === 'image') {
    const head = JSON.stringify({ kind: 'image', ref: i.ref, before: false }).slice(0, -6)
    return `${shQuote(head)}"$SKIP"'}'`
  }
  if (i.kind === 'container') {
    const head = JSON.stringify({ kind: 'container', name: i.name, setup: '' }).slice(0, -2)
    const setup = `$(sudo docker inspect -f '{{index .Config.Labels "agent-board.setup"}}' ${shQuote(i.name)} 2>/dev/null)`
    return `${shQuote(head)}"${setup}"${shQuote('"}')}`
  }
  return shQuote(json)
}

/**
 * An item as recorded before its step runs, so a run cut short (killed, a reboot) leaves a record
 * that names what it was changing: a file's hash as it is before the step (Undo removes it only
 * when the step did not get to change it), an image as if there before (an Undo after a pull cut
 * short keeps it), the rest as the plan has it. The step's own values replace these after it.
 */
export function aheadWord(i: RecordItem): string {
  if (i.kind === 'file') {
    const head = JSON.stringify({ kind: 'file', path: i.path, sha256: '' }).slice(0, -2)
    return `${shQuote(head)}"$(sudo cat ${shQuote(i.path)} 2>/dev/null | sha256sum | cut -c1-64)"${shQuote('"}')}`
  }
  if (i.kind === 'image') return shQuote(JSON.stringify({ ...i, before: true }))
  return itemWord(i, false)
}

/**
 * The script the board runs as root for a plan (Apply, an update or Undo). Each step: `@@step <n>
 * start`, then `skip` when its skipIf all hold, else its commands and check under `timeout`, `ok`
 * or `fail`; Undo's by-hand step is only said skipped, its commands left out. A failure runs the
 * failed step's undo and the done steps', newest first (`@@undo <n> ok|fail`), then `@@result
 * rolled-back|rollback-failed`; all done gives `@@result applied`. The
 * first step (the guard) changes nothing: when it fails, nothing is rolled back or recorded and the
 * run exits 3. The record is written as `running` after it, before each step with what the step
 * will change, and after each step with what it did; a record that cannot be written rolls the run
 * back (right after the guard: exits 3, nothing changed). HUP, INT or TERM (the overall timeout, a
 * shutdown) let the current step end, then roll back. A trap writes the run's exit status beside its
 * log. What the panel wants is checked first: nothing is made from values that fail their checks.
 */
export function runScript(p: Plan, w: Wanted, run: { id: string; at: string }): string {
  const problem = wantedProblem(w)
  if (problem) throw new Error(problem)
  checkId(p.id)
  checkId(run.id)
  const undo = p.kind === 'undo'
  const n = p.steps.length
  const exitFile = `${RUNS_DIR}/${run.id}.exit`
  const backups = `${BOARD_DIR}/backups/${p.id}`
  // The record's items: the first step's carried over (I1…), then each later step's own.
  const vars: { step: number; item: RecordItem; name: string }[] = []
  p.steps.forEach((s, i) => {
    if (undo && i > 0) return
    for (const item of s.record) vars.push({ step: i + 1, item, name: `I${vars.length + 1}` })
  })
  const carried = vars.filter(v => v.step === 1)
  /** The carried items a later step names: superseded by it (Apply) or taken off by it (Undo). */
  const named = (step: PlanStep): string[] => {
    const keys = new Set(step.record.map(keyOf))
    return carried.filter(v => keys.has(keyOf(v.item))).map(v => v.name)
  }
  const domain = new URL(p.address).hostname
  const head = `${JSON.stringify({ v: 1, id: run.id, at: run.at }).slice(0, -1)},"state":"`
  const mid = `${JSON.stringify({
    case: p.case,
    pair: { user: w.user, socket: w.socket, ...(w.server && { server: true }) },
    domain,
    publicPort: p.publicPort,
    address: p.address,
  }).slice(1, -1)},"items":[`
  // The record, written whole or not at all: non-zero when any part fails (a full disk, /etc read-only).
  const recordFn = [
    'record() {',
    "  it=''",
    ...(vars.length
      ? [`  for x in ${vars.map(v => `"$${v.name}"`).join(' ')}; do if [ -n "$x" ]; then it="$it,$x"; fi; done`]
      : []),
    `  printf '%s%s%s%s%s\\n' ${shQuote(head)} "$1" ${shQuote(`",${mid}`)} "\${it#,}" ']}' > ${RECORD_FILE}.new &&`,
    `    [ "$(tail -c 3 ${RECORD_FILE}.new)" = ']}' ] && chmod 644 ${RECORD_FILE}.new && mv -f ${RECORD_FILE}.new ${RECORD_FILE}`,
    '}',
  ]
  const unrecorded = `echo ${shQuote(`The record ${RECORD_FILE} could not be written.`)}`
  // An Apply over an earlier setup that rolls back leaves the server as that setup was: its record back.
  const restoresOld = !undo
  const superseded = undo ? [] : [...new Set(p.steps.slice(1).flatMap(named))]
  const old = shQuote(`${backups}/setup.json`)
  // A record that cannot say how the run ended: the rollback is reported failed (Look finds the run
  // interrupted, and its Undo is safe to run again); an Apply that cannot record it was applied rolls back.
  const finishFn = [
    'finish() {',
    '  case $1 in',
    `  applied) ${[...superseded.map(v => `${v}=''`), undo ? `rm -f ${RECORD_FILE}` : `record applied || { ${unrecorded}; back; }`].join('; ')} ;;`,
    restoresOld
      ? `  rolled-back) { if [ -f ${old} ]; then cp -p ${old} ${RECORD_FILE}.new && mv -f ${RECORD_FILE}.new ${RECORD_FILE}; else record rolled-back; fi; } || { ${unrecorded}; set -- rollback-failed; } ;;`
      : `  rolled-back) record rolled-back || { ${unrecorded}; set -- rollback-failed; } ;;`,
    `  *) record "$1" || ${unrecorded} ;;`,
    '  esac',
    '  echo "@@result $1"',
    '  case $1 in applied) exit 0 ;; rolled-back) exit 1 ;; *) exit 2 ;; esac',
    '}',
  ]
  // Rollback, newest first: a step that ran (the failed one too) has its undo run; its items come
  // off the record when that works (Docker's stays: a finished install is kept, call 20).
  const backLines: string[] = []
  for (let i = n - 1; i >= 1; i--) {
    const s = p.steps[i] as PlanStep
    const k = i + 1
    const own = vars.filter(v => v.step === k && v.item.kind !== 'docker').map(v => `${v.name}=''`)
    const back = undo
      ? named(s).map(name => `${name}=${itemWord(carried.find(v => v.name === name)?.item as RecordItem, false)}`)
      : own
    if (s.undo.length) {
      const ok = back.length ? `${back.join('; ')}; ` : ''
      backLines.push(
        `  if [ "$D${k}" = 1 ]; then if undo ${k} ${s.timeoutS} "$U${k}"; then ${ok}:; else R=rollback-failed; fi; fi`,
      )
    } else if (!undo && own.length) backLines.push(`  if [ "$D${k}" = 1 ]; then ${own.join('; ')}; fi`)
  }
  const out: string[] = [
    'exec </dev/null',
    '# agent-board: run',
    'set -u',
    'umask 077',
    'sudo() { "$@"; }',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    'LC_ALL=C; export LC_ALL',
    `trap 'echo "$?" > ${exitFile}' EXIT`,
    // told to stop: the step going on ends first (sh waits for it), then everything rolls back
    'STOP=0',
    "trap 'STOP=1' HUP INT TERM",
    `exec 9>${LOCK_FILE}`,
    "flock -n 9 || { echo '@@busy'; exit 75; }",
    "P='set -e",
    'sudo() { "$@"; }',
    "'",
    'SKIP=false',
    ...(vars.length ? [vars.map(v => `${v.name}=''`).join(' ')] : []),
    ...(n > 1
      ? [
          p.steps
            .slice(1)
            .map((_, i) => `D${i + 2}=0`)
            .join(' '),
        ]
      : []),
  ]
  p.steps.forEach((s, i) => {
    const k = i + 1
    // the owner's commands (userdel…) are not in the run at all: no failed skip check can run them
    if (byHand(s)) return
    out.push(`# ${k}: ${s.id}`, ...verbatim(`S${k}`, [...s.commands, ...s.check]))
    if (s.skipIf.length)
      out.push(
        ...verbatim(
          `K${k}`,
          s.skipIf.map(l => `${l} || exit 1`),
        ),
      )
    if (s.undo.length) out.push(...verbatim(`U${k}`, s.undo))
  })
  out.push(
    ...recordFn,
    'run() {',
    '  echo "@@step $1 start"',
    `  if [ -n "$3" ] && timeout -k 5 ${SKIP_S} sh -c "$P$3" >/dev/null 2>&1 9>&-; then echo "@@step $1 skip"; SKIP=true; return 0; fi`,
    '  if timeout -k 5 "$2" sh -c "$P$4" 9>&-; then echo "@@step $1 ok"; SKIP=false; return 0; fi',
    '  echo "@@step $1 fail"',
    '  return 1',
    '}',
    'undo() {',
    '  if timeout -k 5 "$2" sh -c "$P$3" 9>&-; then echo "@@undo $1 ok"; return 0; fi',
    '  echo "@@undo $1 fail"',
    '  return 1',
    '}',
    ...finishFn,
    'back() {',
    '  R=rolled-back',
    ...backLines,
    '  finish "$R"',
    '}',
    'halt() {',
    `  if [ "$STOP" = 1 ]; then echo ${shQuote('The run was told to stop: what it did is rolled back.')}; back; fi`,
    '}',
  )
  // The guard: nothing done yet, so nothing to roll back or record (a stop or a record that cannot
  // be written ends the run here, with nothing changed).
  const guard = p.steps[0]
  if (guard) {
    const unchanged = (why: string): string => `{ echo ${shQuote(`${why}: nothing was changed.`)}; exit 3; }`
    out.push(`run 1 ${guard.timeoutS} '' "$S1" || exit 3`)
    out.push('if [ "$STOP" = 1 ]; then exit 143; fi')
    out.push(
      `if [ -f ${RECORD_FILE} ]; then { install -d -m 700 ${shQuote(backups)} && cp -p ${RECORD_FILE} ${old}; } || ${unchanged(`The record ${RECORD_FILE} could not be copied`)}; fi`,
    )
    for (const v of carried) out.push(`${v.name}=${itemWord(v.item, false)}`)
    out.push(`record running || ${unchanged(`The record ${RECORD_FILE} could not be written`)}`)
  }
  let recording = true
  p.steps.forEach((s, i) => {
    if (i === 0) return
    const k = i + 1
    // told to stop: no next step (after Undo's `forget` there is nothing left to roll back to)
    if (recording) out.push('halt')
    if (byHand(s)) {
      out.push(`echo '@@step ${k} start'; echo '@@step ${k} skip'`)
      return
    }
    // what the step will change, on the record before it runs (off it again when that cannot be written)
    const ahead = undo ? [] : vars.filter(v => v.step === k && !ranOnly(v.item))
    if (ahead.length)
      out.push(
        ahead.map(v => `${v.name}=${aheadWord(v.item)}`).join('; '),
        `record running || { ${ahead.map(v => `${v.name}=''`).join('; ')}; back; }`,
      )
    out.push(`D${k}=1; run ${k} ${s.timeoutS} ${s.skipIf.length ? `"$K${k}"` : "''"} "$S${k}" || back`)
    out.push(`if [ "$SKIP" = true ]; then D${k}=0; fi`)
    if (undo) {
      const off = named(s)
      if (off.length) out.push(off.map(name => `${name}=''`).join('; '))
    } else {
      for (const v of vars.filter(x => x.step === k)) {
        const set = `${v.name}=${itemWord(v.item, true)}`
        // A step that skips because an earlier run of the board did its work (Apply again) keeps
        // that run's item: an image it pulled stays the board's (Undo removes it), not "there
        // before"; the folder's group keeps what it was before the board (Undo puts that back).
        const earlier =
          v.item.kind === 'image' || ranOnly(v.item) || madeOnly(v.item)
            ? carried.find(c => keyOf(c.item) === keyOf(v.item) && c.step !== k)
            : undefined
        const keep = earlier ? `elif [ -n "$${earlier.name}" ]; then ${v.name}=$${earlier.name}; ` : ''
        out.push(
          ranOnly(v.item)
            ? `if [ "$SKIP" = false ]; then ${set}; ${keep}fi`
            : madeOnly(v.item)
              ? `if [ "$SKIP" = false ]; then ${set}; ${keep}else ${v.name}=''; fi`
              : earlier
                ? `if [ "$SKIP" = false ]; then ${set}; ${keep}else ${set}; fi`
                : set,
        )
      }
    }
    // Undo's last steps take the record away with the rest of the board's files.
    if (undo && s.id === 'forget') recording = false
    if (recording) out.push('record running || back')
  })
  out.push(...(recording ? ['halt'] : []), 'finish applied', LAST_LINE, '')
  return out.join('\n')
}

/**
 * What the admin line runs for Apply or Undo (as root): the run written to runs/<id>.sh (0600) and
 * started only when that copy ends with the run's last line, else `@@exit 70` at once; started with
 * setsid apart from the connection (output to runs/<id>.log; after 20 minutes told to stop, so it
 * rolls back, and killed 5 minutes later; its exit status in runs/<id>.exit), then its log followed
 * once a second, POSIX only, until that file is there; then `@@exit <code>` (at most 26 minutes
 * after the start). The newest five runs are kept. When a run leaves no record and no
 * backups (an Undo done, or a run that stopped before changing anything), /etc/agent-board goes,
 * under the lock.
 *
 * The run travels in a quoted here-document, verbatim, not in base64 again: the admin line sends
 * this script in base64 already, and twice base64 makes the biggest plans' command longer than a
 * Windows command line takes (32,767 characters). With `pack` (gzip, then base64: the board's
 * service gives node's, as this module has no node: import) it travels packed on one line and is
 * unpacked there (`base64 -d | gunzip`): a third of its size, which the plans that make step 1 too
 * need. Either way the copy on the server runs only when it ends with the run's last line.
 */
export function launchScript(runId: string, run: string, pack?: (text: string) => string): string {
  checkId(runId)
  const lines = run.replace(/\n$/, '').split('\n')
  if (lines.includes(RUN_END)) throw new Error('the run holds its own end line')
  if (lines.at(-1) !== LAST_LINE) throw new Error('the run does not end with its last line')
  const packed = pack?.(`${lines.join('\n')}\n`)
  if (packed !== undefined && !/^[A-Za-z0-9+/]+={0,2}$/.test(packed)) throw new Error('the packed run is not base64')
  const copy =
    packed === undefined
      ? [`cat > "$R.sh" <<'${RUN_END}'`, ...lines, RUN_END]
      : [`printf '%s\\n' '${packed}' | base64 -d | gunzip > "$R.sh" || ${LAUNCH_FAILED}`]
  const r = `${RUNS_DIR}/${runId}`
  return [
    'exec </dev/null',
    '# agent-board: launch',
    'set -u',
    'umask 077',
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH',
    `R=${r}`,
    // nothing to follow unless the run is written whole: `@@exit 70` at once, not after 26 minutes
    `mkdir -p ${RUNS_DIR} || ${LAUNCH_FAILED}`,
    'rm -f "$R.log" "$R.exit"',
    ...copy,
    `[ "$(tail -n 1 "$R.sh")" = ${shQuote(LAST_LINE)} ] || ${LAUNCH_FAILED}`,
    `chmod 600 "$R.sh" || ${LAUNCH_FAILED}`,
    `: > "$R.log" || ${LAUNCH_FAILED}`,
    `for f in $(ls -t ${RUNS_DIR} | grep '\\.sh$' | sed -n '6,$p'); do rm -f "${RUNS_DIR}/\${f%.sh}".*; done`,
    `setsid -w sh -c 'timeout -k ${KILL_AFTER_S} ${RUN_MOST_S} sh "$1.sh"; c=$?; [ -s "$1.exit" ] || echo "$c" > "$1.exit"' sh "$R" >"$R.log" 2>&1 </dev/null &`,
    'n=0; s=0',
    `while [ ! -s "$R.exit" ] && [ "$s" -lt ${RUN_MOST_S + KILL_AFTER_S + 60} ]; do`,
    '  t=$(wc -l < "$R.log")',
    '  if [ "$t" -gt "$n" ]; then sed -n "$((n + 1)),$((t))p" "$R.log"; n=$t; fi',
    '  sleep 1; s=$((s + 1))',
    'done',
    'sed -n "$((n + 1)),\\$p" "$R.log"',
    'c=$(cat "$R.exit" 2>/dev/null || true)',
    `if [ ! -e ${RECORD_FILE} ] && [ ! -e ${BOARD_DIR}/backups ]; then flock -n ${LOCK_FILE} rm -rf ${BOARD_DIR}; fi`,
    'if [ -z "$c" ]; then c=124; fi',
    'echo "@@exit $c"',
    '',
  ].join('\n')
}

export interface StepProgress {
  n: number
  id: string
  state: 'waiting' | 'running' | 'ok' | 'fail' | 'skipped'
  since: number | null
  out: string[]
}
export interface Progress {
  steps: StepProgress[]
  undo: { n: number; ok: boolean }[]
  result: 'applied' | 'rolled-back' | 'rollback-failed' | 'busy' | 'changed' | null
  exit: number | null
}

/** Every step waiting. */
export function startProgress(p: Plan): Progress {
  return {
    steps: p.steps.map((s, i) => ({ n: i + 1, id: s.id, state: 'waiting', since: null, out: [] })),
    undo: [],
    result: null,
    exit: null,
  }
}

const STEP = /^@@step (\d+) (start|ok|fail|skip)$/
const UNDO = /^@@undo (\d+) (ok|fail)$/
const RESULT = /^@@result (applied|rolled-back|rollback-failed)$/
const EXIT = /^@@exit (-?\d+)$/
const STATE = { start: 'running', ok: 'ok', fail: 'fail', skip: 'skipped' } as const

/** A line the run itself prints (a step's state, an undo, its result, its exit, busy, a change found), as against a step's output. */
export function runLine(line: string): boolean {
  const text = line.replace(/\r$/, '')
  return (
    STEP.test(text) ||
    UNDO.test(text) ||
    RESULT.test(text) ||
    EXIT.test(text) ||
    text === '@@busy' ||
    text.startsWith('@@changed ')
  )
}

/** The progress after one line of the run (a new value; the old one is left as it was). */
export function readProgress(pr: Progress, line: string, now: number): Progress {
  const text = line.replace(/\r$/, '')
  const step = STEP.exec(text)
  if (step) {
    const n = Number(step[1])
    const state = STATE[step[2] as keyof typeof STATE]
    return {
      ...pr,
      steps: pr.steps.map(s => (s.n === n ? { ...s, state, since: state === 'running' ? now : s.since } : s)),
    }
  }
  const undo = UNDO.exec(text)
  if (undo) return { ...pr, undo: [...pr.undo, { n: Number(undo[1]), ok: undo[2] === 'ok' }] }
  const result = RESULT.exec(text)
  if (result) return { ...pr, result: result[1] as Progress['result'] }
  const exit = EXIT.exec(text)
  if (exit) return { ...pr, exit: Number(exit[1]) }
  if (text === '@@busy') return { ...pr, result: 'busy' }
  if (text.startsWith('@@changed ')) return { ...pr, result: 'changed' }
  // Output: the step started last has it (during a rollback, the step that failed).
  const current = [...pr.steps].reverse().find(s => s.since !== null)
  if (!current) return pr
  return {
    ...pr,
    steps: pr.steps.map(s => (s === current ? { ...s, out: [...s.out, text].slice(-OUT_MOST) } : s)),
  }
}

/** A step as the owner runs it by hand: its title, why, commands, what to check after, how to undo it. */
export interface ManualBlock {
  title: Text
  why: Text
  commands: string
  check: string
  undo: string
}

/** "Do it myself": one block per step, the same lines the run has. */
export function doItMyself(p: Plan): ManualBlock[] {
  return p.steps.map(s => ({
    title: s.title,
    why: s.why,
    commands: s.commands.join('\n'),
    check: s.check.join('\n'),
    undo: s.undo.join('\n'),
  }))
}
