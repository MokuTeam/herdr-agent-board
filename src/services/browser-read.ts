// The agent's browser read compactly (services/browser-mcp.ts joins these tools to the list):
// read_page, the selected page's main content as short Markdown-ish text, and list_interactive,
// what can be acted on there with take_snapshot's own uids. A page costs a few thousand characters
// a call, where take_snapshot's whole accessibility tree is often 50,000 to 150,000.
//
// read_page runs pageText in the page through chrome-devtools-mcp's evaluate_script (the wrapper's
// own call, never the agent's): the text is made there, with no service outside, and cut into
// parts here. list_interactive takes a snapshot through chrome-devtools-mcp (take_snapshot, the
// wrapper's own call) and keeps its actionable lines: the snapshot is the page's latest, so click,
// fill and the others take its uids as they are. Both only look: they go on while the owner has
// the browser, as take_snapshot does.

type Msg = Record<string, unknown>
const isRecord = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v)

export const READ_TOOLS = [
  {
    name: 'read_page',
    description:
      'Reads the selected page as compact text: its main content (title, headings, paragraphs, lists, tables as | rows |, links as [text](short href: a path on this site, host/path elsewhere)), without navigation, menus, footers, banners, scripts or hidden parts. A part of a few thousand characters per call, where take_snapshot gives the whole accessibility tree (often 50,000-150,000): use this first to read a page, and list_interactive to find what to click or fill. A long page comes in parts: the answer says its length and the next offset. `find` gives only the places with a text in them, with their offsets. Only looks, so it works while the owner has the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'characters of text in the answer (default 6000, 500-40000)' },
        offset: {
          type: 'number',
          description: 'where to start, in characters: the next offset a previous answer gave',
        },
        selector: {
          type: 'string',
          description:
            'a CSS selector: only that part of the page (e.g. "table.infobox", "#results"); "body": the whole page, navigation and footers too',
        },
        find: {
          type: 'string',
          description: 'a text to look for (case does not matter): only the lines with it, with lines around them',
        },
        context: { type: 'number', description: 'with find: lines before and after each match (default 1)' },
        links: { type: 'boolean', description: 'false: links as their text only, no hrefs (shorter); default true' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_interactive',
    description:
      "Lists what can be acted on in the selected page (links, buttons, text fields, selects, checkboxes, radios, tabs, menu items), one line each: uid, role, label and state (value, checked, expanded, disabled; never a password), under the headings and landmarks they are in. The uids are take_snapshot's (this takes a fresh one): pass them to click, fill, fill_form, hover, drag, upload_file. A few thousand characters per call, where take_snapshot is often 50,000-150,000: use this to find an element, and take_snapshot only when you need the whole tree. A long list comes in parts (offset); `find` keeps the elements whose line has a text in it; links: false leaves links out (fields and buttons only). After the page changes, call it again for fresh uids. Only looks, so it works while the owner has the browser.",
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'only elements whose line has this text (case does not matter)' },
        links: { type: 'boolean', description: 'false: no links (fields, buttons and the rest only); default true' },
        offset: { type: 'number', description: 'the element to start at: the next offset a previous answer gave' },
        maxChars: { type: 'number', description: 'characters in the answer (default 6000, 500-40000)' },
      },
      additionalProperties: false,
    },
  },
] as const

export const READ_TOOL_NAMES: ReadonlySet<string> = new Set(READ_TOOLS.map(t => t.name))

/** What chrome-devtools-mcp's own tools are told on top of their descriptions: the compact ones first. */
export const STEER: Readonly<Record<string, string>> = {
  take_snapshot:
    ' Large: the whole tree of a page, often 50,000-150,000 characters. To read a page use read_page, and to find the uid to click or fill use list_interactive (the same uids, a few thousand characters); take_snapshot only when you need the whole tree.',
  wait_for:
    ' Its answer carries the whole take_snapshot tree of the page (large); read_page or list_interactive after it read the page compactly.',
}

/** chrome-devtools-mcp's tool list with STEER added to the descriptions it names. */
export function steered(tools: unknown[]): unknown[] {
  return tools.map(t => {
    if (!isRecord(t) || typeof t.name !== 'string' || !(t.name in STEER) || typeof t.description !== 'string') return t
    return { ...t, description: t.description + STEER[t.name] }
  })
}

// ---------------------------------------------------------------- read_page: in the page

