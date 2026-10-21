// Step 3 of "On the server" in the Remote access panel's Tunnel part: the web server in front of
// the tunnel. The admin connection's user and key (config.json tunnel.admin, saved as a field is
// left), Look (it reads and changes nothing), sudo's password once sudo asks for one, what Look
// found and the case, the plan with Apply (off until Docker's tick when it installs Docker), a run
// step by step, a failure with what was rolled back, the setup on record with its two-click Undo
// and the Undo plan, and "Do it myself" (DoItMyself.tsx) with Look or without. Its words are
// models/server-setup.ts's. What it keeps while the panel is open (SetupState: the password, the
// ticks, what is open) is ServerSetup's own state, drawn anew as the panel closes; the board's side
// is the `server-*` ops of POST /api/access.
import { type FocusEvent, type KeyboardEvent, useEffect, useState } from 'react'
import type { AccessView } from '../../../../src/core/access.ts'
import type { Plan } from '../../../../src/core/server-plan.ts'
import type { Progress } from '../../../../src/core/server-script.ts'
import type { ServerView } from '../../../../src/core/server-view.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { hintText, stepLine } from '../../models/access.ts'
import {
  adminEdit,
  asksPassword,
  caseLine,
  failHint,
  foundLines,
  hintLine,
  manualReasons,
  resultLine,
  rollbackLines,
  SERVER_IDLE,
  SETUP_START,
  type SetupState,
  setupLine,
  stepState,
  stepTitle,
  textLine,
  tickPatch,
  touchLine,
  undoLine,
  wantedOf,
  withPassword,
} from '../../models/server-setup.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { DoItMyself } from './DoItMyself.tsx'
import { TwoClicks } from './LoginSection.tsx'

export interface ServerSetupProps {
  view: AccessView
  send: AccessSend
}

export interface ServerSetupBodyProps extends ServerSetupProps {
  /** What the part keeps while the panel is open, and how it changes (a patch, merged). */
  state: SetupState
  onState(patch: Partial<SetupState>): void
  /** The clock a running step's seconds count to. */
  now: number
}

/** While a step runs on the server, its seconds move on: drawn again this often. */
const RUN_TICK_MS = 1000

export function ServerSetup({ view, send }: ServerSetupProps) {
  const { now } = useBoardContext()
  const [state, setState] = useState<SetupState>(SETUP_START)
  const [tick, setTick] = useState(0)
  const phase = view.server?.phase
  const running = phase === 'applying' || phase === 'undoing'
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick(Date.now()), RUN_TICK_MS)
    return () => clearInterval(id)
  }, [running])
  return (
    <ServerSetupBody
      view={view}
      send={send}
      state={state}
      onState={patch => setState(s => ({ ...s, ...patch }))}
      now={Math.max(now, tick)}
    />
  )
}

/** The first step that failed in a run, with its number. */
const failedOf = (p: Progress | null) => p?.steps.find(s => s.state === 'fail') ?? null

