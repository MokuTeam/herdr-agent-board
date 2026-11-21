// The secrets a node's profile needs, from its master's sync (#604, docs/design/nodes 10, items 3
// and 4): `POST /api/node/bundle/<profile>/secrets` on the master door, sent only for a device whose
// owner lets it have them (`nodes.devices.<id>.giveSecrets`). The values the bundle replaced by
// references go into the profile's env file (`<state>/node/env/<profile>.env`, which a launch here
// reads) under those names, and a secret file a hook's script reads goes into its place in the
// profile folder, both through the file sink's own writer (adapters/secret-sinks.ts): the same file,
// the same lock and the same private rights as a sink the owner fills by hand, whose other lines stay.
//
// The node keeps which names and files the bundle gave (`<state>/node/bundle-secrets/<profile>.json`:
// names, and the SHA-256 of each file it wrote), so one the master no longer sends is taken out, one
// given by hand under another name is never touched, a file changed here since the bundle wrote it
// is neither overwritten nor removed, and one the master could not send this time stays. A value or a
// file that did not change is not written again. A value is never in an answer, a log line, the audit
// or a record: names and paths only.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureFolder, fileSha, linkOnTheWay, removeFile, writeWhole } from '../../adapters/bundle-files.ts'
import { isRecord } from '../../adapters/json-store.ts'
import { envValue, type WriteInput, type WriteResult } from '../../adapters/secret-sinks.ts'
import { bundlePath, dataFile } from '../../core/bundle.ts'
import { boardOwnsName, parseEnvFile } from '../../core/node-env.ts'
import type { Profile } from '../../core/profiles.ts'
import type { FileSink } from '../../core/secrets.ts'
import type { Answer } from './bundle.ts'

/** A secret value of the bundle, at most this long. */
export const MAX_SECRET_CHARS = 64 * 1024
/** A secret file of the bundle, at most this many characters. */
export const MAX_SECRET_FILE_CHARS = 1024 * 1024
/** At most this many variables and files in one request. */
export const MAX_SECRETS = 256

export interface NodeSecretsDeps {
  /** `<state>/node`. */
  dir: string
  /** This board's shown profiles. */
  profiles(): readonly Profile[]
  /** The file sink's writer (adapters/secret-sinks.ts writeSink). */
  write(input: WriteInput): Promise<WriteResult>
  /** One line of the secrets' audit, names only (services/secrets.ts auditBundle). */
  audit(line: Record<string, unknown>): void
  log(text: string): void
}

export interface NodeSecrets {
  /**
   * POST /api/node/bundle/<profile>/secrets: `{ env: { <name>: <value> }, files: [{ path, text }], keep: [<path>] }`;
   * `keep`: files the master has and could not send this time, which are not taken out.
   */
  give(profile: string, body: unknown): Promise<Answer>
}

const PROFILE_ID = /^[A-Za-z0-9_][\w.-]{0,63}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
/** A value one env line holds as the sink writes it: no line break, no NUL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a NUL is refused
const ONE_LINE = /^[^\r\n\u0000]*$/

/**
 * What the node has from the bundle of one profile: names, and each file by its path with the
 * SHA-256 of what the bundle wrote there, so a file changed here since (a hook refreshing its token,
 * a sink filling a key) is neither overwritten nor removed. Never a value.
 */
interface Given {
  env: string[]
  files: Record<string, string>
}

const SHA = /^[0-9a-f]{64}$/

function givenOf(raw: unknown): Given {
  const words = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  if (!isRecord(raw)) return { env: [], files: {} }
  const files: Record<string, string> = {}
  if (isRecord(raw.files))
    for (const [p, s] of Object.entries(raw.files)) if (typeof s === 'string' && SHA.test(s)) files[p] = s
  return { env: words(raw.env), files }
}

