// The Remote access panel's Server tab, and the login its Sync tab shares (the simple-setup spec's
// "The flow, as the owner sees it", laid out in cards): the server's login once at the top (the
// server and its port, the Tunnel tab's settings drawn here with TunnelEntry, passed in; the login,
// root unless another is saved, its password, sudo's own when an answer asks for it, a key file
// folded), shared by every server action on every tab. Then two cards: the tunnel on the server
// (set up when, which case; Set up or Update, and Undo, which logs in as Set up does) and the board
// on the server (its own address, the version an install sends; Install). The card whose Look ran
// shows its plan in plain words (what was found with the server's key, what will be done, Docker's
// install to tick, what is not touched, every step and line folded under Details), Apply or Cancel,
// the run step by step, a failure with what was rolled back. For a server the board does not do,
// why in one line, and the steps by hand folded (DoItMyself.tsx, Snippets.tsx). "Do it myself (one
// command)" is OneCommand.tsx, folded at the bottom. Its words are models/server-setup.ts's.
// What it keeps while the panel is open (SetupState: the passwords, the ticks, what is open) is the
// panel's (useServerSetup), drawn anew as the panel closes; the passwords the board remembers are
// its own (`passwordHeld`, services/held-passwords.ts). The Sync tab is ServerSync: ProfileSync.tsx
// with this login, once the board on the server has its address. The board's side is the
// `server-*` and `sync-*` ops of POST /api/access.
import { type FocusEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import type { AccessView } from '../../../../src/core/access.ts'
import { sourceLine } from '../../../../src/core/server-install.ts'
import type { Plan } from '../../../../src/core/server-plan.ts'
import type { Progress } from '../../../../src/core/server-script.ts'
import type { InstallView, ServerView } from '../../../../src/core/server-view.ts'
import type { TestStep, TunnelConfig } from '../../../../src/core/tunnel.ts'
import { timeOf } from '../../../../src/core/when-format.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { hintText, stepLine } from '../../models/access.ts'
import {
  foundPort,
  loadOneshot,
  ONESHOT_IDLE,
  oneshotStale,
  oneshotStamp,
  oneshotTest,
  oneshotWaited,
} from '../../models/server-oneshot.ts'
import {
  adminEdit,
  answerPatch,
  caseLine,
  DEFAULT_LOGIN,
  failHint,
  flowFill,
  foundLines,
  heldUntil,
  hintLine,
  hostKeyLine,
  isPlainWarning,
  loginFolded,
  manualReasons,
  neededField,
  passwordsTaken,
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
import { ProfileSync } from './ProfileSync.tsx'
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

/** What the Server tab keeps while the panel is open, shared with the Sync tab: its state, its clock, the saves on their way. */
export interface ServerSetupKeep {
  state: SetupState
  onState(patch: Partial<SetupState>): void
  now: number
  saves: Saves
}

/** The Server tab's keeping, held by the panel (so the Sync tab signs in with the same login). */
export function useServerSetup(view: AccessView, send: AccessSend, saves?: Saves): ServerSetupKeep {
  const t = useT()
  const { now, data } = useBoardContext()
  const [state, setState] = useState<SetupState>(SETUP_START)
  const [own] = useState(savesTracker)
  const [tick, setTick] = useState(0)
  const phase = view.server?.phase
  // The install's setup link lives in the board's memory until the panel closes (path B, call 9).
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(
    () => () => {
      void sendRef.current('server-install-forget')
    },
    [],
  )
  const running = phase === 'applying' || phase === 'undoing'
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick(Date.now()), RUN_TICK_MS)
    return () => clearInterval(id)
  }, [running])
  // The one command made again when what it is made of changed while its fold is open (the board's
  // language too, once the board has switched: its words are the board's).
  const stamp = oneshotStamp(view.tunnel.settings, view.tunnel.key.publicKey, data?.lang ?? t.lang)
  const { oneshot, got } = state
  useEffect(() => {
    if (!oneshotStale(oneshot, got, stamp)) return
    let live = true
    void loadOneshot(t, stamp).then(next => {
      if (live) setState(s => ({ ...s, got: next }))
    })
    return () => {
      live = false
    }
  }, [oneshot, got, stamp, t])
  return {
    state,
    onState: patch => setState(s => ({ ...s, ...patch })),
    now: Math.max(now, tick),
    saves: saves ?? own,
  }
}

export function ServerSetup(props: ServerSetupProps) {
  const keep = useServerSetup(props.view, props.send, props.saves)
  return <ServerSetupBody {...props} saves={keep.saves} state={keep.state} onState={keep.onState} now={keep.now} />
}