/** The part for a view and what it keeps (what the tests draw). */
export function ServerSetupBody({ view, send, state, onState, now }: ServerSetupBodyProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const s = view.server ?? SERVER_IDLE
  const { phase, plan, progress, facts, choice } = s
  const admin = s.admin.user
  const running = phase === 'applying' || phase === 'undoing'
  const busy = running || phase === 'looking'
  const password = asksPassword(s, state)
  const lookWhy = !admin
    ? t('server.panel.needAdmin')
    : !view.tunnel.hostKey
      ? t('server.panel.needHostKey')
      : !view.tunnel.ssh
        ? hintText('noSsh', t)
        : ''
  const canLook = canEdit && !busy && lookWhy === ''
  const failed = failedOf(progress)
  const hint = hintLine(s.hint, t, admin) || (failed ? failHint(failed.id, t) : '')

  /** Look (or Undo's Look): with the password once typed; sudo wanting one opens its field. */
  async function look(op: SetupState['again']): Promise<void> {
    const reply = await send(op, withPassword(state))
    if (reply?.need === 'password') onState({ asked: true, again: op })
  }

  async function run(p: Plan): Promise<void> {
    const ticks =
      p.kind === 'undo'
        ? {
            ...(p.ticks.includes('removeDocker') && { removeDocker: state.removeDocker }),
            ...(p.ticks.includes('removeEdited') && { removeEdited: state.removeEdited }),
          }
        : { ...(p.ticks.includes('docker') && { docker: state.docker }) }
    const reply = await send(p.kind === 'undo' ? 'server-undo' : 'server-apply', {
      plan: p.id,
      ...ticks,
      ...withPassword(state),
    })
    if (reply?.need === 'password') onState({ asked: true })
  }

  /** An admin field left: what changed goes to the board; refused or the same, the board's value shows again. */
  async function saveAdmin(field: 'user' | 'key', input: HTMLInputElement): Promise<void> {
    const before = s.admin[field]
    const edit = adminEdit(before, input.value)
    if (edit === null) {
      input.value = before
      return
    }
    const reply = await send('server-admin', field === 'user' ? { user: edit } : { key: edit })
    if (reply?.ok !== true) input.value = before
  }

  const keyDown = (field: 'user' | 'key') => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      // The field's own: the panel stays open.
      e.stopPropagation()
      e.currentTarget.value = s.admin[field]
      e.currentTarget.blur()
    }
  }

  const manualButton = (
    <button
      type="button"
      className={classNames('button', state.manual && 'primary')}
      disabled={!canEdit}
      onClick={() => onState({ manual: !state.manual })}
    >
      {t('server.panel.doItMyself')}
    </button>
  )
  const lookButton = (label: string) => (
    <button type="button" className="button primary" disabled={!canLook} onClick={() => void look('server-look')}>
      {phase === 'looking' ? t('server.panel.looking') : label}
    </button>
  )
  const needs = (p: Plan): boolean =>
    (p.ticks.includes('docker') && !state.docker) || (password && state.password === '')
  const ran = plan && progress && (running || phase === 'done' || phase === 'failed')
  // With a plan shown, its Apply or Undo takes the password; else Continue looks with it.
  const goOn = phase !== 'plan' && !running
  const lookWhyLine = lookWhy && <p className="access-look-why">{lookWhy}</p>

  return (
    <div className="access-web">
      <p className="access-note">{t('server.panel.webNote')}</p>
      <div className="access-fields">
        {(['user', 'key'] as const).map(field => {
          const label = t(field === 'user' ? 'server.panel.adminUser' : 'server.panel.adminKey')
          const value = s.admin[field]
          return (
            <div className="access-admin" key={field}>
              <label className="access-field">
                <span>{label}</span>
                <input
                  // Drawn again with the board's value once it changes (uncontrolled: what is typed stays until then).
                  key={value}
                  className="path-add"
                  name={`admin-${field}`}
                  aria-label={label}
                  placeholder={t(field === 'user' ? 'server.panel.adminUserHint' : 'server.panel.adminKeyHint')}
                  defaultValue={value}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={!canEdit}
                  onKeyDown={keyDown(field)}
                  onBlur={(e: FocusEvent<HTMLInputElement>) => void saveAdmin(field, e.currentTarget)}
                />
              </label>
            </div>
          )
        })}
      </div>

      {s.setup && (phase === 'idle' || phase === 'done' || phase === 'failed') && (
        <div className="access-setup">
          <p className="access-done">{setupLine(s.setup, t)}</p>
          <div className="access-actions">
            <TwoClicks
              armed={state.undoArmed}
              label={t('server.panel.undo')}
              sure={t('server.panel.undoSure')}
              disabled={!canLook}
              onArm={() => onState({ undoArmed: true })}
              onDisarm={() => onState({ undoArmed: false })}
              onSure={() => void look('server-undo-look')}
            />
          </div>
        </div>
      )}

      {(phase === 'idle' || phase === 'looking' || phase === 'done') && (
        <>
          <div className="access-actions">
            {lookButton(t('server.panel.look'))}
            {manualButton}
          </div>
          {lookWhyLine}
        </>
      )}

      {password && (
        <div className="access-sudo">
          <p className="access-line">{t('server.panel.sudoAsks', { admin })}</p>
          <div className="access-actions">
            <input
              type="password"
              className="path-add access-input"
              name="sudo-password"
              aria-label={t('server.panel.sudoAsks', { admin })}
              // Uncontrolled: the typed password never becomes an attribute of the page.
              defaultValue=""
              autoComplete="off"
              spellCheck={false}
              disabled={!canEdit}
              onChange={e => onState({ password: e.currentTarget.value })}
              onKeyDown={e => {
                if (e.key === 'Enter' && goOn && state.password !== '' && canLook) void look(state.again)
              }}
            />
            {goOn && (
              <button
                type="button"
                className="button"
                disabled={!canLook || state.password === ''}
                onClick={() => void look(state.again)}
              >
                {t('server.panel.continue')}
              </button>
            )}
          </div>
          <p className="access-tip">{t('server.panel.sudoNote')}</p>
        </div>
      )}

      {phase !== 'failed' && hint && <p className="access-hint">{hint}</p>}
      {phase !== 'failed' && s.error && <p className="access-why">{s.error}</p>}

      {facts && (
        <div className="access-found">
          <h4 className="access-sub">{t('server.panel.found')}</h4>
          <ul className="access-facts">
            {foundLines(facts, t, wantedOf(view.tunnel.settings).user).map(line => (
              <li className="access-fact" key={line}>
                {line}
              </li>
            ))}
          </ul>
          {choice && choice.case !== null && <p className="access-case">{caseLine(choice, t)}</p>}
          {choice && choice.case === null && (
            <>
              <p className="access-sub">{t('server.panel.manualWhy')}</p>
              <ul className="access-facts">
                {manualReasons(choice, t).map(line => (
                  <li className="access-reason" key={line}>
                    {line}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan && <p className="access-address">{t('server.panel.address', { address: plan.address })}</p>}
        </div>
      )}

      {plan && (
        <PlanSteps
          plan={plan}
          progress={ran ? progress : null}
          phase={phase}
          state={state}
          onState={onState}
          now={now}
        />
      )}

      {phase === 'plan' && (
        <div className="access-actions">
          {plan && plan.kind !== 'nothing' && (
            <button
              type="button"
              className="button primary"
              disabled={!canEdit || needs(plan)}
              onClick={() => void run(plan)}
            >
              {t(plan.kind === 'undo' ? 'server.panel.undo' : 'server.panel.apply')}
            </button>
          )}
          {manualButton}
          <button type="button" className="button" disabled={!canEdit} onClick={() => void send('server-cancel')}>
            {t('access.cancel')}
          </button>
        </div>
      )}

      {phase === 'failed' && (
        <div className="access-failure">
          {failed && (
            <p className="access-warn">
              {t('server.panel.failedAt', { n: failed.n, title: stepTitle(plan, progress, failed.n, t) })}
            </p>
          )}
          {hint && <p className="access-hint">{hint}</p>}
          {s.error && <p className="access-why">{s.error}</p>}
          {progress && progress.undo.length > 0 && (
            <>
              <p className="access-sub">{t('server.panel.rolledBack')}</p>
              <ul className="access-facts">
                {rollbackLines(progress, plan, t).map(({ n, line }) => (
                  <li className="access-rolled" key={n}>
                    {line}
                  </li>
                ))}
              </ul>
            </>
          )}
          {progress && resultLine(progress, t) && <p className="access-result">{resultLine(progress, t)}</p>}
          <div className="access-actions">
            {lookButton(t('server.panel.lookAgain'))}
            {manualButton}
          </div>
          {lookWhyLine}
        </div>
      )}

      {phase === 'done' && plan?.kind === 'undo' && <p className="access-result">{t('server.panel.undone')}</p>}
      {phase === 'done' && s.testAfter && (
        <div className="access-test-after">
          <p className="access-sub">{t('server.panel.testAfter')}</p>
          <ul className="access-steps access-after">
            {s.testAfter.map(step => (
              <li key={step.id}>
                <span className="access-step">{stepLine(step, t)}</span>
                {step.ok === false && step.hint && <p className="access-hint">{hintText(step.hint, t)}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.manual && <DoItMyself view={view} state={state} onState={onState} />}
    </div>
  )
}

interface PlanStepsProps {
  plan: Plan
  /** The run's, once one ran; null while the plan waits for Apply. */
  progress: Progress | null
  phase: ServerView['phase']
  state: SetupState
  onState(patch: Partial<SetupState>): void
  now: number
}

/** The plan's numbered steps, each with why and what it touches; during and after a run its state and output. */
function PlanSteps({ plan, progress, phase, state, onState, now }: PlanStepsProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const head =
    phase === 'applying'
      ? 'server.panel.applying'
      : phase === 'undoing'
        ? 'server.panel.undoing'
        : progress
          ? 'server.panel.ran'
          : plan.kind === 'undo'
            ? 'server.panel.undoPlan'
            : 'server.panel.plan'
  const waiting = phase === 'plan'
  const undo = waiting ? undoLine(plan, t) : ''
  return (
    <div className="access-plan">
      <h4 className="access-sub">{t(head)}</h4>
      {waiting && plan.kind === 'nothing' && <p className="access-nothing">{t('server.panel.nothing')}</p>}
      {waiting && plan.relies.length > 0 && (
        <p className="access-relies">{t('server.panel.relies', { relies: plan.relies.join(' · ') })}</p>
      )}
      <ol className="access-plan-steps">
        {plan.steps.map((step, i) => {
          const n = i + 1
          const done = progress?.steps.find(x => x.n === n)
          return (
            <li className="access-plan-step" key={`${n}-${step.id}`}>
              <div className="access-step-line">
                <span className="access-num">{n}</span>
                <span className="access-title">{textLine(step.title, t)}</span>
                {progress && (
                  <span className={classNames('access-state', done?.state === 'fail' && 'access-bad')}>
                    {stepState(progress, n, now, t)}
                  </span>
                )}
              </div>
              <p className="access-why-step">{textLine(step.why, t)}</p>
              {step.touches.length > 0 && <p className="access-touches">{touchLine(step.touches, t)}</p>}
              {done && done.out.length > 0 && (
                <details className="access-out" open={done.state === 'fail'}>
                  <summary className="access-summary">{t('server.panel.output')}</summary>
                  <pre className="access-pre">
                    <code>{done.out.join('\n')}</code>
                  </pre>
                </details>
              )}
            </li>
          )
        })}
      </ol>
      {undo && <p className="access-undo-line">{undo}</p>}
      {waiting &&
        plan.warnings.map(w => (
          <p className="access-caution" key={w.key}>
            {textLine(w, t)}
          </p>
        ))}
      {waiting &&
        plan.ticks.map(tick => (
          <label className="access-tick" key={tick}>
            <input
              type="checkbox"
              name={`tick-${tick}`}
              checked={state[tick]}
              disabled={!canEdit}
              onChange={() => onState(tickPatch(tick, state))}
            />
            <span>{t(`server.panel.tick.${tick}`)}</span>
          </label>
        ))}
    </div>
  )
}
