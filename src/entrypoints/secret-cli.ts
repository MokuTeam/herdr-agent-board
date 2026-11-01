// `board secret request|status|cancel|requests|sinks` (#273, services/secrets.ts): an agent asks
// the owner for values it must not be handed in the chat, and learns what came of it. It takes no
// value and prints none: the owner fills the form on the board, and the board writes the sink.
// The rest of `board secret` (set, list, rm, get, file) is the board's own store, in cli.ts.
//
//   board secret request --title "<what for>" [--sink <id>] [--field <name>[:shown][:once]]...
//                  [--param <name>=<value>]... [--global | --profile <id>] [--expires 30m] [--no-wait]
//                  waits until the owner answers or it expires (run it in the background), then
//                  prints ok · <id> · <where it went> · <time>, or declined / expired · <id>.
//                  Where config.json defines no sink, it goes to the board's own store (`store`,
//                  no --sink needed): the fields are the variables' names, kept for this session,
//                  or with --profile <id> that profile's sessions, or with --global every session
//   board secret status <id> [--wait]    board secret cancel <id>    board secret requests
//   board secret sinks    the sinks there are, what each takes

import { readCard } from '../adapters/cards.ts'
import { t } from '../core/lang.ts'
import {
  DEFAULT_EXPIRES_MS,
  onlyStore,
  parseExpires,
  parseField,
  problemsText,
  requestsOf,
  type SecretField,
  type SecretRequest,
  statusLine,
  statusOf,
} from '../core/secrets.ts'
import type { Config } from '../core/types.ts'
import { askSecret, cancelSecret, expireIfDue, ownRequest, secretsOf } from '../services/secrets.ts'

export const SECRET_USAGE = `board secret request --title "<what for>" [--sink <id>] [--field <name>[:shown][:once]]... [--param <name>=<value>]... [--global | --profile <id>] [--expires 30m] [--no-wait]
board secret status <id> [--wait] | cancel <id> | requests | sinks`

export interface SecretContext {
  cfg: Pick<Config, 'secrets'>
  /** The session that runs it; null outside one. */
  session: { key: string; name: string } | null
  out: (line: string) => void
  /** How long a wait sleeps between looks (tests make it short). */
  pollMs?: number
}

/** Exit codes: 0 written, 2 pending (--no-wait), 3 declined, expired or cancelled, 1 a usage error. */
const CODE: Record<SecretRequest['status'], number> = { ok: 0, pending: 2, declined: 3, expired: 3, cancelled: 3 }

class Usage extends Error {}

/** A flag's values in order, each taken out of `args`. */
function take(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = args.indexOf(flag); i >= 0; i = args.indexOf(flag)) {
    const v = args[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Usage(`${flag} needs a value`)
    out.push(v)
    args.splice(i, 2)
  }
  return out
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}

/** Waits until the request is settled or expired, looking at the card once a `pollMs`. */
async function settled(key: string, r: SecretRequest, pollMs: number): Promise<SecretRequest> {
  let now = r
  for (;;) {
    now = expireIfDue(key, ownRequest(key, r.id) ?? now)
    if (statusOf(now, Date.now()) !== 'pending') return now
    await Bun.sleep(Math.min(pollMs, Math.max(50, now.expires - Date.now())))
  }
}

