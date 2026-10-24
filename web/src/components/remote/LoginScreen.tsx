// The login screen of the board through the owner's own domain (src/core/tunnel.ts; the tunnel
// listener's login routes, src/server/tunnel.ts), drawn by RemoteGate while hello says
// `auth: 'login'` and this browser is not signed in: "Sign in with a passkey" first, then
// "Use password and code" (a form a password manager knows: a hidden user name, the password, a
// one-time code). After a password sign-in on a browser that made no passkey, the offer to add one
// here, which asks for the next code: the one used to sign in works once only (Call 34). Every
// POST carries the board's header (api/client.ts postJson), which the tunnel listener asks of each.
import type { Translator } from '../../../../src/core/types.ts'
import { isReply, postJson, replyOf } from '../../api/client.ts'
import { loginNote, noteText, type ScreenNote } from '../../models/login.ts'
import {
  assertionJson,
  attestationJson,
  creationOptions,
  markPasskeyMade,
  passkeyMade,
  passkeysHere,
  requestOptions,
} from '../../models/passkey.ts'
import { Store } from '../../state/store.ts'

/** What the fields hold: the password and code to sign in, and the next code for a passkey. */
export interface LoginFields {
  password: string
  code: string
  next: string
}

export interface LoginState {
  /** 'start': signing in; 'offer': Add a passkey for this device; 'in': signed in, the board on its way. */
  step: 'start' | 'offer' | 'in'
  /** "Use password and code" was pressed (a browser without passkeys has the form at once). */
  form: boolean
  fields: LoginFields
  /** An answer is on its way. */
  busy: boolean
  note: ScreenNote | null
}

const START: LoginState = {
  step: 'start',
  form: false,
  fields: { password: '', code: '', next: '' },
  busy: false,
  note: null,
}

/** What the screen's buttons and fields do. */
export interface LoginHandlers {
  passkey(): Promise<void>
  openForm(): void
  type(field: keyof LoginFields, value: string): void
  signIn(): Promise<void>
  add(): Promise<void>
  notNow(): void
}

export interface LoginFlow extends LoginHandlers {
  view: Store<LoginState>
  /** From the start again, nothing typed kept. */
  reset(): void
  /** The offer is up: the browser is signed in, and the board waits behind the offer. */
  offering(): boolean
}

/** Where passkeys are made and used (navigator.credentials). */
export type PasskeyCredentials = Pick<CredentialsContainer, 'get' | 'create'>

export interface LoginDeps {
  /** Signed in: the gate asks hello again and shows the board. */
  signedIn(): void
  credentials?(): PasskeyCredentials
}

/** The person closed the browser's passkey sheet, or it timed out: nothing to say. */
const cancelled = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
/** The board's reason in an answer, else its status. */
const reasonOf = (res: Response, body: unknown): string =>
  isReply(body) && typeof body.error === 'string' ? body.error : String(res.status)
/** A sign-in's answer as a note (models/login.ts), its Retry-After read. */
const noteOf = (res: Response, body: unknown) => loginNote(res.status, body, res.headers.get('retry-after'))
/** A code as typed or pasted ("123 456"): its digits. */
const digits = (code: string): string => code.replace(/\s+/g, '')

