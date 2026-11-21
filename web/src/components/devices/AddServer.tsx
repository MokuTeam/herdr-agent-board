// Settings, Devices, "Add a server" (#509, docs/design/nodes 11.1, 12), in the manner of the Remote
// access panel's "Set up the server" (access/ServerSetup.tsx) and in its look: the server, the
// admin's login and its password (sudo's own when an answer asks for it), a key file folded, the
// device's id and the door's port under More; Look; the plan in plain words with what is refused
// and why, the ceiling's figures to change and the packages tick; Apply or Cancel; the server's
// steps and this computer's after them, each with its state ("Syncing the profile to …" while the
// first bundle goes); a failure with what to do and Continue where it picks up here; and at the end
// the command that logs Claude in on the node. Undo on a server looks first, as Set up does.
//
// Nothing is asked of the board until the owner opens the form: then GET /api/nodes/setup, again
// every second while the board is at work, and POST /api/nodes/setup for each step. The passwords
// live in this part's state only while the form is open, and are sent with each request that logs
// in; the board keeps them no longer than that request or its run.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, errorText } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  continues,
  DEFAULT_LOGIN,
  foundLine,
  isSetupView,
  loggedOut,
  loginCommand,
  lookBody,
  type NodeSetupView,
  passwordsOf,
  SETUP_BUSY,
  type SetupFields,
  stateWord,
  textOf,
} from '../../models/node-setup.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { CopyButton } from '../access/Snippets.tsx'
import { classNames } from '../class-names.ts'

export interface AddServerProps {
  /** The board's view, for a test that draws the form without a server; the form starts open with it. */
  initial?: NodeSetupView
}

const EMPTY: SetupFields = {
  host: '',
  sshPort: '',
  user: '',
  key: '',
  id: '',
  port: '',
  password: '',
  sudoPassword: '',
}
const POLL_MS = 1000