export async function secretCmd(argv: string[], ctx: SecretContext): Promise<number> {
  const args = [...argv]
  const sub = args.shift() ?? ''
  const pollMs = ctx.pollMs ?? 1000
  try {
    if (sub === 'sinks') {
      const conf = secretsOf(ctx.cfg)
      if (conf.problems.length) ctx.out(`config: ${problemsText(conf.problems, t)}`)
      if (!conf.sinks.size) ctx.out(t('secret.err.noSinks'))
      for (const s of conf.sinks.values()) {
        const params = Object.keys(s.params)
        const parts = [
          s.id,
          s.kind,
          s.title,
          s.fields
            ? `fields: ${s.fields.join(', ')}`
            : s.kind === 'env'
              ? `fields: ${s.vars?.join(', ') ?? s.pattern}`
              : s.kind === 'store'
                ? 'fields: the variables you name (board secret get <NAME> reads one)'
                : 'fields: you name them',
          s.kind === 'store'
            ? 'for: this session, or --profile <id>, or --global'
            : params.length
              ? `params: ${params.join(', ')}`
              : '',
          s.problems.length ? `does not check out: ${problemsText(s.problems, t)}` : '',
        ]
        ctx.out(parts.filter(Boolean).join(' · '))
      }
      return 0
    }
    if (!ctx.session) throw new Usage('run it from a session: the request goes on its card')
    const { key } = ctx.session
    switch (sub) {
      case 'request': {
        const noWait = flag(args, '--no-wait')
        const global = flag(args, '--global')
        const [title = ''] = take(args, '--title')
        const [given = ''] = take(args, '--sink')
        const [profile] = take(args, '--profile')
        const [expires] = take(args, '--expires')
        const fields: SecretField[] = take(args, '--field').map(spec => {
          const f = parseField(spec)
          if (!f) throw new Usage(`not a field: ${spec} (<name>[:shown][:once])`)
          return f
        })
        const params: Record<string, string> = {}
        for (const p of take(args, '--param')) {
          const at = p.indexOf('=')
          if (at <= 0) throw new Usage(`not a parameter: ${p} (<name>=<value>)`)
          params[p.slice(0, at)] = p.slice(at + 1)
        }
        if (args.length) throw new Usage(`unexpected: ${args.join(' ')}`)
        // no --sink: the board's own store, when it is the one sink there is
        const conf = secretsOf(ctx.cfg)
        const sink = given || onlyStore(conf) || ''
        if (!sink) throw new Usage('--sink <id> names where the values go (board secret sinks)')
        // --global and --profile: the store's scope, as `board secret set` has them
        if (global || profile !== undefined) {
          if (conf.sinks.get(sink)?.kind !== 'store') throw new Usage(t('secret.err.storeFlags', { sink }))
          if (global && profile !== undefined) throw new Usage('one scope at most: --global or --profile')
          if (params.scope !== undefined || params.profile !== undefined || params.session !== undefined)
            throw new Usage('--global and --profile say the scope: no --param scope, profile or session beside them')
          Object.assign(params, global ? { scope: 'global' } : { scope: 'profile', profile })
        }
        const expiresMs = expires === undefined ? DEFAULT_EXPIRES_MS : parseExpires(expires)
        if (expiresMs === null) throw new Usage('--expires is 1m to 24h: 30m, 2h, 1d')
        const asked = askSecret(ctx.cfg, ctx.session, { title, sink, params, fields, expiresMs })
        if (!asked.ok) {
          ctx.out(`error · ${asked.error}`)
          return 1
        }
        ctx.out(`${statusLine(asked.request, Date.now())} · the owner fills it in on the board`)
        if (noWait) return CODE.pending
        const done = await settled(key, asked.request, pollMs)
        ctx.out(statusLine(done, Date.now()))
        return CODE[done.status]
      }
      case 'status': {
        const wait = flag(args, '--wait')
        const id = args[0] ?? ''
        const r = ownRequest(key, id)
        if (!r) throw new Usage(`no request ${id} of this session (board secret requests)`)
        const now = wait ? await settled(key, r, pollMs) : expireIfDue(key, r)
        ctx.out(statusLine(now, Date.now()))
        return CODE[statusOf(now, Date.now())]
      }
      case 'cancel': {
        const id = args[0] ?? ''
        const r = cancelSecret(key, id)
        if (!r) throw new Usage(`no request ${id} of this session (board secret requests)`)
        ctx.out(statusLine(r, Date.now()))
        return 0
      }
      case 'requests': {
        const list = requestsOf(readCard(key)?.secrets)
        if (!list.length) ctx.out('no secret requests of this session')
        for (const r of list) ctx.out(`${statusLine(r, Date.now())} · ${r.title}`)
        return 0
      }
      default:
        throw new Usage(SECRET_USAGE)
    }
  } catch (err) {
    if (!(err instanceof Usage)) throw err
    ctx.out(`usage: ${err.message === SECRET_USAGE ? SECRET_USAGE : `${err.message}\n${SECRET_USAGE}`}`)
    return 1
  }
}