/** The login screen's steps, against the board's login routes. */
export function loginFlow(deps: LoginDeps): LoginFlow {
  const view = new Store<LoginState>(START)
  const set = (patch: Partial<LoginState>) => view.set({ ...view.get(), ...patch })
  const credentials = () => deps.credentials?.() ?? navigator.credentials
  const signedIn = () => {
    set({ step: 'in', busy: true, note: null, fields: START.fields })
    deps.signedIn()
  }
  /** Starts an action unless one is on its way. */
  const begin = (): boolean => {
    if (view.get().busy) return false
    set({ busy: true, note: null })
    return true
  }

  return {
    view,
    reset: () => view.set(START),
    offering: () => view.get().step === 'offer',
    openForm: () => set({ form: true, note: null }),
    type: (field, value) => set({ fields: { ...view.get().fields, [field]: value } }),

    async passkey() {
      if (!begin()) return
      try {
        const res = await postJson('/api/login/passkey/options', {})
        const body = await replyOf(res)
        const publicKey = res.ok ? requestOptions(body) : null
        if (!publicKey)
          return set({ busy: false, note: noteOf(res, body) ?? { kind: 'failed', why: reasonOf(res, body) } })
        const cred = await credentials().get({ publicKey })
        if (!cred) return set({ busy: false })
        const answer = await postJson('/api/login/passkey', assertionJson(cred as PublicKeyCredential))
        if (answer.ok) return signedIn()
        const note = noteOf(answer, await replyOf(answer))
        set({ busy: false, note: note?.kind === 'wrong' ? { kind: 'passkey' } : note })
      } catch (err) {
        set({ busy: false, note: cancelled(err) ? null : { kind: 'failed', why: messageOf(err) } })
      }
    },

    async signIn() {
      if (!begin()) return
      const { password, code } = view.get().fields
      try {
        const res = await postJson('/api/login/password', { password, code: digits(code) })
        if (!res.ok) return set({ busy: false, note: noteOf(res, await replyOf(res)) })
        // The cookie is set: the board is there, behind the offer while it is up.
        if (!passkeyMade() && passkeysHere()) return set({ step: 'offer', busy: false, fields: START.fields })
        signedIn()
      } catch (err) {
        set({ busy: false, note: { kind: 'failed', why: messageOf(err) } })
      }
    },

    async add() {
      if (!begin()) return
      try {
        const res = await postJson('/api/login/passkey/add/options', { code: digits(view.get().fields.next) })
        const body = await replyOf(res)
        if (res.status === 403 && reasonOf(res, body) === 'code')
          return set({ busy: false, note: { kind: 'wrongCode' } })
        const publicKey = res.ok ? creationOptions(body) : null
        if (!publicKey) return set({ busy: false, note: { kind: 'addFailed', why: reasonOf(res, body) } })
        const cred = await credentials().create({ publicKey })
        if (!cred) return set({ busy: false })
        const saved = await postJson('/api/login/passkey/add', attestationJson(cred as PublicKeyCredential))
        if (!saved.ok)
          return set({ busy: false, note: { kind: 'addFailed', why: reasonOf(saved, await replyOf(saved)) } })
        markPasskeyMade()
        signedIn()
      } catch (err) {
        set({ busy: false, note: cancelled(err) ? null : { kind: 'addFailed', why: messageOf(err) } })
      }
    },

    notNow: signedIn,
  }
}

export interface LoginCardProps {
  state: LoginState
  t: Translator
  /** This browser can use passkeys (window.PublicKeyCredential). */
  passkeys: boolean
  on: LoginHandlers
}

/** The login screen's card, under the app's icon (RemoteGate draws the screen around it). */
export function LoginCard({ state, t, passkeys, on }: LoginCardProps) {
  const note = state.note && (
    <p className="phone-note" role="status">
      {noteText(state.note, t)}
    </p>
  )
  if (state.step === 'in')
    return (
      <>
        <h1>{t('login.title')}</h1>
        <span className="phone-spinner" role="progressbar" aria-label={t('login.title')} />
      </>
    )
  if (state.step === 'offer')
    return (
      <>
        <h1>{t('login.addTitle')}</h1>
        <p>{t('login.addNote')}</p>
        {note}
        <form
          className="login-form"
          onSubmit={e => {
            e.preventDefault()
            void on.add()
          }}
        >
          <label className="login-field">
            <span className="login-label">{t('login.nextCode')}</span>
            <input
              className="login-input"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={state.fields.next}
              onChange={e => on.type('next', e.target.value)}
            />
          </label>
          <button type="submit" className="button primary phone-action" disabled={state.busy}>
            {t('login.add')}
          </button>
          <button
            type="button"
            className="button phone-action login-other"
            disabled={state.busy}
            onClick={() => on.notNow()}
          >
            {t('login.notNow')}
          </button>
        </form>
      </>
    )
  const form = !passkeys || state.form
  return (
    <>
      <h1>{t('login.title')}</h1>
      {note}
      {passkeys && (
        <button
          type="button"
          className={form ? 'button phone-action' : 'button primary phone-action'}
          disabled={state.busy}
          onClick={() => void on.passkey()}
        >
          {t('login.passkey')}
        </button>
      )}
      {form ? (
        <form
          className="login-form"
          onSubmit={e => {
            e.preventDefault()
            void on.signIn()
          }}
        >
          {/* The one user there is, so that a password manager keeps the password under a name. */}
          <input type="text" name="username" autoComplete="username" defaultValue="owner" hidden />
          <label className="login-field">
            <span className="login-label">{t('login.password')}</span>
            <input
              className="login-input"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={state.fields.password}
              onChange={e => on.type('password', e.target.value)}
            />
          </label>
          <label className="login-field">
            <span className="login-label">{t('login.code')}</span>
            <input
              className="login-input"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={state.fields.code}
              onChange={e => on.type('code', e.target.value)}
            />
          </label>
          <button type="submit" className="button primary phone-action" disabled={state.busy}>
            {t('login.signIn')}
          </button>
        </form>
      ) : (
        <button type="button" className="button phone-action login-other" onClick={() => on.openForm()}>
          {t('login.usePassword')}
        </button>
      )}
    </>
  )
}