/** A file sink the writer takes, made here for one write: never in config.json, never asked for. */
function sinkFor(folder: string, name: string, format: 'env' | 'text', template: unknown): FileSink {
  return {
    id: 'bundle',
    kind: 'file',
    title: 'bundle',
    params: {},
    fields: null,
    raw: null,
    once: [],
    problems: [],
    folder,
    name,
    format,
    template,
    at: null,
  }
}

export function createNodeSecrets(deps: NodeSecretsDeps): NodeSecrets {
  const recordFile = (profile: string): string => join(deps.dir, 'bundle-secrets', `${profile}.json`)
  let queue: Promise<unknown> = Promise.resolve()

  function record(profile: string): Given {
    try {
      return givenOf(JSON.parse(readFileSync(recordFile(profile), 'utf8')))
    } catch {
      return { env: [], files: {} }
    }
  }

  async function give(profile: Profile, body: unknown): Promise<Answer> {
    const b = isRecord(body) ? body : {}
    const env = isRecord(b.env) ? b.env : {}
    const files = Array.isArray(b.files) ? b.files : []
    if (Object.keys(env).length + files.length > MAX_SECRETS) return { status: 413, body: { error: 'too-many' } }
    // What this node will not take, by name or path: a name the board sets itself, a value no env line
    // holds, a path that leaves the profile folder or is no data file.
    const refused: string[] = []
    const values: Record<string, string> = {}
    for (const [name, v] of Object.entries(env)) {
      if (!ENV_NAME.test(name) || boardOwnsName(name)) refused.push(name.slice(0, 128))
      else if (typeof v !== 'string' || v.length > MAX_SECRET_CHARS || !ONE_LINE.test(v) || envValue(v) === null)
        refused.push(name)
      else values[name] = v
    }
    const texts: { path: string; text: string }[] = []
    for (const f of files) {
      const path = isRecord(f) && typeof f.path === 'string' ? f.path : ''
      const text = isRecord(f) ? f.text : undefined
      const ok =
        bundlePath(path) !== null &&
        dataFile(path.split('/').pop() ?? '') &&
        typeof text === 'string' &&
        text.length <= MAX_SECRET_FILE_CHARS &&
        !linkOnTheWay(profile.dir, path)
      if (ok) texts.push({ path, text: text as string })
      else refused.push(path.slice(0, 200))
    }
    // Named by the master and not sent this time (it could not read them): never taken out for that.
    const keep = new Set(Array.isArray(b.keep) ? b.keep.filter((p): p is string => typeof p === 'string') : [])
    for (const r of refused) keep.add(r)
    const had = record(profile.id)

    // The env file: what changed, and what the bundle gave before and gives no more.
    const envFolder = join(deps.dir, 'env')
    const envName = `${profile.id}.env`
    let there: Record<string, string> = {}
    try {
      there = parseEnvFile(readFileSync(join(envFolder, envName), 'utf8')).vars
    } catch {}
    const changed = Object.keys(values).filter(n => !Object.hasOwn(there, n) || there[n] !== values[n])
    const removed = had.env.filter(n => !Object.hasOwn(values, n) && !keep.has(n) && Object.hasOwn(there, n))
    if (changed.length || removed.length) {
      ensureFolder(envFolder)
      const fields = changed.map((_, i) => ({ name: `v${i}`, hidden: true }))
      const template = Object.fromEntries(changed.map((n, i) => [n, `{{v${i}}}`]))
      const r = await deps.write({
        sink: sinkFor(envFolder, envName, 'env', template),
        params: {},
        fields,
        values: Object.fromEntries(changed.map((n, i) => [`v${i}`, values[n] as string])),
        remove: removed,
      })
      // The writer's reason is a word of the board's, never a value: said, and nothing recorded.
      if (!r.ok) return { status: 500, body: { error: 'env', detail: r.error } }
    }

    // The files: written where they differ, unless one there is the node's own or changed here since.
    const owned = new Map(Object.entries(had.files))
    const written: string[] = []
    const same: string[] = []
    const kept: { path: string; why: string }[] = []
    const shas: Record<string, string> = {}
    for (const { path, text } of texts) {
      const target = join(profile.dir, ...path.split('/'))
      const sha = fileSha(target)
      if (sha === sha256(text)) {
        same.push(path)
        shas[path] = sha
        continue
      }
      if (sha !== null && !owned.has(path)) {
        kept.push({ path, why: 'not-owned' })
        continue
      }
      if (sha !== null && owned.get(path) !== sha) {
        // Owned, and not what the bundle wrote: changed here, so left as it is and still the bundle's.
        kept.push({ path, why: 'changed' })
        shas[path] = owned.get(path) as string
        continue
      }
      ensureFolder(dirname(target))
      const r = await deps.write({
        sink: sinkFor(dirname(target), path.split('/').pop() ?? '', 'text', '{{v0}}'),
        params: {},
        fields: [{ name: 'v0', hidden: true }],
        values: { v0: text },
      })
      if (r.ok) {
        written.push(path)
        shas[path] = sha256(text)
      } else {
        kept.push({ path, why: r.error === 'secret.err.notFile' ? 'not-file' : 'write' })
        if (owned.has(path)) shas[path] = owned.get(path) as string
      }
    }
    const sent = new Set(texts.map(t => t.path))
    const gone: string[] = []
    for (const [path, wrote] of owned) {
      if (sent.has(path)) continue
      const target = join(profile.dir, ...path.split('/'))
      const sha = fileSha(target)
      // Kept and still the bundle's: one the master could not send, one changed here since.
      if (keep.has(path) || (sha !== null && sha !== wrote)) {
        shas[path] = wrote
        continue
      }
      if (sha === null || bundlePath(path) === null || linkOnTheWay(profile.dir, path)) continue
      removeFile(profile.dir, target)
      gone.push(path)
    }

    const now: Given = {
      env: [
        ...new Set([...Object.keys(values), ...had.env.filter(n => keep.has(n) && Object.hasOwn(there, n))]),
      ].sort(),
      files: Object.fromEntries(Object.entries(shas).sort(([a], [b]) => (a < b ? -1 : 1))),
    }
    const before = {
      env: [...had.env].sort(),
      files: Object.fromEntries(Object.entries(had.files).sort(([a], [b]) => (a < b ? -1 : 1))),
    }
    if (JSON.stringify(now) !== JSON.stringify(before))
      writeWhole(recordFile(profile.id), `${JSON.stringify(now, null, 2)}\n`, 0o600)
    if (changed.length || removed.length || written.length || gone.length) {
      deps.audit({
        op: 'bundle-given',
        profile: profile.id,
        names: changed,
        removed,
        files: written,
        filesRemoved: gone,
      })
      deps.log(
        `node secrets ${profile.id}: ${changed.length} variable(s) written, ${removed.length} removed, ${written.length} file(s) written, ${gone.length} removed`,
      )
    }
    return {
      status: 200,
      body: {
        ok: true,
        env: now.env,
        written: changed.sort(),
        removed: removed.sort(),
        files: Object.keys(now.files),
        filesWritten: written.sort(),
        filesRemoved: gone.sort(),
        kept,
        refused,
      },
    }
  }

  return {
    give(id, body) {
      const profile = PROFILE_ID.test(id) ? deps.profiles().find(p => p.id === id && !p.hidden) : undefined
      if (!profile) return Promise.resolve({ status: 404, body: { error: 'profile' } })
      // One at a time: two syncs of one profile never write its env file over each other.
      const run = queue.then(() =>
        give(profile, body).catch((): Answer => {
          // Whatever threw may have held a value in its message: none of it goes out or into the log.
          deps.log(`node secrets ${profile.id}: failed`)
          return { status: 500, body: { error: 'server' } }
        }),
      )
      queue = run
      return run
    },
  }
}