const isReply = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export function AddServer({ initial }: AddServerProps) {
  const t = useT()
  const { canEdit, toast } = useBoardContext()
  const [open, setOpen] = useState(!!initial)
  const [view, setView] = useState<NodeSetupView | null>(initial ?? null)
  const [fields, setFields] = useState<SetupFields>(EMPTY)
  const [need, setNeed] = useState<'password' | 'sudoPassword' | null>(null)
  const [said, setSaid] = useState('')
  const [ceiling, setCeiling] = useState<{ memoryMaxMb?: number; memoryHighMb?: number }>({})
  const [packages, setPackages] = useState(false)
  const [work, setWork] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)
  const sudoRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    api
      .get('/api/nodes/setup', isSetupView, { cache: 'no-store' })
      .then(setView)
      .catch(() => {})
  }, [])
  // asked for the first time when the owner opens the form, never before
  useEffect(() => {
    if (open && !initial) refresh()
  }, [open, initial, refresh])
  const phase = view?.phase ?? 'idle'
  const busy = SETUP_BUSY.includes(phase)
  useEffect(() => {
    if (!open || !busy || initial) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [open, busy, initial, refresh])

  const set = (patch: Partial<SetupFields>) => setFields(f => ({ ...f, ...patch }))

  /** One step of the form; an answer that asks for a password points at its field. */
  async function send(body: Record<string, unknown>): Promise<boolean> {
    if (!canEdit) return false
    setSaid('')
    try {
      await api.post('/api/nodes/setup', body, isReply)
      setNeed(null)
      return true
    } catch (err) {
      if (err instanceof ApiError) {
        const asked = err.reply.need
        if (asked === 'password' || asked === 'sudoPassword') {
          setNeed(asked)
          const field = (asked === 'password' ? passwordRef : sudoRef).current
          field?.focus()
        }
        setSaid(typeof err.reply.error === 'string' && err.reply.error ? err.reply.error : errorText(err, t))
      } else toast(errorText(err, t), true)
      return false
    } finally {
      refresh()
    }
  }

  const look = (op: 'look' | 'undo-look') => void send(lookBody(op, fields))
  const login = () => passwordsOf(fields)
  const apply = () => {
    const plan = view?.plan
    if (!plan) return
    const forget = () => {
      for (const f of [passwordRef.current, sudoRef.current]) if (f) f.value = ''
      set({ password: '', sudoPassword: '' })
    }
    const body =
      view?.kind === 'undo'
        ? { op: 'undo', plan: plan.id, work, ...login() }
        : {
            op: 'apply',
            plan: plan.id,
            packages,
            ...(Object.keys(ceiling).length && { ceiling: { ...plan.ceiling, ...ceiling } }),
            ...login(),
          }
    void send(body).then(ok => ok && forget())
  }

  if (!open)
    return (
      <section className="devices-section devices-add">
        <h3 className="devices-head">{t('node.add.title')}</h3>
        <p className="sheet-meta">{t('node.add.about')}</p>
        <div className="access-actions">
          <button type="button" className="button primary" disabled={!canEdit} onClick={() => setOpen(true)}>
            {t('node.add.open')}
          </button>
        </div>
      </section>
    )

  const v = view
  const plan = v?.plan ?? null
  const ran =
    !!v &&
    (phase === 'applying' ||
      phase === 'finishing' ||
      phase === 'done' ||
      phase === 'failed' ||
      phase === 'undoing' ||
      phase === 'undone') &&
    !!v.run
  const titles = new Map((plan?.steps ?? []).map(s => [s.id, textOf(s.title, t)]))
  const sudoShown = need === 'sudoPassword' || fields.sudoPassword !== ''
  const field = (name: keyof SetupFields, label: string, placeholder = '', type = 'text') => (
    <label className={classNames('access-field', need === name && 'access-asked')}>
      <span>{label}</span>
      <input
        ref={name === 'password' ? passwordRef : name === 'sudoPassword' ? sudoRef : undefined}
        type={type}
        className="path-add access-input"
        name={`node-${name}`}
        aria-label={label}
        placeholder={placeholder}
        {...(type === 'password' ? { defaultValue: '' } : { value: fields[name] })}
        spellCheck={false}
        autoComplete="off"
        disabled={!canEdit || busy}
        onChange={e => set({ [name]: e.currentTarget.value })}
        onKeyDown={e => {
          if (e.key === 'Enter' && !busy && phase !== 'plan') look('look')
        }}
      />
    </label>
  )
  const server0 = v?.server ?? null

  return (
    <section className="devices-section devices-add" data-phase={phase}>
      <h3 className="devices-head">{t('node.add.title')}</h3>
      <p className="sheet-meta">{t('node.add.about')}</p>

      {(phase === 'idle' || phase === 'looking' || phase === 'failed' || phase === 'undone') && (
        <div className="access-fields">
          <div className="access-pair">
            <div className="access-entry access-entry-host">
              {field('host', t('node.add.host'), 'server.example.com')}
            </div>
            <div className="access-entry access-entry-sshPort">{field('sshPort', t('node.add.sshPort'), '22')}</div>
          </div>
          <div className="access-entry">{field('user', t('node.add.user'), DEFAULT_LOGIN)}</div>
          <div className="access-entry">
            {field('password', t('node.add.password'), '', 'password')}
            <p className="access-kept">{t('node.add.passwordNote')}</p>
          </div>
          {sudoShown && (
            <div className="access-entry">{field('sudoPassword', t('node.add.sudoPassword'), '', 'password')}</div>
          )}
          <details className="access-keyfile">
            <summary className="access-summary">{t('node.add.more')}</summary>
            <div className="access-entry">{field('key', t('node.add.keyFile'), t('node.add.keyHint'))}</div>
            <div className="access-entry">{field('id', t('node.add.id'), t('node.add.idHint'))}</div>
            <div className="access-entry">{field('port', t('node.add.port'), '12430')}</div>
          </details>
          <div className="access-actions">
            <button
              type="button"
              className="button primary"
              disabled={!canEdit || busy || !fields.host.trim()}
              onClick={() => look('look')}
            >
              {phase === 'looking' && v?.kind === 'apply' ? t('node.add.looking') : t('node.add.look')}
            </button>
            <button
              type="button"
              className="button"
              disabled={!canEdit || busy || !fields.host.trim()}
              onClick={() => look('undo-look')}
            >
              {t('node.add.undoLook')}
            </button>
          </div>
        </div>
      )}

      {said && <p className="access-why devices-said">{said}</p>}
      {v?.hint && phase !== 'plan' && !said && (
        <p className="access-hint">{t(`server.hint.${v.hint}`, { admin: server0?.user ?? DEFAULT_LOGIN })}</p>
      )}

      {v && phase === 'plan' && (
        <div className="access-plain">
          {v.found && (
            <>
              <h4 className="access-sub">{t('node.add.foundHead')}</h4>
              <p className="access-found-line">{foundLine(v.found, t)}</p>
            </>
          )}
          {v.hostKey && (
            <p className="access-hostkey">
              {t(v.hostKey.pinnedNow ? 'node.add.hostKeyNew' : 'node.add.hostKey', {
                fingerprint: v.hostKey.fingerprint,
              })}
            </p>
          )}
          {v.refusals.length > 0 && (
            <>
              <p className="access-stop">{t('node.add.refused')}</p>
              <ul className="access-will">
                {v.refusals.map(r => (
                  <li className="access-will-line access-warn" key={r.key}>
                    {textOf(r, t)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan && (
            <>
              <h4 className="access-sub">{t(v.kind === 'undo' ? 'node.add.willUndo' : 'node.add.will')}</h4>
              <ul className="access-will">
                {plan.words.map(w => (
                  <li className="access-will-line" key={w.key}>
                    {textOf(w, t)}
                  </li>
                ))}
              </ul>
              {plan.warnings.map(w => (
                <p className="access-caution" key={w.key}>
                  {textOf(w, t)}
                </p>
              ))}
              {v.kind === 'apply' && plan.ceiling && (
                <div className="devices-limits devices-ceiling" title={t('node.add.ceilingWhy')}>
                  {(['memoryMaxMb', 'memoryHighMb'] as const).map(k => (
                    <label className="devices-limit" key={k}>
                      <span>{t(`node.add.${k}`)}</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        name={`node-${k}`}
                        step={64}
                        defaultValue={plan.ceiling?.[k]}
                        disabled={!canEdit}
                        onChange={e => {
                          const n = Number(e.currentTarget.value)
                          setCeiling(c => ({ ...c, [k]: Number.isInteger(n) && n > 0 ? n : undefined }))
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              {plan.packagesNeeded && (
                <label className="access-tick">
                  <input
                    type="checkbox"
                    name="node-packages"
                    checked={packages}
                    onChange={() => setPackages(p => !p)}
                  />
                  <span>{t('node.add.packages')}</span>
                </label>
              )}
              {v.kind === 'undo' && (
                <label className="access-tick">
                  <input type="checkbox" name="node-work" checked={work} onChange={() => setWork(w => !w)} />
                  <span>{t('node.add.work')}</span>
                </label>
              )}
              <details className="access-details">
                <summary className="access-summary">{t('node.add.steps')}</summary>
                <ol className="access-plan-steps">
                  {plan.steps.map((s, i) => (
                    <li className="access-plan-step" key={s.id}>
                      <div className="access-step-line">
                        <span className="access-num">{i + 1}</span>
                        <span className="access-title">{textOf(s.title, t)}</span>
                      </div>
                      <p className="access-why-step">{textOf(s.why, t)}</p>
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
          <div className="access-actions">
            {plan && (
              <button
                type="button"
                className="button primary"
                disabled={!canEdit || (plan.packagesNeeded && !packages)}
                onClick={apply}
              >
                {t(v.kind === 'undo' ? 'node.add.undo' : 'node.add.apply')}
              </button>
            )}
            <button type="button" className="button" disabled={!canEdit} onClick={() => void send({ op: 'cancel' })}>
              {t('node.add.cancel')}
            </button>
          </div>
        </div>
      )}

      {v && ran && (
        <div className="access-plan devices-run">
          <h4 className="access-sub">{t('node.add.onServer')}</h4>
          <ol className="access-plan-steps">
            {(v.run?.steps ?? []).map((s, i) => (
              <li className="access-plan-step" key={s.id} data-state={s.state}>
                <div className="access-step-line">
                  <span className="access-num">{i + 1}</span>
                  <span className="access-title">{titles.get(s.id) ?? s.id}</span>
                  <span className={classNames('access-state', s.state === 'fail' && 'access-bad')}>
                    {stateWord(s.state, t)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          {v.master.length > 0 && (
            <>
              <h4 className="access-sub">{t('node.add.here')}</h4>
              <ol className="access-plan-steps devices-master">
                {v.master.map(s => (
                  <li className="access-plan-step" key={s.id} data-state={s.state}>
                    <div className="access-step-line">
                      <span className="access-title">{t(`node.setup.step.${s.id}`)}</span>
                      <span className={classNames('access-state', s.state === 'fail' && 'access-bad')}>
                        {stateWord(s.state, t)}
                      </span>
                    </div>
                    {s.said && (s.state !== 'wait' || s.id === 'login') && (
                      <p className="access-why-step">{textOf(s.said, t)}</p>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
          {(v.run?.warnings ?? []).map(w => (
            <p className="access-caution" key={w}>
              {w}
            </p>
          ))}
        </div>
      )}

      {v && phase === 'failed' && (
        <div className="access-failure">
          {v.error && <p className="access-why">{v.error}</p>}
          {v.next && <p className="access-hint">{textOf(v.next, t)}</p>}
          {continues(v) && (
            <div className="access-actions">
              <button
                type="button"
                className="button primary"
                disabled={!canEdit}
                onClick={() => void send({ op: 'finish' })}
              >
                {t('node.add.continue')}
              </button>
            </div>
          )}
        </div>
      )}

      {v && phase === 'done' && v.device && (
        <div className="devices-login devices-done">
          <p className="access-done">{t('node.add.done', { device: v.device.id })}</p>
          <LoginLines
            device={v.device.id}
            out={loggedOut(v.login?.profiles ?? [])}
            command={
              server0 ? loginCommand({ host: server0.host, sshPort: server0.sshPort, user: server0.user }) : null
            }
          />
          <div className="access-actions">
            <button type="button" className="button" onClick={() => void send({ op: 'cancel' })}>
              {t('node.add.close')}
            </button>
          </div>
        </div>
      )}
      {v && phase === 'undone' && <p className="access-result">{t('node.add.undone')}</p>}
    </section>
  )
}

/** Claude's login on a node: the profiles that are not logged in, and the command that does it. */
export function LoginLines({
  device,
  out,
  command,
}: {
  device: string
  out: readonly string[]
  command: string | null
}) {
  const t = useT()
  if (out.length === 0) return <p className="sheet-meta devices-logged">{t('node.add.loggedIn', { device })}</p>
  return (
    <div className="devices-login-how">
      <p className="devices-login-line">{t('node.add.loginNot', { device, profiles: out.join(', ') })}</p>
      {command && (
        <div className="access-line devices-command">
          <code className="access-code">{command}</code>
          <CopyButton text={command} />
        </div>
      )}
      <p className="sheet-meta">{t(out.some(p => p !== 'default') ? 'node.add.loginOther' : 'node.add.loginHow')}</p>
    </div>
  )
}
