// The web server's setup with the server mode's target (the board-on-own-server spec, call 7): the
// board's own socket and user instead of the tunnel's, so no tunnel user, keys file or sshd fence;
// the socket's folder alone of step 1, for the board's user; the cases 1-4 in front of that socket
// as for the tunnel. A tunnel's setup (no `server`) is what it was: its tests, the differential
// test and a byte comparison of the generated scripts against main hold it.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import { BOARD_SOCKET, serverWanted } from '../../src/core/server-install.ts'
import { plainPlan } from '../../src/core/server-plain.ts'
import {
  buildPlan,
  chooseCase,
  type Plan,
  type SetupCase,
  setupRecord,
  stepOneNeeds,
  undoPlan,
  type Wanted,
  whose,
} from '../../src/core/server-plan.ts'
import { runScript } from '../../src/core/server-script.ts'
import { factsFor, recordFor, stepOneMissing } from '../support/server-facts.ts'

const W: Wanted = serverWanted('workbench.example.com', 'agent')
const TUNNEL: Wanted = {
  user: 'boardtunnel',
  socket: '/var/lib/boardtunnel/board.sock',
  domain: 'board.example.com',
  publicPort: null,
}
const FOLDER = '/var/lib/agent-board'
const O = { id: 'p1', docker: true }
const en = translator('en')
/** The board's user as Look finds it: a login (uid 1000, bash), made by the installer, not the tunnel's. */
const AGENT = { uid: 1000, group: 'agent', shell: '/bin/bash', ours: false, admin: false }

/** What Look finds on a server before the install's web server step: no socket folder yet, the board's user there. */
function fresh(c: Parameters<typeof factsFor>[0]): ServerFacts {
  return { ...stepOneMissing(c, 'debian13', { user: AGENT, keys: 'none' }), fence: {} }
}

const planOf = (f: ServerFacts, w: Wanted = W): Plan => {
  const made = buildPlan(f, w, O)
  if (!('steps' in made)) throw new Error(`no plan: ${JSON.stringify(made.why)}`)
  return made
}
const ids = (p: Plan): string[] => p.steps.map(s => s.id)