export interface PageText {
  title: string
  url: string
  /** What was read: "main", "article", "body" or the selector. */
  root: string
  text: string
  /** Blocks left out as navigation, menus, footers, banners and the like. */
  dropped: number
  /** The page could not be read so (a selector that matches nothing, or is not one). */
  error?: string
}

/**
 * The page's text, run in the page (evaluate_script, as its source: it uses nothing outside
 * itself). Without a selector, its main content (main, [role=main] or article, the largest when
 * it has a good part of the page's text, else the body) without navigation, menus, page headers
 * and footers, asides, banners and cookie notices; with one, all of what it matches. Never what is
 * hidden, scripts, styles or pictures; never a field's value (a password's least of all).
 */
export function pageText(o: { selector: string | null; links: boolean }): PageText {
  const SKIP = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'iframe',
    'frame',
    'object',
    'embed',
    'video',
    'audio',
    'map',
    'head',
    'link',
    'meta',
    'picture',
    'source',
    'track',
    'datalist',
    'option',
    'optgroup',
    'img',
    'math',
  ])
  const INLINE = new Set([
    'a',
    'abbr',
    'b',
    'bdi',
    'bdo',
    'big',
    'cite',
    'code',
    'data',
    'del',
    'dfn',
    'em',
    'font',
    'i',
    'ins',
    'kbd',
    'label',
    'mark',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strike',
    'strong',
    'sub',
    'sup',
    'time',
    'tt',
    'u',
    'var',
    'wbr',
    'nobr',
    'slot',
  ])
  const BLOCK = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'body',
    'center',
    'dd',
    'details',
    'dialog',
    'dir',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'header',
    'hgroup',
    'hr',
    'legend',
    'li',
    'main',
    'menu',
    'nav',
    'ol',
    'p',
    'pre',
    'search',
    'section',
    'summary',
    'table',
    'caption',
    'tbody',
    'thead',
    'tfoot',
    'tr',
    'td',
    'th',
    'ul',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
  ])
  const DROP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar'])
  const DROP_WORDS =
    /^(nav|navbar|navbox|navigation|menu|menubar|breadcrumb|breadcrumbs|footer|sidebar|cookie|cookies|consent|gdpr|social|toolbar|ad|ads|advert|advertisement|sponsored|newsletter|popup|skip|skiplinks)$/
  const filtering = !o.selector
  const body = document.body ?? document.documentElement
  const textLength = (e: Element): number => (e.textContent ?? '').length
  let dropped = 0
  let rootLength = 1

  const visible = (el: Element): boolean => {
    if ((el as HTMLElement).hidden) return false
    if (el.getAttribute('aria-hidden') === 'true' && !el.querySelector('h1, h2, h3, p, main, article')) return false
    const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility
    if (typeof check === 'function') {
      if (check.call(el, { visibilityProperty: true, checkVisibilityCSS: true })) return true
      return getComputedStyle(el).display === 'contents'
    }
    const s = (el as HTMLElement).style
    return !s || (s.display !== 'none' && s.visibility !== 'hidden')
  }
  /** Navigation, menus, a page's header or footer, asides, banners and notices: left out (no selector). */
  const boilerplate = (el: Element, tag: string): boolean => {
    if (!filtering) return false
    if (el.matches('main, article, [role="main"], [role="article"], dialog, [role="dialog"]')) return false
    if (el.querySelector('main, article, [role="main"]')) return false
    const role = el.getAttribute('role')
    if (tag === 'nav' || tag === 'aside' || (role && DROP_ROLES.has(role))) return true
    if (tag === 'header' || tag === 'footer')
      return !el.parentElement?.closest('article, aside, main, nav, section, [role="main"], [role="article"]')
    const words = `${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase().split(/[\s_-]+/)
    if (!words.some(w => DROP_WORDS.test(w))) return false
    // a block named so that holds much of the page is the page, not its menu
    return textLength(el) < rootLength * 0.3
  }
  const here = location
  const shortHref = (a: Element): string | null => {
    const raw = a.getAttribute('href')
    if (!raw || raw.startsWith('#') || /^\s*javascript:/i.test(raw)) return null
    let u: URL
    try {
      u = new URL(raw, document.baseURI)
    } catch {
      return null
    }
    if (u.protocol === 'javascript:') return null
    // a search engine's redirect (/l/?uddg=…, /url?q=…): where it goes
    if (/^\/(l|url|link|redirect|out|away|r)\/?$/i.test(u.pathname))
      for (const v of Array.from(u.searchParams.values()))
        if (/^https?:\/\//i.test(v)) {
          try {
            u = new URL(v)
            break
          } catch {}
        }
    if (u.origin === here.origin && u.pathname === here.pathname && u.search === here.search) return null
    let s =
      u.protocol === 'mailto:' || u.protocol === 'tel:'
        ? u.href
        : u.origin === here.origin
          ? u.pathname + u.search + u.hash
          : u.host + (u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname) + u.search + u.hash
    try {
      s = decodeURI(s)
    } catch {}
    s = s.replace(/ /g, '%20')
    return s.length > 80 ? `${s.slice(0, 79)}…` : s
  }

  /** A renderer: text pushed in, lines out; nested for a link's or a table cell's own text. */
  function renderer(links: boolean) {
    const out: string[] = []
    let breaks = 0
    let started = false
    let lineStart = true
    let space = false
    let lead = ''
    let indent = ''
    const br = (n: number): void => {
      breaks = Math.max(breaks, n)
    }
    const begin = (): void => {
      if (breaks && started) {
        out.push('\n'.repeat(breaks))
        lineStart = true
      }
      breaks = 0
      if (lineStart) {
        out.push(lead || indent)
        lead = ''
        lineStart = false
        space = false
      } else if (space) out.push(' ')
      started = true
    }
    const put = (raw: string): void => {
      const t = raw.replace(/\s+/g, ' ')
      const core = t.trim()
      if (!core) {
        if (t) space = true
        return
      }
      if (t.startsWith(' ')) space = true
      begin()
      out.push(core)
      space = t.endsWith(' ')
    }
    const verbatim = (text: string): void => {
      begin()
      out.push(text.replace(/\n/g, `\n${indent}`))
      space = false
    }
    const kids = (el: Element | ShadowRoot): void => {
      const host = el as Element
      const nodes =
        host.localName === 'slot'
          ? (host as HTMLSlotElement).assignedNodes?.({ flatten: true }) || []
          : (host as Element).shadowRoot
            ? (host as Element).shadowRoot?.childNodes
            : el.childNodes
      const list = nodes && (nodes as ArrayLike<Node>).length ? nodes : el.childNodes
      for (const n of Array.from(list as ArrayLike<Node>)) node(n)
    }
    const textOf = (el: Element, withLinks: boolean): string => {
      const r = renderer(withLinks)
      r.kids(el)
      return r.text()
    }
    /** A link's or a button's text on one line, without the marks of headings and lists in it. */
    const flat = (t: string): string =>
      t
        .replace(/(^|\n)\s*(#{1,6}|-|\d+\.) /g, '$1')
        .replace(/\s*\n\s*/g, ' ')
        .trim()
    const field = (el: Element, tag: string) => {
      // a control drawn see-through (a menu's toggle, styled over by a picture of its own) is not one to show
      const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility
      if (typeof check === 'function' && !check.call(el, { opacityProperty: true, visibilityProperty: true })) return
      const name = (
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        ''
      ).trim()
      const labelled = (what: string) => put(name ? ` [${what}: ${name}] ` : ` [${what}] `)
      if (tag === 'textarea') return labelled('text area')
      if (tag === 'select') {
        const chosen = Array.from((el as HTMLSelectElement).selectedOptions ?? [], op => op.text.trim()).join(', ')
        return put(` [select${name ? ` ${name}` : ''}${chosen ? `: ${chosen}` : ''}] `)
      }
      const type = (el.getAttribute('type') ?? 'text').toLowerCase()
      if (type === 'hidden') return
      if (type === 'checkbox') return put((el as HTMLInputElement).checked ? ' [x] ' : ' [ ] ')
      if (type === 'radio') return put((el as HTMLInputElement).checked ? ' (x) ' : ' ( ) ')
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
        const label = (el.getAttribute('value') || el.getAttribute('alt') || name || type).trim()
        return put(` [button: ${label}] `)
      }
      if (type === 'password') return labelled('password field')
      if (type === 'file') return labelled('file')
      labelled(type === 'text' ? 'field' : `${type} field`)
    }
    const table = (t: HTMLTableElement): void => {
      const rows = Array.from(t.rows ?? [])
      const data = !!t.tHead || !!t.caption || rows.some(r => Array.from(r.cells).some(c => c.localName === 'th'))
      if (!data) {
        for (const r of rows) for (const c of Array.from(r.cells)) if (visible(c)) block(c, 'div')
        return
      }
      br(1)
      if (t.caption && visible(t.caption)) {
        put(textOf(t.caption, false))
        br(1)
      }
      rows.forEach((r, i) => {
        if (!visible(r)) return
        const cells = Array.from(r.cells).filter(visible)
        const texts = cells.map(c => textOf(c, links).replace(/\n+/g, ' / ').replace(/\|/g, '\\|').trim())
        if (!texts.some(Boolean)) return
        verbatim(`| ${texts.join(' | ')} |`)
        br(1)
        if (i === 0 && cells.every(c => c.localName === 'th')) {
          verbatim(`|${' --- |'.repeat(cells.length)}`)
          br(1)
        }
      })
      br(1)
    }
    const block = (el: Element, tag: string) => {
      if (/^h[1-6]$/.test(tag)) {
        const text = textOf(el, false).replace(/\n+/g, ' ').trim()
        if (!text) return
        br(2)
        lead = `${indent}${'#'.repeat(Number(tag[1]))} `
        put(text)
        br(2)
        return
      }
      if (tag === 'pre') {
        const text = (el.textContent ?? '').replace(/\n+$/, '')
        if (!text.trim()) return
        br(1)
        verbatim(`\`\`\`\n${text}\n\`\`\``)
        br(1)
        return
      }
      if (tag === 'table') return table(el as HTMLTableElement)
      if (tag === 'hr') {
        br(1)
        verbatim('---')
        br(1)
        return
      }
      if (tag === 'ul' || tag === 'ol' || tag === 'menu' || tag === 'dir') {
        br(1)
        let n = Number(el.getAttribute('start') ?? 1) || 1
        const outer = indent
        for (const c of Array.from(el.children)) {
          if (c.localName !== 'li') {
            node(c)
            continue
          }
          if (!visible(c)) continue
          br(1)
          const mark = `${outer}${tag === 'ol' ? `${n++}. ` : '- '}`
          lead = mark
          indent = `${outer}  `
          kids(c)
          if (lead === mark) lead = ''
          indent = outer
          br(1)
        }
        br(1)
        return
      }
      if (tag === 'blockquote') {
        const outer = indent
        br(1)
        indent = `${outer}> `
        kids(el)
        indent = outer
        br(1)
        return
      }
      if (tag === 'dt') {
        br(1)
        kids(el)
        put(':')
        br(1)
        return
      }
      if (tag === 'dd') {
        const outer = indent
        br(1)
        indent = `${outer}  `
        lead = indent
        kids(el)
        if (lead === indent) lead = ''
        indent = outer
        br(1)
        return
      }
      br(1)
      kids(el)
      br(1)
    }
    const element = (el: Element) => {
      const tag = el.localName
      if (SKIP.has(tag)) return
      if (!visible(el)) return
      if (boilerplate(el, tag)) {
        dropped++
        return
      }
      if (tag === 'br') return br(1)
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return field(el, tag)
      if (tag === 'button' || el.getAttribute('role') === 'button') {
        const text = flat(textOf(el, false)) || (el.getAttribute('aria-label') ?? '').trim()
        if (text) put(` [button: ${text}] `)
        return
      }
      if (tag === 'a') {
        const href = links ? shortHref(el) : null
        // a link that is only a picture is left out, as pictures are
        const text = flat(textOf(el, false)) || (el.getAttribute('aria-label') ?? '').trim()
        if (!text) return
        const whole = el.textContent ?? ''
        if (/^\s/.test(whole)) space = true
        // a link that reads as its address: the address once
        const bare = (t: string): string =>
          t
            .replace(/^(https?:\/\/)?(www\.)?/i, '')
            .replace(/\/$/, '')
            .toLowerCase()
        put(href && bare(href) !== bare(text) ? `[${text}](${href})` : text)
        if (/\s$/.test(whole)) space = true
        return
      }
      if (tag === 'code' && !el.closest('pre')) {
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text) put(`\`${text}\``)
        return
      }
      if (INLINE.has(tag)) return kids(el)
      if (BLOCK.has(tag)) return block(el, tag)
      // a custom element or one not known: as it shows
      if (getComputedStyle(el).display.startsWith('inline')) return kids(el)
      block(el, 'div')
    }
    const node = (n: Node): void => {
      if (n.nodeType === 3) put(n.nodeValue ?? '')
      else if (n.nodeType === 1) element(n as Element)
      else if (n.nodeType === 11) kids(n as ShadowRoot)
    }
    const text = (): string =>
      out
        .join('')
        .split('\n')
        .map(l => l.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    return { kids, node, text, block }
  }

  const title = document.title.replace(/\s+/g, ' ').trim()
  const url = location.href
  let roots: Element[]
  let rootName: string
  if (o.selector) {
    let found: Element[]
    try {
      found = Array.from(document.querySelectorAll(o.selector))
    } catch {
      return { title, url, root: o.selector, text: '', dropped: 0, error: `Not a CSS selector: ${o.selector}` }
    }
    roots = found.filter(r => !found.some(p => p !== r && p.contains(r))).slice(0, 50)
    if (!roots.length)
      return { title, url, root: o.selector, text: '', dropped: 0, error: `Nothing on the page matches ${o.selector}` }
    rootName = o.selector
  } else {
    const total = textLength(body)
    let best: Element | null = null
    for (const c of Array.from(document.querySelectorAll('main, [role="main"], article')))
      if (visible(c) && (!best || textLength(c) > textLength(best))) best = c
    if (best && textLength(best) >= total * 0.3) {
      roots = [best]
      rootName = best.localName === 'article' ? 'article' : 'main'
    } else {
      roots = [body]
      rootName = 'body'
    }
  }
  const parts: string[] = []
  for (const root of roots) {
    rootLength = Math.max(1, textLength(root))
    const r = renderer(o.links)
    if (root === body || root.localName === 'html') r.kids(root)
    else r.node(root)
    const t = r.text()
    if (t) parts.push(t)
  }
  return { title, url, root: rootName, text: parts.join('\n\n---\n\n'), dropped }
}

