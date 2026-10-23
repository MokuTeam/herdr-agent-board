// The plan in plain words (the simple-setup spec's "The flow, as the owner sees it"): what was
// found (one line), what will be done (two or three lines), Docker's install when the plan has it,
// what is not touched; or, for a server the board does not do, why, in one line. No jargon here:
// no network, container or Caddyfile; the full plan (core/server-plan.ts) is the details. For the
// panel and for the one pasted command. Pure, with no node: import: the page imports it.
import type { Holder, ServerFacts } from './server-facts.ts'
import type { Manual, Plan, Wanted } from './server-plan.ts'
import type { Translator } from './types.ts'

export interface PlainPlan {
  /** What was found: the system and what answers on 443 and 80, with their sites. */
  found: string
  /** What will be done: two or three lines (none when the board does not do this server). */
  will: string[]
  /** Docker to install from its own repository (the plan's tick goes with it); null when it is there. */
  docker: string | null
  /** What is not touched. */
  untouched: string
  /** Why the board does not do this server by itself; null when it does. */
  stop: string | null
}

/** How many of their sites the found line names; the rest are counted. */
const SITES_NAMED = 3
const HOST_NAME = /^(?=.*[a-z])[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
/** The steps that make or remove the board's own login on the server (step 1's parts, the keys file's own apart in Apply). */
const LOGIN_STEPS = [
  'tunnel-user',
  'socket-folder',
  'sshd-fence',
  'drop-user',
  'drop-fence',
  'drop-keys',
  'drop-folder',
]

/** Why the board stops, in plain words: a few kinds for the many reasons (the details name each). */
function stopKind(why: Manual): string {
  switch (why) {
    case 'os':
      return 'os'
    case 'selinux':
    case 'podman':
    case 'rootless':
    case 'userns':
    case 'requiretty':
    case 'noSystemd':
    case 'dockerConflicts':
      return 'system'
    case 'domainServed':
    case 'otherSetup':
    case 'interrupted':
    case 'folder':
    case 'tunnelUser':
    case 'tunnelGroup':
      return why
    default:
      return 'web'
  }
}

const capitalize = (s: string): string => (s ? (s[0] as string).toUpperCase() + s.slice(1) : s)

/** Who answers on a port, in a few words: Caddy, Caddy in Docker, nginx, the board's own, a program. */
function who(f: ServerFacts, h: Holder, t: Translator): string {
  switch (h.kind) {
    case 'free':
      return ''
    case 'split':
      return h.programs.join(', ')
    case 'unit':
    case 'process':
      return h.program === 'caddy' ? 'Caddy' : h.program
    case 'container': {
      const c = f.docker?.containers.find(x => x.id === h.id)
      if (c?.labels['agent-board.role']) return t('server.plain.who.board')
      const caddy = h.program === 'caddy' || /(^|\/)caddy([:@]|$)/.test(c?.image ?? '')
      const name = caddy ? 'Caddy' : (c?.image.split(/[:@]/)[0]?.split('/').at(-1) ?? h.program) || h.program
      return t('server.plain.who.docker', { name })
    }
  }
}

/** Their sites: the names their Caddy or nginx serves, the board's domain apart. */
function sites(f: ServerFacts, w: Wanted, t: Translator): string {
  const names = f.caddy?.hosts.length ? f.caddy.hosts : (f.nginx?.serverNames ?? [])
  const exact = [...new Set(names)].filter(h => HOST_NAME.test(h) && h !== w.domain)
  if (exact.length === 0) return ''
  const named = exact.slice(0, SITES_NAMED).join(', ')
  return exact.length > SITES_NAMED
    ? t('server.plain.sitesMore', { sites: named, more: String(exact.length - SITES_NAMED) })
    : t('server.plain.sites', { sites: named })
}

/** The system and what answers on 443 and 80, one line. */
function foundLine(f: ServerFacts, w: Wanted, t: Translator): string {
  const name = `${capitalize(f.distro.id)} ${f.distro.version}`.trim()
  const system = f.distro.supported ? name : t('server.plain.unsupported', { system: name })
  const [h443, h80] = [f.ports[443], f.ports[80]]
  const [w443, w80] = [who(f, h443, t), who(f, h80, t)]
  const s = sites(f, w, t)
  let web: string
  if (!w443 && !w80) web = t('server.plain.web.none')
  else if (w443 === w80) web = t('server.plain.web.both', { who: w443, sites: s })
  else if (!w80) web = t('server.plain.web.only443', { who: w443, sites: s })
  else if (!w443) web = t('server.plain.web.only80', { who: w80 })
  else web = t('server.plain.web.each', { who443: w443, who80: w80, sites: s })
  return t('server.plain.found', { system, web })
}

/**
 * The plan in plain words, from what Look found and the plan made from it (buildPlan's answer: a
 * plan, an Undo plan, or the reasons the board leaves the server to the owner), for what the
 * panel wants, in `t`'s language.
 */
export function plainPlan(
  f: ServerFacts,
  made: Plan | { case: null; why: Manual[] },
  w: Wanted,
  t: Translator,
): PlainPlan {
  const found = foundLine(f, w, t)
  if (!('steps' in made)) {
    const why = made.why[0] ?? 'os'
    const reason = t(`server.plain.stop.${stopKind(why)}`, { domain: w.domain, user: w.user })
    return {
      found,
      will: [],
      docker: null,
      untouched: t('server.plain.untouched.nothing'),
      stop: t('server.plain.stop', { reason }),
    }
  }
  const ids = made.steps.map(s => s.id)
  const has = (id: string): boolean => ids.includes(id)
  const login = LOGIN_STEPS.some(has)
  const checked = has('fetch-before') || made.steps.some(s => s.commands.some(c => c.includes('nginx-before')))
  const docker = has('docker-install') ? t('server.plain.docker') : null
  const user = { user: w.user }
  if (made.kind === 'undo') {
    const domain = new URL(made.address).hostname
    return {
      found,
      will: [t(login ? 'server.plain.will.undoLogin' : 'server.plain.will.undo', { domain, ...user })],
      docker: null,
      untouched: t(checked ? 'server.plain.untouched.undoChecked' : 'server.plain.untouched.undo'),
      stop: null,
    }
  }
  const will: string[] = []
  if (login) will.push(t('server.plain.will.login', user))
  else if (has('keys-file')) will.push(t('server.plain.will.key', user))
  // a keys file there already is written over whole: what it held goes
  if (has('keys-file') && f.stepOne?.keys === 'other') will.push(t('server.plain.will.keysReplaced', user))
  if (made.kind === 'nothing' && will.length === 0)
    return {
      found,
      will: [t('server.plain.will.nothing')],
      docker: null,
      untouched: t('server.plain.untouched.nothing'),
      stop: null,
    }
  const params = { domain: w.domain, address: made.address }
  if (made.kind === 'update') will.push(t('server.plain.will.update', params))
  else if (made.kind === 'apply' || made.kind === 'nothing') will.push(t(`server.plain.will.case.${made.case}`, params))
  const theirs = (port: 443 | 80): string => who(f, f.ports[port], t)
  let untouched: string
  if (made.case === '1') untouched = t('server.plain.untouched.all')
  else if (made.case === '1b') untouched = t('server.plain.untouched.port', { who: theirs(80), port: '80' })
  else if (made.case === '4a') untouched = t('server.plain.untouched.port', { who: theirs(443), port: '443' })
  else untouched = t(checked ? 'server.plain.untouched.sitesChecked' : 'server.plain.untouched.sites')
  return { found, will, docker, untouched, stop: null }
}