export interface ServerSyncProps {
  view: AccessView
  send: AccessSend
  /** The Server tab's: the passwords typed there go with the sync's requests too. */
  state: SetupState
  /** The Server tab's change: the typed passwords let go of once the board took them. */
  onState?(patch: Partial<SetupState>): void
}

/** The Sync tab: the sync of the Claude profiles, signed in as the Server tab's login, once the board on the server has its address. */
export function ServerSync({ view, send, state, onState }: ServerSyncProps) {
  const t = useT()
  const { canEdit } = useBoardContext()
  const s = view.server ?? SERVER_IDLE
  const busy = s.phase === 'applying' || s.phase === 'undoing' || s.phase === 'looking'
  if ((s.installDomain ?? '') === '' && !view.sync) return <p className="access-note">{t('sync.panel.needBoard')}</p>
  return (
    <>
      <p className="access-note">{t('sync.panel.signsIn')}</p>
      <ProfileSync
        sync={view.sync ?? null}
        send={async (op, body) => {
          const reply = await send(op, body)
          // the board remembers them now: the Server tab's typed ones go
          if (onState && passwordsTaken(op, reply) && (state.password !== '' || state.sudoPassword !== ''))
            onState({ password: '', sudoPassword: '' })
          return reply
        }}
        passwords={withPassword(state)}
        enabled={canEdit && !busy && view.tunnel.ssh !== null}
      />
    </>
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
  const { canEdit, data } = useBoardContext()
  const s = view.server ?? SERVER_IDLE
  const { phase, plan, progress, facts, choice } = s
  const admin = s.admin.user || DEFAULT_LOGIN
  const running = phase === 'applying' || phase === 'undoing'
  const busy = running || phase === 'looking'
  // The last Look was "Install the board on this server" (path B): its plan, its run, its link.
  const installing = s.target === 'install'
  // Path B's own address (the board on the server's), apart from the tunnel's.
  const installDomain = s.installDomain ?? ''
  // Asked without the board's address, or the install without its own: said until it is there.
  const noDomain = view.tunnel.settings.domain === ''
  const needDomain = t('server.panel.needDomain')
  // Why a card's Look cannot go yet: no ssh, or the board's address missing; the install without its own.
  const tunnelLookWhy = !view.tunnel.ssh ? hintText('noSsh', t) : state.missing && noDomain ? needDomain : ''
  const boardLookWhy = state.installAsked && installDomain === '' ? t('install.panel.needDomain') : ''
  const canLook = canEdit && !busy && view.tunnel.ssh !== null
  const failed = failedOf(progress)
  const hint = hintLine(s.hint, t, admin) || (failed ? failHint(failed.id, t) : '')
  const need = neededField(s, state)
  const sudo = sudoField(s, state)
  const plain = phase === 'plan' ? plainOf(s, view.tunnel.settings, t) : null
  const tracker = saves ?? savesTracker()
  // Until when the board remembers the server's passwords (its memory only): nothing asked meanwhile.
  const held = heldUntil(s, now)

  // A field an answer asked for (its `need`): emptied and focused, once per ask.
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

  // The passwords let go of (here, or by the Sync tab once the board took them): their fields emptied too.
  useEffect(() => {
    if (state.password === '' && passwordRef.current) passwordRef.current.value = ''
    if (state.sudoPassword === '' && sudoRef.current) sudoRef.current.value = ''
  }, [state.password, state.sudoPassword])

  /**
   * What Look and the one command need first: the saves on their way ended; the board's address
   * there (else said so: 'address'); the server filled in from it and the board's own login on the
   * server, when not set; the board's own key made, when there is none. What the board took, or null.
   * The install (`forInstall`) logs in to the server alone: the board's address only fills that in,
   * so it is needed only while the server is not there.
   */
  async function prepare(withKey = true, forInstall = false): Promise<Took | 'address' | null> {
    const took = await tracker.settle()
    const c = { ...view.tunnel.settings, ...took.tunnel } as TunnelConfig
    if (c.domain === '' && !(forInstall && c.host !== '')) {
      onState({ missing: true })
      return 'address'
    }
    if (state.missing) onState({ missing: false })
    const fill = flowFill(c)
    if (fill) {
      const reply = await tracker.track(send('tunnel', { fields: fill }), { tunnel: fill })
      if (reply?.ok !== true) return null
    }
    const key = view.tunnel.key
    if (withKey && key.generated && !key.exists) {
      const reply = await send('key-generate')
      // `confirm`: the board has one already, which is what is needed
      if (reply?.ok !== true && reply?.confirm !== 'key') return null
    }
    return took
  }

  /** Set up the server: what it needs filled in, the login saved (root when none is), then Look. */
  async function setUp(): Promise<void> {
    const took = await prepare()
    if (!took || took === 'address') return
    if ((took.admin.user ?? s.admin.user) === '') {
      const user = DEFAULT_LOGIN
      const reply = await tracker.track(send('server-admin', { user }), { admin: { user } })
      if (reply?.ok !== true) return
    }
    await look('server-look')
  }

  /**
   * Install the board on this server (path B): its own address first (else said so, and nothing
   * sent), then the same server, login and password; no key of the board's needed (the server mode
   * has no tunnel). Then the install's own Look.
   */
  async function installLook(): Promise<void> {
    const saved = await tracker.settle()
    if ((saved.install?.domain ?? installDomain) === '') return onState({ installAsked: true })
    if (state.installAsked) onState({ installAsked: false })
    const took = await prepare(false, true)
    if (!took || took === 'address') return
    if ((took.admin.user ?? s.admin.user) === '') {
      const user = DEFAULT_LOGIN
      const reply = await tracker.track(send('server-admin', { user }), { admin: { user } })
      if (reply?.ok !== true) return
    }
    await look('server-install-look')
  }

  /**
   * Look (or Undo's Look) with the passwords typed (none: the board's remembered ones go); an answer
   * that asks for one points at its field; one that went through lets the typed ones go (the board
   * remembers them now).
   */
  async function look(op: SetupState['again']): Promise<void> {
    const reply = await send(op, withPassword(state))
    onState(answerPatch(reply, op, state))
    if (passwordsTaken(op, reply)) forget()
  }

  /**
   * Undo's Look, at once, as Set up's: with the password typed, else with the keys (the ssh agent,
   * ~/.ssh, a key file) alone. The password is not kept from the setup: when the server wants it,
   * the board's answer asks for it (`need`), and Continue goes on.
   */
  function undo(): void {
    void look('server-undo-look')
  }

  /** Continue, or Enter in a password field: what was asked for goes on. */
  function goOn(): void {
    if (state.again === 'server-undo-look') void look('server-undo-look')
    else if (state.again === 'server-install-look') void installLook()
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
    const op = installing ? 'server-install' : p.kind === 'undo' ? 'server-undo' : 'server-apply'
    const reply = await send(op, {
      plan: p.id,
      ...ticks,
      ...withPassword(state),
    })
    // The board took the passwords for this run: the panel keeps them no longer (the board remembers them).
    if (passwordsTaken(op, reply)) forget()
    onState(answerPatch(reply, null, state))
  }

  /** The passwords typed, gone from the part and its fields. */
  function forget(): void {
    for (const field of [passwordRef.current, sudoRef.current]) if (field) field.value = ''
    onState({ password: '', sudoPassword: '' })
  }

  function cancel(): void {
    onState({ need: null, again: 'server-look' })
    void send('server-cancel')
  }

  /** "Do it myself (one command)" opened: what the command is made of settled on the board, then the command asked for. */
  async function toggleOneshot(open: boolean): Promise<void> {
    if (!open) return onState({ oneshot: false })
    onState({ oneshot: true, got: { state: 'loading' } })
    const took = canEdit ? await prepare() : { tunnel: {}, admin: {} }
    // no address yet: the fold waits for it (below); refused otherwise: left as it is
    if (took === 'address') return onState({ got: { state: 'address' } })
    if (!took) return onState({ got: ONESHOT_IDLE })
    const settings = { ...view.tunnel.settings, ...took.tunnel } as TunnelConfig
    onState({ got: await loadOneshot(t, oneshotStamp(settings, view.tunnel.key.publicKey, data?.lang ?? t.lang)) })
  }

  // "Do it myself" opened before the board's address was typed: once it is there, the fold goes on
  // as it does when it opens (the latest toggle, for the view it was drawn with).
  const reopen = useRef(toggleOneshot)
  reopen.current = toggleOneshot
  const waited = oneshotWaited(state.oneshot, state.got, view.tunnel.settings.domain)
  useEffect(() => {
    if (waited) void reopen.current(true)
  }, [waited])

  /**
   * "Do it myself"'s Test connection: with no setup on record, the board finds the public port
   * the command set up and keeps it; where it answered, the part says the server was set up by hand.
   */
  async function testOneshot(): Promise<void> {
    const reply = await send('test', oneshotTest(view))
    onState({ byHand: foundPort(reply) })
  }

  /** An admin field left: what changed goes to the board; refused or the same, the board's value shows again. */
  async function saveAdmin(field: 'user' | 'key', input: HTMLInputElement): Promise<void> {
    const edit = adminEdit(s.admin[field], input.value, shownAdmin(field))
    if (edit === null) {
      input.value = shownAdmin(field)
      return
    }
    const patch = field === 'user' ? { user: edit } : { key: edit }
    const reply = await tracker.track(send('server-admin', patch), { admin: patch })
    if (reply?.ok !== true) input.value = shownAdmin(field)
  }

  /**
   * The address of the board on the server left: what changed goes to the board, which the install's
   * Look waits for; refused, what was typed stays, with the board's words under it.
   */
  async function saveInstallDomain(input: HTMLInputElement): Promise<void> {
    const edit = adminEdit(installDomain, input.value.toLowerCase())
    if (edit === null) {
      input.value = installDomain
      if (state.installRefused) onState({ installRefused: '' })
      return
    }
    const reply = await tracker.track(send('server-install-domain', { domain: edit }), { install: { domain: edit } })
    onState({ installRefused: reply?.ok !== true && typeof reply?.error === 'string' ? reply.error : '' })
  }

  const installKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      // The field's own: the panel stays open.
      e.stopPropagation()
      e.currentTarget.value = installDomain
      onState({ installRefused: '' })
      e.currentTarget.blur()
    }
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

  // Path B's address, above its button: the board on the server's own domain, never the tunnel's.
  const installField = (
    <div className="access-install-domain">
      <label className="access-field">
        <span>{t('install.panel.domain')}</span>
        <input
          // Drawn again with the board's value once it changes (uncontrolled: what is typed stays until then).
          key={installDomain}
          className="path-add"
          name="install-domain"
          aria-label={t('install.panel.domain')}
          placeholder={t('install.panel.domainPlaceholder')}
          defaultValue={installDomain}
          spellCheck={false}
          autoComplete="off"
          disabled={!canEdit}
          onKeyDown={installKeyDown}
          onBlur={(e: FocusEvent<HTMLInputElement>) => void saveInstallDomain(e.currentTarget)}
        />
      </label>
      {/* the board's refusal in the note's place while it stands */}
      <p className={state.installRefused ? 'access-problem' : 'access-install-note'}>
        {state.installRefused || t('install.panel.domainNote')}
      </p>
    </div>
  )

  const needs = (p: Plan): boolean =>
    (p.ticks.includes('docker') && !state.docker) ||
    (s.sudo === 'password' && state.password === '' && state.sudoPassword === '' && held === null)
  const ran = plan && progress && (running || phase === 'done' || phase === 'failed')
  const tunnelWhy = tunnelLookWhy && <p className="access-look-why">{tunnelLookWhy}</p>
  const boardWhy = boardLookWhy && <p className="access-look-why">{boardLookWhy}</p>
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

  // What the last Look's card shows: its hint, its plan, its run and how it ended.
  const flow = (
    <>
      {phase !== 'failed' && hint && <p className="access-hint">{hint}</p>}
      {phase !== 'failed' && s.error && <p className="access-why">{s.error}</p>}

      {plain && (
        <div className="access-plain">
          {installing && s.install && (
            <>
              <p className="access-note">{t('install.panel.intro')}</p>
              <p className="access-note">
                {t('install.panel.from', { from: sourceLine({ kind: 'archive', ...s.install.from }, t) })}
              </p>
            </>
          )}
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
          {/* an install goes on with nothing for the web server to change: the board, herdr and its key still do */}
          {plan && (plan.kind !== 'nothing' || installing) && (
            <button
              type="button"
              className="button primary"
              disabled={!canEdit || needs(plan)}
              onClick={() => void run(plan)}
            >
              {t(
                installing ? 'install.panel.apply' : plan.kind === 'undo' ? 'server.panel.undo' : 'server.panel.apply',
              )}
            </button>
          )}
          <button type="button" className="button" disabled={!canEdit} onClick={cancel}>
            {t('access.cancel')}
          </button>
        </div>
      )}

      {plan && ran && <PlanSteps plan={plan} progress={progress} phase={phase} now={now} />}

      {installing && s.install && (running || phase === 'done' || phase === 'failed') && (
        <InstallRun install={s.install} phase={phase} domain={installDomain} />
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
          {installing && installField}
          <div className="access-actions">
            <button
              type="button"
              className="button primary"
              disabled={!canLook}
              onClick={() => void (installing ? installLook() : setUp())}
            >
              {t('server.panel.lookAgain')}
            </button>
          </div>
          {installing ? boardWhy : tunnelWhy}
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
    </>
  )
  // Set up and Install start a Look while nothing else runs or waits.
  const canStart = phase === 'idle' || phase === 'looking' || phase === 'done'
  // The board on the server: its address, and the version an install sends (known once one looked).
  const boardLine = [
    installDomain || t('server.panel.boardNoAddress'),
    s.install && t('server.panel.boardVersion', { commit: s.install.from.commit.slice(0, 7) }),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="access-web">
      <p className="access-note">{t('server.panel.webNote')}</p>

      <details className="access-signin" open={!loginFolded(s, state)}>
        <summary className="access-summary">{t('server.panel.signin')}</summary>
        <div className="access-fields">
          {fields}
          <div className="access-entry">{adminField('user', t('server.panel.login'), DEFAULT_LOGIN)}</div>
          <div className="access-entry">
            {passwordField('login-password', t('server.panel.password'))}
            {held !== null ? (
              <div className="access-held-line">
                <p className="access-kept access-held">{t('server.panel.held', { time: timeOf(held, t) })}</p>
                <button
                  type="button"
                  className="button"
                  disabled={!canEdit}
                  onClick={() => void send('server-password-forget')}
                >
                  {t('server.panel.forgetPassword')}
                </button>
              </div>
            ) : (
              <p className="access-kept">{t('server.panel.sudoNote')}</p>
            )}
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

      <section className="access-card access-card-tunnel">
        <h4 className="access-card-head">{t('server.panel.tunnelCard')}</h4>
        {s.setup ? (
          <p className="access-done">{setupLine(s.setup, t)}</p>
        ) : (
          <p className="access-card-line">{t('server.panel.notSetUp')}</p>
        )}
        {(canStart || (s.setup && phase === 'failed')) && (
          <div className="access-actions">
            {canStart && (
              <button
                type="button"
                className={classNames('button', !s.setup && 'primary')}
                disabled={!canLook}
                onClick={() => void setUp()}
              >
                {phase === 'looking' && !installing
                  ? t('server.panel.looking')
                  : s.setup
                    ? t('server.panel.update')
                    : t('server.panel.setUpServer')}
              </button>
            )}
            {s.setup && phase !== 'looking' && (
              <TwoClicks
                armed={state.undoArmed}
                label={t('server.panel.undo')}
                sure={t('server.panel.undoSure')}
                disabled={!canLook}
                onArm={() => onState({ undoArmed: true })}
                onDisarm={() => onState({ undoArmed: false })}
                onSure={undo}
              />
            )}
          </div>
        )}
        {canStart && tunnelWhy}
        {!installing && flow}
      </section>

      <section className="access-card access-card-board">
        <h4 className="access-card-head">{t('server.panel.boardCard')}</h4>
        <p className="access-card-line">{boardLine}</p>
        {canStart && (
          <>
            {installField}
            <div className="access-actions">
              <button
                type="button"
                className="button"
                disabled={!canLook}
                title={t('install.panel.intro')}
                onClick={() => void installLook()}
              >
                {phase === 'looking' && installing ? t('server.panel.looking') : t('install.panel.look')}
              </button>
            </div>
          </>
        )}
        {canStart && boardWhy}
        {installing && flow}
      </section>

      <OneCommand
        open={state.oneshot}
        got={state.got}
        why={state.got.state === 'address' && noDomain ? needDomain : ''}
        onToggle={open => void toggleOneshot(open)}
        onTest={() => void testOneshot()}
        byHand={state.byHand}
        domain={view.tunnel.settings.domain}
        steps={steps}
        testing={testing}
      />
    </div>
  )
}

/**
 * "Install the board on this server"'s run: its output as the server prints it, the setup link
 * apart (the board's memory only; the panel lets it go as it closes), and how it ended.
 */
function InstallRun({ install, phase, domain }: { install: InstallView; phase: ServerView['phase']; domain: string }) {
  const t = useT()
  return (
    <div className="access-install">
      {phase === 'applying' && <p className="access-sub">{t('install.panel.running')}</p>}
      {install.out.length > 0 && <pre className="access-pre">{install.out.join('\n')}</pre>}
      {install.link && (
        <div className="access-install-link">
          <p className="access-sub">{t('install.panel.link')}</p>
          <a href={install.link} target="_blank" rel="noreferrer noopener">
            {install.link}
          </a>
        </div>
      )}
      {phase === 'done' && <p className="access-result">{t('install.panel.done', { domain })}</p>}
      {phase === 'failed' && <p className="access-warn">{t('install.panel.failed')}</p>}
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