/** pageText's call as evaluate_script's `function`: its source, with its options in it. */
export const pageScript = (selector: string | null, links: boolean): string =>
  `() => (${pageText.toString()})(${JSON.stringify({ selector, links })})`

/** The value an evaluate_script answer returned (its ```json block), or undefined. */
export function evaluated(text: string): unknown {
  const start = text.indexOf('```json\n')
  const end = text.lastIndexOf('\n```')
  if (start < 0 || end < start) return undefined
  try {
    return JSON.parse(text.slice(start + 8, end))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- read_page: its answer

export const DEFAULT_CHARS = 6000
const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}
const charsOf = (args: Msg): number => num(args.maxChars, DEFAULT_CHARS, 500, 40_000)
const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const thousands = (n: number): string => n.toLocaleString('en-US')
/** An address with its letters as they read (%D0%9A… as К), its spaces kept encoded. */
const decoded = (url: string): string => {
  try {
    return decodeURI(url).replace(/ /g, '%20')
  } catch {
    return url
  }
}

/** Where a part of `text` from `from` ends, at most `max` long: at a line's end if one is near, else a space. */
export function partEnd(text: string, from: number, max: number): number {
  if (text.length - from <= max) return text.length
  const hard = from + max
  const line = text.lastIndexOf('\n', hard)
  if (line > from + max * 0.6) return line + 1
  const space = text.lastIndexOf(' ', hard)
  if (space > from + max * 0.6) return space + 1
  return hard
}

/** read_page's answer: the page's head line, then its part from `offset` (or what `find` finds). */
export function pageReply(p: PageText, args: Msg): string {
  const total = p.text.length
  const what =
    p.root === 'main' || p.root === 'article'
      ? `its ${p.root} content`
      : p.root === 'body'
        ? 'the page'
        : `what matches ${p.root}`
  const left = p.dropped ? `; ${p.dropped} navigation, menu and footer blocks left out (selector "body" has them)` : ''
  const head = `${p.title || '(no title)'} | ${cap(decoded(p.url), 200)}\nRead: ${what}, ${thousands(total)} characters${left}.`
  if (!total) return `${head}\nNo text in it.`
  const find = typeof args.find === 'string' ? args.find.trim() : ''
  const max = charsOf(args)
  const offset = num(args.offset, 0, 0, total)
  if (find) return `${head}\n${findIn(p.text, find, { context: num(args.context, 1, 0, 10), offset, max })}`
  if (offset >= total) return `${head}\nNothing after offset ${offset}: the text ends at ${total}.`
  const end = partEnd(p.text, offset, max)
  const where =
    end < total
      ? `Characters ${thousands(offset)}-${thousands(end)} of ${thousands(total)}; more: offset=${end}.`
      : offset
        ? `Characters ${thousands(offset)}-${thousands(end)} of ${thousands(total)}, the end.`
        : 'All of it.'
  return `${head} ${where}\n\n${p.text.slice(offset, end).trimEnd()}`
}

/** The lines of `text` that contain `query`, with `context` lines around them, from `offset`, up to `max` characters. */
export function findIn(text: string, query: string, o: { context: number; offset: number; max: number }): string {
  const lines = text.split('\n')
  const starts: number[] = []
  let at = 0
  for (const l of lines) {
    starts.push(at)
    at += l.length + 1
  }
  const q = query.replace(/\s+/g, ' ').toLowerCase()
  const hits: number[] = []
  lines.forEach((l, i) => {
    if ((starts[i] ?? 0) + l.length >= o.offset && l.replace(/\s+/g, ' ').toLowerCase().includes(q)) hits.push(i)
  })
  if (!hits.length) return `"${query}" is not in the text${o.offset ? ` after offset ${o.offset}` : ''}.`
  // each match with its lines around it; places that overlap are one
  const places: [number, number][] = []
  for (const i of hits) {
    const from = Math.max(0, i - o.context)
    const to = Math.min(lines.length - 1, i + o.context)
    const last = places.at(-1)
    if (last && from <= last[1]) last[1] = to
    else places.push([from, to])
  }
  /** A long line: its match with some of the line around it. */
  const clip = (l: string): string => {
    if (l.length <= 300) return l
    const m = l.toLowerCase().indexOf(q)
    if (m < 0) return cap(l, 200)
    const s = Math.max(0, m - 120)
    const e = m + q.length + 120
    return `${s ? '…' : ''}${l.slice(s, e)}${e < l.length ? '…' : ''}`
  }
  const shown: string[] = []
  let used = 0
  let next: number | null = null
  for (const [from, to] of places) {
    const block = [`@ offset=${starts[from]}`]
    let size = (block[0] as string).length + 2
    for (let j = from; j <= to && next === null; j++) {
      const l = clip(lines[j] ?? '')
      if (used + size + l.length + 1 > o.max && (shown.length || block.length > 1)) next = starts[j] ?? null
      else {
        block.push(l)
        size += l.length + 1
      }
    }
    if (block.length > 1) shown.push(block.join('\n').trimEnd())
    used += size
    if (next !== null) break
  }
  const count = `${hits.length} line${hits.length === 1 ? '' : 's'} with "${query}"`
  const more = next === null ? '' : `; more: find again with offset=${next}`
  return `${count}${more}. read_page with an offset reads on from a place.\n\n${shown.join('\n\n')}`
}

// ---------------------------------------------------------------- list_interactive

/** A line of take_snapshot: its depth, uid, role ('' for text), name and attributes. */
export interface SnapNode {
  depth: number
  uid: string
  role: string
  name: string
  attrs: Record<string, string | true>
}

const ATTRS = /^(?: [a-zA-Z]+(?:="[^"]*")?)*$/

/** take_snapshot's text as its nodes, in order (the lines before its tree left out). */
export function snapshotNodes(text: string): SnapNode[] {
  const at = text.indexOf('## Latest page snapshot\n')
  const body = at >= 0 ? text.slice(at + '## Latest page snapshot\n'.length) : text
  // a name with a line break in it goes on the next line
  const lines: string[] = []
  for (const l of body.split('\n')) {
    if (/^\s*uid=\S/.test(l)) lines.push(l)
    else if (l.trim() && lines.length) lines[lines.length - 1] += `\n${l}`
  }
  const nodes: SnapNode[] = []
  for (const line of lines) {
    const m = /^( *)uid=(\S+)(.*)$/s.exec(line)
    if (!m) continue
    let rest = m[3] ?? ''
    let role = ''
    const r = /^ ([^\s"]+)/.exec(rest)
    if (r) {
      role = r[1] ?? ''
      rest = rest.slice(r[0].length)
    }
    let name = ''
    if (rest.startsWith(' "')) {
      const s = rest.slice(1)
      let end = -1
      let first = -1
      for (let j = 1; j < s.length; j++) {
        if (s[j] !== '"' || (j + 1 < s.length && s[j + 1] !== ' ')) continue
        if (first < 0) first = j
        if (ATTRS.test(s.slice(j + 1))) {
          end = j
          break
        }
      }
      if (end < 0) end = first < 0 ? s.length : first
      name = s.slice(1, end)
      rest = s.slice(end + 1)
    }
    const attrs: Record<string, string | true> = {}
    for (const a of rest.matchAll(/ ([a-zA-Z]+)(?:="([^"]*)")?/g)) attrs[a[1] as string] = a[2] ?? true
    nodes.push({ depth: Math.floor((m[1] ?? '').length / 2), uid: m[2] ?? '', role, name, attrs })
  }
  return nodes
}

const ACTIONABLE = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'option',
  'MenuListOption',
])
const LANDMARKS = new Set([
  'navigation',
  'search',
  'form',
  'dialog',
  'alertdialog',
  'main',
  'banner',
  'contentinfo',
  'complementary',
])
const FLAGS = ['checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'readonly', 'invalid', 'focused']
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox'])
/** A value never shown: Chrome's dots for a password, or a field named for a secret. */
const MASKED = /^[•●*·∙]+$/
const SECRET =
  /pass(word|code|phrase)?|parol|пароль|kennwort|mot de passe|contraseña|senha|secret|token|\bpin\b|otp|one[- ]time|cvc|cvv|security code/i

/** A link's address, short: a path on this page's site, host/path elsewhere, its letters decoded. */
export function shortUrl(raw: string, page: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return cap(raw, 80)
  }
  // a search engine's redirect (/l/?uddg=…, /url?q=…): where it goes, as pageText shows it
  if (/^\/(l|url|link|redirect|out|away|r)\/?$/i.test(u.pathname))
    for (const v of u.searchParams.values())
      if (/^https?:\/\//i.test(v)) {
        try {
          u = new URL(v)
          break
        } catch {}
      }
  let p: URL | null = null
  try {
    p = new URL(page)
  } catch {}
  let s =
    u.protocol === 'http:' || u.protocol === 'https:'
      ? p && u.origin === p.origin
        ? u.pathname === p.pathname && u.search === p.search
          ? u.hash || u.pathname
          : u.pathname + u.search + u.hash
        : u.host + (u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname) + u.search + u.hash
      : u.protocol === 'javascript:'
        ? 'javascript:'
        : u.href
  try {
    s = decodeURI(s)
  } catch {}
  return cap(s.replace(/ /g, '%20'), 80)
}

/** An address as it reads, to tell a link whose text is its address: no scheme, www or last slash. */
const bare = (t: string): string =>
  t
    .replace(/^(https?:\/\/)?(www\.)?/i, '')
    .replace(/\/$/, '')
    .toLowerCase()

interface Entry {
  line: string
  landmark: string
  heading: string
}

/** list_interactive's answer from a take_snapshot text. */
export function interactiveReply(snapshot: string, args: Msg): string {
  const nodes = snapshotNodes(snapshot)
  const page = nodes.find(n => n.role === 'RootWebArea')
  const pageUrl = typeof page?.attrs.url === 'string' ? page.attrs.url : ''
  const withLinks = args.links !== false
  const find = typeof args.find === 'string' ? args.find.trim().replace(/\s+/g, ' ').toLowerCase() : ''
  const entries: Entry[] = []
  const marks: { depth: number; label: string; uid: string }[] = []
  /** Where a node is: the uids of the landmarks it is in. A heading shows over what is in its landmark, or in one in it. */
  const path = (): string => marks.map(m => `${m.uid} `).join('')
  let heading = { text: '', path: '' }
  /** A combobox's options: shown on its line, not each on its own. */
  let inCombo = -1
  let comboEntry: { entry: Entry; options: string[] } | null = null
  const closeCombo = (): void => {
    if (!comboEntry) return
    const { entry, options } = comboEntry
    if (options.length) {
      const some = options.slice(0, 8).map(o => cap(o, 30))
      entry.line += ` options: ${some.join(' | ')}${options.length > 8 ? ` | …(${options.length} in all)` : ''}`
    }
    comboEntry = null
  }
  for (const n of nodes) {
    while (marks.length && (marks.at(-1)?.depth ?? 0) >= n.depth) marks.pop()
    if (inCombo >= 0 && n.depth <= inCombo) {
      inCombo = -1
      closeCombo()
    }
    const landmark = marks.at(-1)?.label ?? ''
    if (inCombo >= 0) {
      if (n.role === 'option' || n.role === 'MenuListOption') comboEntry?.options.push(n.name)
      continue
    }
    if (LANDMARKS.has(n.role)) {
      marks.push({ depth: n.depth, label: `[${n.role}${n.name ? ` "${cap(n.name, 60)}"` : ''}]`, uid: n.uid })
      continue
    }
    if (n.role === 'heading') {
      heading = { text: `${'#'.repeat(Number(n.attrs.level) || 2)} ${cap(n.name, 100)}`, path: path() }
      continue
    }
    if (!ACTIONABLE.has(n.role)) continue
    if (n.role === 'link' && !withLinks) continue
    let line = `${n.uid} ${n.role === 'MenuListOption' ? 'option' : n.role}`
    const label = n.name || (typeof n.attrs.description === 'string' ? n.attrs.description : '')
    if (label) line += ` "${cap(label.replace(/\s+/g, ' '), 80)}"`
    if (n.role === 'link' && typeof n.attrs.url === 'string') {
      const url = shortUrl(n.attrs.url, pageUrl)
      // a link that reads as its address: the address once
      if (bare(url) !== bare(label)) line += ` ${url}`
    }
    const value = n.attrs.value
    if (typeof value === 'string' && value && VALUED.has(n.role))
      line += MASKED.test(value) || SECRET.test(label) ? ' value=(hidden)' : ` value="${cap(value, 60)}"`
    for (const f of FLAGS) {
      const v = n.attrs[f]
      if (v === true) line += ` ${f}`
      else if (typeof v === 'string' && v !== 'false') line += ` ${f}=${v}`
    }
    if (n.role === 'textbox' && n.attrs.multiline === true) line += ' multiline'
    const entry = { line, landmark, heading: path().startsWith(heading.path) ? heading.text : '' }
    entries.push(entry)
    if (n.role === 'combobox') {
      inCombo = n.depth
      comboEntry = { entry, options: [] }
    }
  }
  closeCombo()
  const kept = find ? entries.filter(e => e.line.toLowerCase().includes(find)) : entries
  const title = page?.name || '(no title)'
  const head = `${title} | ${cap(decoded(pageUrl), 200)}`
  if (!kept.length)
    return `${head}\n${find ? `No element with "${args.find}" in its line` : 'Nothing to act on in the page'}${withLinks ? '' : ' (links left out)'}.`
  const max = charsOf(args)
  const offset = num(args.offset, 0, 0, kept.length)
  if (offset >= kept.length) return `${head}\nNothing after element ${offset}: there are ${kept.length}.`
  const out: string[] = []
  let used = 0
  let lastLandmark: string | null = null
  let lastHeading: string | null = null
  let i = offset
  for (; i < kept.length; i++) {
    const e = kept[i] as Entry
    const lines: string[] = []
    if (e.landmark !== lastLandmark && (e.landmark || lastLandmark)) lines.push(e.landmark || '[page]')
    if (e.heading && e.heading !== lastHeading) lines.push(e.heading)
    lines.push(e.line)
    const size = lines.reduce((s, l) => s + l.length + 1, 0)
    if (out.length && used + size > max) break
    out.push(...lines)
    used += size
    lastLandmark = e.landmark
    lastHeading = e.heading || lastHeading
  }
  const what = `${kept.length} element${kept.length === 1 ? '' : 's'}${find ? ` with "${args.find}"` : ''}${withLinks ? '' : ' (no links)'}`
  const where =
    i < kept.length
      ? `; ${offset + 1}-${i} here, more: offset=${i}`
      : offset
        ? `; ${offset + 1}-${i} here, the end`
        : ''
  return `${head}\n${what}${where}. Each line: uid, role, label, state; click, fill and the others take the uid.\n\n${out.join('\n')}`
}

// ---------------------------------------------------------------- the tools

/** A tool call to chrome-devtools-mcp, by the wrapper: its text, and whether it failed. */
export type ChildCall = (name: string, args: Msg) => Promise<{ text: string; isError: boolean }>

/** read_page or list_interactive: their answer, from chrome-devtools-mcp's evaluate_script or take_snapshot. */
export async function readTool(name: string, args: Msg, call: ChildCall): Promise<{ text: string; isError: boolean }> {
  if (name === 'read_page') {
    const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : null
    const r = await call('evaluate_script', {
      function: pageScript(selector, args.links !== false),
      waitForStableDom: false,
    })
    if (r.isError) return r
    const v = evaluated(r.text)
    if (!isRecord(v) || typeof v.text !== 'string')
      return { text: `The page could not be read: ${cap(r.text, 300)}`, isError: true }
    const p = v as unknown as PageText
    if (p.error) return { text: p.error, isError: true }
    return { text: pageReply(p, args), isError: false }
  }
  const r = await call('take_snapshot', {})
  if (r.isError) return r
  return { text: interactiveReply(r.text, args), isError: false }
}
