// "On the server" in the Remote access panel's Tunnel part, as one flow (the simple-setup spec's
// "The flow, as the owner sees it"): the board's address and the server (the Tunnel part's fields,
// passed in), the login (root unless another is saved) and its password, a key file folded, and
// Set up the server, which fills in what the owner need not type (the server from the address,
// the board's own login on the server, the board's key) and Looks. Then the plan in plain words:
// what was found with the server's key, what will be done, Docker's install to tick, what is not
// touched, the full plan under Details; Apply or Cancel; a run step by step, a failure with what
// was rolled back; the setup on record with Undo, which asks for the password again, the login's
// fields folded away. sudo's own field shows only when an answer asks for it. For a server the
// board does not do, why in one line, and the steps by hand folded (DoItMyself.tsx, Snippets.tsx).
// "Do it myself (one command)" is OneCommand.tsx. Its words are models/server-setup.ts's. What it
// keeps while the panel is open (SetupState: the passwords, the ticks, what is open) is
// ServerSetup's own state, drawn anew as the panel closes; the board's side is the `server-*` ops
// of POST /api/access.
import { type FocusEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { AccessView } from '../../../../src/core/access.ts'
import type { Plan } from '../../../../src/core/server-plan.ts'
import type { Progress } from '../../../../src/core/server-script.ts'
import type { ServerView } from '../../../../src/core/server-view.ts'
import type { TestStep, TunnelConfig } from '../../../../src/core/tunnel.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { hintText, stepLine } from '../../models/access.ts'
import { loadOneshot, oneshotStamp, oneshotTest } from '../../models/server-oneshot.ts'
import {
  adminEdit,
  answerPatch,
  caseLine,
  DEFAULT_LOGIN,
  failHint,
  flowFill,
  foundLines,
  hintLine,
  hostKeyLine,
  isPlainWarning,
  loginFolded,
  manualReasons,
  neededField,
  plainOf,
  resultLine,
  rollbackLines,
  type Saves,
  SERVER_IDLE,
  SETUP_START,
  type SetupState,
  savesTracker,
  setupLine,
  stepState,
  stepTitle,
  sudoField,
  type Tick,
  type Took,
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
import { OneCommand } from './OneCommand.tsx'
import { Snippets } from './Snippets.tsx'

export interface ServerSetupProps {
  view: AccessView
  send: AccessSend
  /** Test connection's last steps, and whether one runs: "Do it myself" shows them under its own Test connection. */
  steps?: TestStep[] | null
  testing?: boolean
  /** The flow's fields that are the tunnel's settings (the board's address, the server and its port), drawn by the Tunnel part. */
  fields?: ReactNode
  /** The Tunnel part's saves on their way: Set up the server waits for them. */
  saves?: Saves
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

export function ServerSetup(props: ServerSetupProps) {
  const t = useT()
  const { now } = useBoardContext()
  const [state, setState] = useState<SetupState>(SETUP_START)
  const [own] = useState(savesTracker)
  const [tick, setTick] = useState(0)
  const { view } = props
  const phase = view.server?.phase
  const running = phase === 'applying' || phase === 'undoing'
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick(Date.now()), RUN_TICK_MS)
    return () => clearInterval(id)
  }, [running])
  // The one command made again when what it is made of changed while its fold is open.
  const stamp = oneshotStamp(view.tunnel.settings, view.tunnel.key.publicKey)
  const { oneshot, got } = state
  useEffect(() => {
    if (!oneshot || got.state === 'idle' || got.state === 'loading' || got.stamp === stamp) return
    let live = true
    void loadOneshot(t, stamp).then(next => {
      if (live) setState(s => ({ ...s, got: next }))
    })
    return () => {
      live = false
    }
  }, [oneshot, got, stamp, t])
  return (
    <ServerSetupBody
      {...props}
      saves={props.saves ?? own}
      state={state}
      onState={patch => setState(s => ({ ...s, ...patch }))}
      now={Math.max(now, tick)}
    />
  )
}

/** The first step that failed in a run, with its number. */
const failedOf = (p: Progress | null) => p?.steps.find(s => s.state === 'fail') ?? null

