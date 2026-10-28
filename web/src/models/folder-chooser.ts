// The profile sync's folder picker (components/access/FolderChooser.tsx), as a model: a folder's
// listing on either side (this computer's from POST /api/fs/dirs, the server's from the sync's
// `sync-dirs`), its path as breadcrumbs, a folder inside it. Pure.

/** The side a folder is on: this computer, or the server (listed by the sync as its board's user). */
export type Side = 'pc' | 'server'

/** A folder as the picker shows it: '' with `roots` is the top of this computer (home and the drives). */
export interface Listing {
  path: string
  /** '' at the top. */
  parent: string
  entries: string[]
  sep: string
  roots: { name: string; path: string }[]
  error: string | null
}

/** A step of the breadcrumbs: its name and the path it opens. */
export interface Crumb {
  name: string
  path: string
}

/** The folders of a path, from its root: C:\migo\x is C: › migo › x, /home/agent is / › home › agent. */
export function crumbs(path: string, sep: string): Crumb[] {
  if (path === '') return []
  if (sep === '\\') {
    const parts = path.split(/[\\/]+/).filter(Boolean)
    const [drive = '', ...rest] = parts
    const out: Crumb[] = [{ name: drive, path: `${drive}\\` }]
    for (let i = 0; i < rest.length; i++)
      out.push({ name: rest[i] as string, path: [drive, ...rest.slice(0, i + 1)].join('\\') })
    return out
  }
  const rest = path.split('/').filter(Boolean)
  return [{ name: '/', path: '/' }, ...rest.map((name, i) => ({ name, path: `/${rest.slice(0, i + 1).join('/')}` }))]
}

/** A folder's own folder `name`. */
export const inside = (path: string, name: string, sep: string): string =>
  path.endsWith(sep) || path.endsWith('/') ? `${path}${name}` : `${path}${sep}${name}`

/** Folders in the order the picker lists them: the hidden ones (.name) last, numbers as numbers. */
export const sortFolders = (names: readonly string[]): string[] =>
  [...names].sort(
    (a, b) =>
      Number(a.startsWith('.')) - Number(b.startsWith('.')) ||
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  )

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** This computer's folder as POST /api/fs/dirs answers it ('' its roots); null for no answer. */
export function pcListing(r: unknown): Listing | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const roots = Array.isArray(o.roots)
    ? o.roots.flatMap(x =>
        x && typeof x === 'object' && typeof x.name === 'string' && typeof x.path === 'string'
          ? [{ name: x.name, path: x.path }]
          : [],
      )
    : []
  const path = typeof o.path === 'string' ? o.path : ''
  const error =
    o.exists === false ? (o.slow === true ? 'slow' : 'missing') : o.dir === false ? 'notDir' : (o.error ?? null)
  return {
    path,
    parent: typeof o.parent === 'string' ? o.parent : '',
    entries: sortFolders(strings(o.entries)),
    sep: typeof o.sep === 'string' ? o.sep : path.includes('/') && !path.includes('\\') ? '/' : '\\',
    roots,
    error: typeof error === 'string' ? error : null,
  }
}

/** The server's folder as the sync's `sync-dirs` answers it; null when it was refused. */
export function serverListing(r: Record<string, unknown> | null): Listing | null {
  if (r?.ok !== true || typeof r.path !== 'string') return null
  return {
    path: r.path,
    parent: typeof r.parent === 'string' ? r.parent : '',
    entries: sortFolders(strings(r.entries)),
    sep: '/',
    roots: [],
    error: typeof r.error === 'string' ? r.error : null,
  }
}