describe('the server mode as the setup target', () => {
  test('step 1 is the socket folder alone, and only when it is missing', () => {
    expect(stepOneNeeds(fresh('bare'), W)).toEqual({ user: false, folder: true, keys: null, fence: false })
    expect(stepOneNeeds(factsFor('bare'), W)).toEqual({ user: false, folder: false, keys: null, fence: false })
  })

  test('the board user is a login on purpose: not refused as a tunnel user would be', () => {
    const f = fresh('bare')
    expect(chooseCase(f, W).case).toBe('1')
    // the same user as a tunnel's: the owner's login, refused (the tunnel stays as it was)
    const asTunnel = chooseCase(f, { ...TUNNEL, user: 'agent' })
    expect(asTunnel.case).toBeNull()
  })

  for (const c of ['1', '1b', '2', '3a', '3b', '4a', '4b'] as SetupCase[]) {
    test(`case ${c}: no tunnel user, keys file or fence; the folder for the board's user; the domain in front of its socket`, () => {
      const p = planOf({ ...fresh(c === '1' ? 'bare' : c) })
      expect(p.case).toBe(c)
      expect(ids(p)).not.toContain('tunnel-user')
      expect(ids(p)).not.toContain('keys-file')
      expect(ids(p)).not.toContain('sshd-fence')
      const folder = p.steps.find(s => s.id === 'socket-folder')
      expect(folder?.commands).toContain(`sudo install -d -m 2750 -o agent -g "$(id -gn agent)" ${FOLDER}`)
      const all = p.steps.flatMap(s => [...s.commands, ...s.check]).join('\n')
      expect(all).not.toContain('sshd')
      expect(all).not.toContain('authorized_keys')
      expect(all).not.toContain('boardtunnel')
      expect(p.undoTouches.some(t => t.kind === 'reload' && t.what === 'sshd')).toBe(false)
      if (c !== '2') expect(all).toContain(FOLDER)
      if (c === '2') expect(all).toContain(BOARD_SOCKET)
    })
  }

  test("the record marks the server mode: a tunnel's setup of the same user and socket is another's", () => {
    const p = planOf(fresh('bare'))
    const run = runScript(p, W, { id: 'r1', at: '2026-10-27T10:00:00.000Z' })
    expect(run).toContain(`"pair":{"user":"agent","socket":"${BOARD_SOCKET}","server":true}`)
    const rec = recordFor('1', {
      pair: { user: 'agent', socket: BOARD_SOCKET, server: true },
      domain: W.domain,
      address: `https://${W.domain}`,
      items: [{ kind: 'folder', path: FOLDER }],
    })
    const read = setupRecord(JSON.parse(JSON.stringify(rec)))
    expect(read?.pair).toEqual({ user: 'agent', socket: BOARD_SOCKET, server: true })
    expect(read && whose(read, W)).toBe('same')
    const tunnelSame: Wanted = { ...TUNNEL, user: 'agent', socket: BOARD_SOCKET, domain: W.domain }
    expect(read && whose(read, tunnelSame)).toBe('other')
    // a tunnel's record is not the server mode's
    const tunnelRec = setupRecord(JSON.parse(JSON.stringify(recordFor('1'))))
    expect(tunnelRec && whose(tunnelRec, { ...W, user: 'boardtunnel', socket: TUNNEL.socket })).toBe('other')
    // a server record never holds a tunnel user, keys file or fence of its own
    for (const item of [
      { kind: 'user', name: 'agent' },
      { kind: 'keys', path: '/etc/ssh/authorized_keys/agent', dir: false },
      { kind: 'fence', path: '/etc/ssh/sshd_config.d/agent-board-tunnel.conf' },
    ])
      expect(setupRecord(JSON.parse(JSON.stringify({ ...rec, items: [item] })))).toBeNull()
    expect(setupRecord(JSON.parse(JSON.stringify({ ...rec, pair: { ...rec.pair, server: 'yes' } })))).toBeNull()
  })

  test("a tunnel's Look meets the server mode's record: another board's setup, not planned over", () => {
    const rec = recordFor('1', { pair: { user: 'agent', socket: BOARD_SOCKET, server: true }, domain: W.domain })
    const f = { ...factsFor('bare'), record: JSON.parse(JSON.stringify(rec)) }
    expect(chooseCase(f, TUNNEL)).toEqual({ case: null, why: ['otherSetup'] })
    // and the server mode's own Look takes it as its own
    expect(chooseCase(f, W).case).toBe('1')
  })

  test("Undo: the folder the run made goes; nothing of a tunnel's is left by hand", () => {
    const rec = recordFor('1', {
      pair: { user: 'agent', socket: BOARD_SOCKET, server: true },
      domain: W.domain,
      address: `https://${W.domain}`,
      items: [{ kind: 'folder', path: FOLDER }],
    })
    const u = undoPlan(rec, factsFor('bare'), { id: 'u1', removeDocker: false, removeEdited: false })
    expect(ids(u)).toContain('drop-folder')
    expect(ids(u)).not.toContain('by-hand')
    const all = u.steps.flatMap(s => s.commands).join('\n')
    expect(all).not.toContain('userdel')
    expect(all).not.toContain('sshd')
  })

  test('the plan in plain words: no board login, the board handed to their Caddy', () => {
    const one = planOf(fresh('bare'))
    const p1 = plainPlan(fresh('bare'), one, W, en)
    expect(p1.will.join('\n')).not.toContain('login')
    expect(p1.will).toContain(
      'Run a web server of the board’s own for workbench.example.com on 443 and 80; it gets its certificate by itself.',
    )
    const three = fresh('3a')
    const p3 = plainPlan(three, planOf(three), W, en)
    expect(p3.will).toEqual(['Add workbench.example.com to your Caddy and hand it the board.'])
    // the tunnel's words stay the tunnel's
    const t3 = { ...factsFor('3a') }
    const tunnelPlan = buildPlan(t3, TUNNEL, O)
    expect(plainPlan(t3, tunnelPlan, TUNNEL, en).will).toEqual([
      'Add board.example.com to your Caddy and hand it the board’s tunnel.',
    ])
  })
})