/** The part for a view and what it keeps (what the tests draw). */
export function ServerSetupBody({
  view,
  send,
  state,
  onState,
  now,
  steps = null,
  testing = false,
  fields = null,
  saves,
}: ServerSetupBodyProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const s = view.server ?? SERVER_IDLE
  const { phase, plan, progress, facts, choice } = s
  const admin = s.admin.user || DEFAULT_LOGIN
  const running = phase === 'applying' || phase === 'undoing'
  const busy = running || phase === 'looking'
  const lookWhy = !view.tunnel.ssh ? hintText('noSsh', t) : state.missing ? t('server.panel.needDomain') : ''
  const canLook = canEdit && !busy && view.tunnel.ssh !== null
  const failed = failedOf(progress)
  const hint = hintLine(s.hint, t, admin) || (failed ? failHint(failed.id, t) : '')
  const need = neededField(s, state)
  const sudo = sudoField(s, state)
  const plain = phase === 'plan' ? plainOf(s, view.tunnel.settings, t) : null
  const tracker = saves ?? savesTracker()

  // A field asked for (an answer's `need`, or Undo's): emptied and focused, once per ask.
  const passwordRef = useRef<HTMLInputElement>(null)
  const sudoRef = useRef<HTMLInputElement>(null)
  const asked = state.need
  const asks = state.asks
  useEffect(() => {
    if (asks === 0 || asked === null) return
    const field = (asked === 'sudoPassword' ? sudoRef : passwordRef).current
    if (!field) return
    field.value = ''
    field.focus()
  }, [asked, asks])

  /**
   * What Look and the one command need first: the saves on their way ended; the board's address
   * there (else said so); the server filled in from it and the board's own login on the server,
   * when not set; the board's own key made, when there is none. What the board took, or null.
   */
  async function prepare(): Promise<Took | null> {
    const took = await tracker.settle()
    const c = { ...view.tunnel.settings, ...took.tunnel } as TunnelConfig
    if (c.domain === '') {
      onState({ missing: true })
      return null
    }
    if (state.missing) onState({ missing: false })
    const fill = flowFill(c)
    if (fill) {
      const reply = await tracker.track(send('tunnel', { fields: fill }), { tunnel: fill })
      if (reply?.ok !== true) return null
    }
    const key = view.tunnel.key
    if (key.generated && !key.exists) {
      const reply = await send('key-generate')
      // `confirm`: the board has one already, which is what is needed
      if (reply?.ok !== true && reply?.confirm !== 'key') return null
    }
    return took
  }

  /** Set up the server: what it needs filled in, the login saved (root when none is), then Look. */
  async function setUp(): Promise<void> {
    const took = await prepare()
    if (!took) return
    if ((took.admin.user ?? s.admin.user) === '') {
      const user = DEFAULT_LOGIN
      const reply = await tracker.track(send('server-admin', { user }), { admin: { user } })
      if (reply?.ok !== true) return
    }
    await look('server-look')
  }

  /** Look (or Undo's Look) with the passwords typed; an answer that asks for one points at its field. */
  async function look(op: SetupState['again']): Promise<void> {
    const reply = await send(op, withPassword(state))
    onState(answerPatch(reply, op, state))
  }

  /** Undo's Look: the password is not kept from the setup, so Undo asks for it again (a key file logs in without one). */
  function undo(): void {
    if (state.password === '' && s.admin.key === '')
      onState({ need: 'password', again: 'server-undo-look', asks: state.asks + 1 })
    else void look('server-undo-look')
  }

  /** Continue, or Enter in a password field: what was asked for goes on. */
  function goOn(): void {
    if (state.again === 'server-undo-look') void look('server-undo-look')
    else void setUp()
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
    onState(answerPatch(reply, null, state))
  }

  function cancel(): void {
    onState({ need: null })
    void send('server-cancel')
  }

  /** "Do it myself (one command)" opened: what the command is made of settled on the board, then the command asked for. */
  async function toggleOneshot(open: boolean): Promise<void> {
    if (!open) return onState({ oneshot: false })
    onState({ oneshot: true, got: { state: 'loading' } })
    const took = canEdit ? await prepare() : { tunnel: {}, admin: {} }
    if (!took) return onState({ got: { state: 'idle' } })
    const settings = { ...view.tunnel.settings, ...took.tunnel } as TunnelConfig
    onState({ got: await loadOneshot(t, oneshotStamp(settings, view.tunnel.key.publicKey)) })
  }

  /** An admin field left: what changed goes to the board; refused or the same, the board's value shows again. */
  async function saveAdmin(field: 'user' | 'key', input: HTMLInputElement): Promise<void> {
    const before = s.admin[field]
    const edit = adminEdit(before, input.value)
    if (edit === null) {
      input.value = shownAdmin(field)
      return
    }
    const patch = field === 'user' ? { user: edit } : { key: edit }
    const reply = await tracker.track(send('server-admin', patch), { admin: patch })
    if (reply?.ok !== true) input.value = shownAdmin(field)
  }

  /** An admin field as it shows: the login, root when none is saved. */
  const shownAdmin = (field: 'user' | 'key'): string => (field === 'user' ? s.admin.user || DEFAULT_LOGIN : s.admin.key)

  const adminKeyDown = (field: 'user' | 'key') => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      // The field's own: the panel stays open.
      e.stopPropagation()
      e.currentTarget.value = shownAdmin(field)
      e.currentTarget.blur()
    }
  }

  const passwordKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && canLook && phase !== 'plan') goOn()
  }

  const adminField = (field: 'user' | 'key', label: string, placeholder: string) => (
    <label className="access-field">
      <span>{label}</span>
      <input
        // Drawn again with the board's value once it changes (uncontrolled: what is typed stays until then).
        key={s.admin[field]}
        className="path-add"
        name={`admin-${field}`}
        aria-label={label}
        placeholder={placeholder}
        defaultValue={shownAdmin(field)}
        spellCheck={false}
        autoComplete="off"
        disabled={!canEdit}
        onKeyDown={adminKeyDown(field)}
        onBlur={(e: FocusEvent<HTMLInputElement>) => void saveAdmin(field, e.currentTarget)}
      />
    </label>
  )

  const passwordField = (name: 'login-password' | 'sudo-password', label: string) => (
    <label
      className={classNames(
        'access-field',
        need === (name === 'login-password' ? 'password' : 'sudoPassword') && 'access-asked',
      )}
    >
      <span>{label}</span>
      <input
        ref={name === 'login-password' ? passwordRef : sudoRef}
        type="password"
        className="path-add access-input"
        name={name}
        aria-label={label}
        // Uncontrolled: the typed password never becomes an attribute of the page.
        defaultValue=""
        autoComplete="off"
        spellCheck={false}
        disabled={!canEdit}
        onChange={e =>
          onState(
            name === 'login-password' ? { password: e.currentTarget.value } : { sudoPassword: e.currentTarget.value },
          )
        }
        onKeyDown={passwordKeyDown}
      />
    </label>
  )

  const needs = (p: Plan): boolean =>
    (p.ticks.includes('docker') && !state.docker) ||
    (s.sudo === 'password' && state.password === '' && state.sudoPassword === '')
  const ran = plan && progress && (running || phase === 'done' || phase === 'failed')
  const lookWhyLine = lookWhy && <p className="access-look-why">{lookWhy}</p>
  const hostKey = hostKeyLine(s, t)
  const tickBox = (tick: Tick, label: string) => (
    <label className="access-tick" key={tick}>
      <input
        type="checkbox"
        name={`tick-${tick}`}
        checked={state[tick]}
        disabled={!canEdit}
        onChange={() => onState(tickPatch(tick, state))}
      />
      <span>{label}</span>
    </label>
  )

  return (
    <div className="access-web">
      <p className="access-note">{t('server.panel.webNote')}</p>

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
              onSure={undo}
            />
          </div>
        </div>
      )}

      <details className="access-signin" open={!loginFolded(s, state)}>
        <summary className="access-summary">{t('server.panel.signin')}</summary>
        <div className="access-fields">
          {fields}
          <div className="access-entry">{adminField('user', t('server.panel.login'), DEFAULT_LOGIN)}</div>
          <div className="access-entry">
            {passwordField('login-password', t('server.panel.password'))}
            <p className="access-kept">{t('server.panel.sudoNote')}</p>
          </div>
          {sudo && <div className="access-entry">{passwordField('sudo-password', t('server.panel.sudoOwn'))}</div>}
          <details className="access-keyfile" open={s.admin.key !== ''}>
            <summary className="access-summary">{t('server.panel.keyFold')}</summary>
            <div className="access-entry">
              {adminField('key', t('server.panel.keyFile'), t('server.panel.adminKeyHint'))}
            </div>
          </details>
        </div>
        {state.need !== null && state.again === 'server-undo-look' && phase !== 'plan' && !running && (
          <div className="access-ask">
            <p className="access-sure">{t('server.panel.undoAsks', { admin })}</p>
            <div className="access-actions">
              <button type="button" className="button primary" disabled={!canLook} onClick={goOn}>
                {t('server.panel.continue')}
              </button>
            </div>
          </div>
        )}
      </details>

      {(phase === 'idle' || phase === 'looking' || phase === 'done') && (
        <>
          <div className="access-actions">
            <button
              type="button"
              className={classNames('button', !s.setup && 'primary')}
              disabled={!canLook}
              onClick={() => void setUp()}
            >
              {phase === 'looking' ? t('server.panel.looking') : t('server.panel.setUpServer')}
            </button>
          </div>
          {lookWhyLine}
        </>
      )}

      <OneCommand
        open={state.oneshot}
        got={state.got}
        why={state.missing ? t('server.panel.needDomain') : ''}
        onToggle={open => void toggleOneshot(open)}
        onTest={() => void send('test', oneshotTest(view))}
        steps={steps}
        testing={testing}
      />

      {phase !== 'failed' && hint && <p className="access-hint">{hint}</p>}
      {phase !== 'failed' && s.error && <p className="access-why">{s.error}</p>}

      {plain && (
        <div className="access-plain">
          <h4 className="access-sub">{t('server.panel.plainFound')}</h4>
          <p className="access-found-line">{plain.found}</p>
          {hostKey && <p className="access-hostkey">{hostKey}</p>}
          {plain.stop ? (
            <p className="access-stop">{plain.stop}</p>
          ) : (
            <>
              <h4 className="access-sub">{t('server.panel.plainWill')}</h4>
              <ul className="access-will">
                {plain.will.map(line => (
                  <li className="access-will-line" key={line}>
                    {line}
                  </li>
                ))}
              </ul>
              {plain.docker && <p className="access-docker">{plain.docker}</p>}
              {plan?.ticks.map(tick =>
                tickBox(tick, tick === 'docker' ? t('server.panel.dockerOk') : t(`server.panel.tick.${tick}`)),
              )}
              {plan?.warnings.filter(isPlainWarning).map(w => (
                <p className="access-caution" key={w.key}>
                  {textLine(w, t)}
                </p>
              ))}
            </>
          )}
          <p className="access-untouched">{plain.untouched}</p>
        </div>
      )}

      {(facts || (plan && !ran)) && (
        <details className="access-details">
          <summary className="access-summary">{t('server.panel.details')}</summary>
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
          {plan && !ran && <PlanSteps plan={plan} progress={null} phase={phase} now={now} />}
        </details>
      )}

      {plain?.stop && (
        <details className="access-byhand">
          <summary className="access-summary">{t('server.panel.byHandFold')}</summary>
          <h4 className="access-sub">{t('server.panel.byHandLogin')}</h4>
          <Snippets settings={view.tunnel.settings} publicKey={view.tunnel.key.publicKey} />
          <DoItMyself view={view} state={state} onState={onState} />
        </details>
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
          <button type="button" className="button" disabled={!canEdit} onClick={cancel}>
            {t('access.cancel')}
          </button>
        </div>
      )}

      {plan && ran && <PlanSteps plan={plan} progress={progress} phase={phase} now={now} />}

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
            <button type="button" className="button primary" disabled={!canLook} onClick={() => void setUp()}>
              {t('server.panel.lookAgain')}
            </button>
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
    </div>
  )
}

interface PlanStepsProps {
  plan: Plan
  /** The run's, once one ran; null while the plan waits for Apply. */
  progress: Progress | null
  phase: ServerView['phase']
  now: number
}

/** The plan's numbered steps, each with why and what it touches; during and after a run its state and output. */
function PlanSteps({ plan, progress, phase, now }: PlanStepsProps) {
  const t = useT()
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
        plan.warnings
          .filter(w => !isPlainWarning(w))
          .map(w => (
            <p className="access-caution" key={w.key}>
              {textLine(w, t)}
            </p>
          ))}
    </div>
  )
}
