// Files, folders and links in the chat. Paths the agents mention become chips once the server
// finds them on disk; a chip opens a quick look over the board: images, PDF, video and audio,
// Markdown (rendered or source), code and text with line numbers (a :line is shown and lit),
// JSON, CSV as a table, folders as a list to walk through. From there: open with the system,
// show in its folder, copy the path. Web links open in the default browser.
//
// The quick look grows out of the chip it was opened from and shrinks back into it, on a spring
// that can be caught midway; it dims the board, Esc closes it, Backspace walks back.
import { changedFiles } from './src/models/diff.ts'
import {
  actionsOff,
  codeLines,
  crumbs,
  fileName,
  ICONS,
  iconOf,
  inCheckout,
  inFolder,
  kindOfName,
  markParts,
  parentOf,
  rawUrl as rawUrlOf,
  sizeText,
  statBook,
} from './src/models/files.ts'
import { markdown } from './src/models/markdown.ts'
import { reducedMotion, Spring } from './src/models/spring.ts'
import { modalFocus } from './src/models/modal-focus.ts'

const $ = (root, sel) => root.querySelector(sel)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * The chat's files: `t` is a getter for the page's translator, `token` for the raw-bytes token,
 * `toast(text, error)` shows a message.
 */
export function initFiles({ t, token, toast, canMutate = () => true, onDialogChange = () => {} }) {
  const tr = (key, vars) => t()(key, vars)

  // ------------------------------------------------------------ server
  async function post(url, body) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
      const r = await res.json().catch(() => ({}))
      return res.ok ? r : { ...r, httpStatus: res.status, error: r.error || tr('err.status', { code: res.status }) }
    } catch (err) {
      return { error: tr('err.offline', { why: err.message }) }
    }
  }
  const rawUrl = path => rawUrlOf(path, token())

  async function openUrl(href) {
    if (!canMutate()) return toast(tr('mobile.readOnly'), true)
    const r = await post('/api/open-url', { url: href })
    if (r.error) {
      if (r.httpStatus !== 409 && canMutate()) window.open(href, '_blank', 'noopener')
      else toast(r.error, true)
    }
  }
  async function system(path, how) {
    if (!canMutate()) return toast(tr('mobile.readOnly'), true)
    const r = await post('/api/fs/open', { path, how })
    if (r.error) toast(r.error, true)
  }
  async function copy(path) {
    try {
      await navigator.clipboard.writeText(path)
      toast(tr('ql.copied'))
    } catch (err) {
      toast(err.message, true)
    }
  }

  // ------------------------------------------------------------ chips
  // What the server said about a path, by the session folder it was written in. Paths that were
  // not there are asked again after a while: the agent may create them a moment later.
  const known = statBook()
  const cached = (cwd, raw) => known.get(cwd, raw, Date.now())

  /** Turn the path candidates under `root` into chips; `cwd` resolves relative ones. */
  async function upgrade(root, cwd = '') {
    const els = [...root.querySelectorAll('[data-path]:not([data-fs])')]
    const ask = []
    for (const el of els) {
      const info = cached(cwd, el.dataset.path)
      if (info) apply(el, info)
      else ask.push(el)
    }
    const paths = [...new Set(ask.map(el => el.dataset.path))]
    if (!paths.length) return
    const r = await post('/api/fs/stat', { cwd, paths })
    for (const info of r.items ?? []) known.put(cwd, info, Date.now())
    for (const el of ask) {
      const info = el.isConnected && cached(cwd, el.dataset.path)
      if (info) apply(el, info)
    }
  }

  function apply(el, info) {
    if (!info.exists) {
      el.dataset.fs = 'missing'
      if (el.matches('a.fs')) el.title = tr('ql.missing', { path: info.path || el.dataset.path })
      return
    }
    el.dataset.fs = info.dir ? 'dir' : 'file'
    el.dataset.abs = info.path
    el.dataset.kind = info.kind
    if (info.line) el.dataset.line = info.line
    el.title = info.line ? `${info.path}:${info.line}` : info.path
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    // Thumbnails and tool lines keep their look; everything else becomes a chip.
    if (el.classList.contains('fs-inline')) return
    const label = el.matches('a') ? el.innerHTML : esc(info.name + (info.line ? `:${info.line}` : ''))
    el.classList.add('fs-chip')
    el.innerHTML = `${iconOf(info.kind)}<span class="fs-chip-label">${label}</span>`
  }

  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-fs="file"], [data-fs="dir"]')
    if (chip) {
      e.preventDefault()
      return look({ path: chip.dataset.abs, line: Number(chip.dataset.line) || null }, chip)
    }
    const ext = e.target.closest('a.ext[href]')
    if (ext) {
      e.preventDefault()
      openUrl(ext.href)
    }
  })
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-fs="file"], [data-fs="dir"]')) {
      e.preventDefault()
      look({ path: e.target.dataset.abs, line: Number(e.target.dataset.line) || null }, e.target)
    }
  })

  // ------------------------------------------------------------ the quick look
  const root = document.createElement('div')
  root.className = 'ql'
  root.hidden = true
  root.innerHTML = `
    <div class="ql-scrim"></div>
    <section class="ql-win" role="dialog" aria-modal="true" aria-labelledby="ql-name" tabindex="-1">
      <header class="ql-head">
        <button class="icon-button ql-back" hidden>${ICONS.back}</button>
        <span class="ql-icon"></span>
        <div class="ql-titles"><h3 id="ql-name"></h3><nav class="ql-path"></nav></div>
        <div class="ql-tools">
          <div class="ql-mode" hidden><button data-mode="view"></button><button data-mode="source"></button></div>
          <button class="button primary ql-open"></button>
          <button class="icon-button ql-refresh" hidden>${ICONS.refresh}</button>
          <button class="icon-button ql-reveal">${ICONS.reveal}</button>
          <button class="icon-button ql-copy">${ICONS.copy}</button>
        </div>
        <button class="icon-button ql-close">${ICONS.close}</button>
      </header>
      <div class="ql-body"></div>
      <footer class="ql-foot"></footer>
    </section>`
  document.body.append(root)
  const win = $(root, '.ql-win')
  const focus = modalFocus(root, win)
  const scrim = $(root, '.ql-scrim')
  const body = $(root, '.ql-body')

  const ql = { stack: [], origin: null, seq: 0, mode: 'view', data: null }
  // p: 0 = folded into the chip it came from, 1 = open. Interruptible: a close while opening
  // turns around from wherever the window is.
  const motion = new Spring({ value: 0, damping: 1, response: 0.34, precision: 0.002, onUpdate: v => paint(v), onRest: v => v === 0 && finishClose() })
  let from = { dx: 0, dy: 0, s: 0.2 }

  /** Where the window starts from: the chip's centre and width, or a small drop when it is gone. */
  function measureFrom(el) {
    const saved = win.style.transform
    win.style.transform = 'none'
    const w = win.getBoundingClientRect()
    win.style.transform = saved
    const r = el?.isConnected ? el.getBoundingClientRect() : null
    if (!r || !r.width || r.bottom < 0 || r.top > innerHeight) return { dx: 0, dy: 24, s: 0.94 }
    return { dx: r.left + r.width / 2 - (w.left + w.width / 2), dy: r.top + r.height / 2 - (w.top + w.height / 2), s: Math.max(0.06, Math.min(0.5, r.width / w.width)) }
  }
  function paint(p) {
    const q = Math.max(0, p)
    if (reducedMotion.matches) {
      win.style.transform = ''
      win.style.opacity = String(Math.min(1, q))
    } else {
      const s = from.s + (1 - from.s) * q
      win.style.transform = `translate(${from.dx * (1 - q)}px, ${from.dy * (1 - q)}px) scale(${s})`
      win.style.opacity = String(Math.min(1, q * 1.8))
    }
    scrim.style.opacity = String(Math.min(1, q))
  }

  function labels() {
    $(root, '.ql-back').title = tr('ql.back')
    $(root, '.ql-back').setAttribute('aria-label', tr('ql.back'))
    $(root, '.ql-open').textContent = tr('ql.open')
    for (const [sel, k] of [['.ql-refresh', 'changes.refresh'], ['.ql-reveal', 'ql.reveal'], ['.ql-copy', 'ql.copy'], ['.ql-close', 'sheet.close']]) {
      $(root, sel).title = tr(k)
      $(root, sel).setAttribute('aria-label', tr(k))
    }
    $(root, '[data-mode="view"]').textContent = tr('ql.view')
    $(root, '[data-mode="source"]').textContent = tr('ql.source')
  }

  /**
   * Open the quick look on { path, line }, on { changes: session key } or on { history: session
   * key, cwd }, grown from element `el`.
   */
  function look(target, el) {
    if (!target?.path && !target?.changes && !target?.history) return
    if (!root.hidden && motion.target === 1) {
      ql.stack.push(target)
      return show()
    }
    ql.stack = [target]
    ql.origin = el ?? null
    root.hidden = false
    labels()
    show()
    from = measureFrom(el)
    if (motion.value <= 0.001) paint(0)
    motion.to(1, { damping: 1, response: 0.34 })
    focus.open(ql.origin ?? document.activeElement)
    onDialogChange()
  }

  function close() {
    if (root.hidden || motion.target === 0) return
    from = measureFrom(ql.origin)
    motion.to(0, { damping: 1, response: 0.26 })
    if (reducedMotion.matches) motion.set(0)
    onDialogChange()
  }
  function finishClose() {
    root.hidden = true
    body.innerHTML = ''
    ql.data = null
    focus.close()
  }
  const back = () => {
    if (ql.stack.length < 2) return close()
    ql.stack.pop()
    show()
  }

  async function show(fresh = false) {
    const target = ql.stack.at(-1)
    const seq = ++ql.seq
    $(root, '.ql-back').hidden = ql.stack.length < 2
    $(root, '.ql-refresh').hidden = !target.changes
    if (target.changes) return showChanges(target, seq, fresh)
    if (target.history) return showHistory(target)
    head({ path: target.path, name: fileName(target.path), kind: 'file' })
    body.className = 'ql-body loading'
    body.innerHTML = `<div class="ql-wait">${esc(tr('loading'))}</div>`
    $(root, '.ql-foot').textContent = ''
    const d = await post('/api/fs/preview', { path: target.path })
    if (seq !== ql.seq) return
    ql.data = { ...d, line: target.line }
    if (!['markdown'].includes(d.kind)) ql.mode = 'view'
    head(d)
    render()
  }

  /**
   * The changes of a session's checkout, read by the server (git status and diff against HEAD).
   * Kept on the stack entry, so a step back from a file shows them again without git; the
   * refresh button reads them anew.
   */
  async function showChanges(target, seq, fresh) {
    if (target.cache && !fresh) {
      ql.data = target.cache
      head(ql.data)
      return render()
    }
    head({ kind: 'changes', name: tr('changes.title'), path: target.cache?.path ?? '' })
    body.className = 'ql-body loading'
    body.innerHTML = `<div class="ql-wait">${esc(tr('loading'))}</div>`
    $(root, '.ql-foot').textContent = ''
    let d = { available: false }
    try {
      d = await (await fetch(`/api/session/${encodeURIComponent(target.changes)}/changes`)).json()
    } catch {}
    if (seq !== ql.seq) return
    target.cache = { ...d, kind: 'changes', name: d.branch || tr('changes.title'), path: d.root ?? '', error: d.available ? null : 'unavailable' }
    ql.data = target.cache
    head(ql.data)
    render()
  }

  function head(d) {
    $(root, '.ql-icon').innerHTML = iconOf(d.error === 'missing' ? 'missing' : d.dir ? 'dir' : d.kind)
    $(root, '#ql-name').textContent = d.name ?? ''
    // The folders above it, each one a step to walk to (for changes, up to the checkout itself).
    const nav = $(root, '.ql-path')
    nav.innerHTML = crumbs(d.path, d.kind).map(c => `<button data-go="${esc(c.path)}">${esc(c.name)}</button>`).join('<span>›</span>')
    nav.scrollLeft = nav.scrollWidth
    syncActions()
  }

  function syncActions() {
    const off = actionsOff(ql.data, canMutate())
    $(root, '.ql-open').disabled = off.open
    $(root, '.ql-reveal').disabled = off.reveal
    $(root, '.ql-copy').disabled = off.copy
  }

  function render() {
    const d = ql.data
    if (d.kind === 'history') return showHistory(ql.stack.at(-1))
    const foot = []
    body.className = `ql-body k-${d.dir ? 'dir' : d.kind}`
    $(root, '.ql-mode').hidden = d.kind !== 'markdown'
    for (const b of root.querySelectorAll('.ql-mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === ql.mode))
    if (d.kind === 'changes') {
      changes(d, foot)
    } else if (d.error === 'missing') {
      body.innerHTML = empty('missing', tr('ql.missing', { path: d.path }))
    } else if (d.error) {
      body.innerHTML = empty('file', d.error === 'denied' ? tr('ql.denied') : d.error)
    } else if (d.dir) {
      body.innerHTML = folder(d)
      foot.push(tr('ql.items', { n: d.total }))
      if (d.total > d.entries.length) foot.push(tr('ql.firstItems', { n: d.entries.length }))
    } else {
      foot.push(size(d.size))
      if (d.kind === 'image') body.innerHTML = `<div class="ql-media checker"><img src="${rawUrl(d.path)}" alt=""></div>`
      else if (d.kind === 'pdf') body.innerHTML = `<iframe class="ql-frame" src="${rawUrl(d.path)}" title="${esc(d.name)}"></iframe>`
      else if (d.kind === 'video') body.innerHTML = `<div class="ql-media"><video controls preload="metadata" src="${rawUrl(d.path)}"></video></div>`
      else if (d.kind === 'audio') body.innerHTML = `<div class="ql-media audio">${ICONS.audio}<audio controls preload="metadata" src="${rawUrl(d.path)}"></audio></div>`
      else if (typeof d.text === 'string') {
        if (d.kind === 'markdown' && ql.mode === 'view') {
          body.innerHTML = `<article class="md ql-md">${markdown(d.text, { soft: true })}</article>`
          upgrade(body, parentOf(d.path))
        } else if (d.kind === 'csv' && d.rows?.length) body.innerHTML = table(d.rows)
        else body.innerHTML = code(d.text, d.line)
        foot.push(d.kind === 'csv' && d.rows?.length ? tr('ql.rows', { n: d.rows.length - 1 }) : tr('ql.lines', { n: d.lines }))
        if (d.truncated) foot.push(tr('ql.truncated'))
      } else body.innerHTML = empty(d.kind === 'binary' ? 'file' : d.kind, tr('ql.noPreview'), true)
      if (d.mtime) foot.push(tr('ql.modified', { date: date(d.mtime) }))
    }
    if (d.dir && d.mtime) foot.push(tr('ql.modified', { date: date(d.mtime) }))
    $(root, '.ql-foot').textContent = foot.filter(Boolean).join(' · ')
    const img = $(body, 'img')
    img?.addEventListener('load', () => ($(root, '.ql-foot').textContent = [`${img.naturalWidth} × ${img.naturalHeight}`, ...foot].join(' · ')), { once: true })
    const hit = $(body, '.ql-ln.hit')
    if (hit) requestAnimationFrame(() => (body.scrollTop = hit.offsetTop - body.clientHeight / 3))
    else body.scrollTop = 0
  }

  /** Changed files on the left, their diff on the right; a file's name opens the file itself. */
  function changes(d, foot) {
    if (!d.available) {
      body.innerHTML = empty('changes', tr('changes.unavailable'))
      return
    }
    const files = changedFiles(d.status, d.diff)
    if (!files.length) {
      body.innerHTML = empty('clean', tr('changes.clean'))
      foot.push(tr('changes.read', { time: new Date(d.collectedAt).toLocaleTimeString(t().lang, { hour: '2-digit', minute: '2-digit' }) }))
      return
    }
    const abs = p => inCheckout(d.root, p)
    const code = f => (f.code === '??' ? 'N' : f.code)
    const badge = f => `<span class="st st-${code(f)}" title="${esc(tr(`changes.st.${code(f)}`))}">${code(f)}</span>`
    const count = f => (f.diff && !f.diff.binary ? `<span class="cnt">${f.diff.added ? `<i class="a">+${f.diff.added}</i>` : ''}${f.diff.removed ? `<i class="r">−${f.diff.removed}</i>` : ''}</span>` : '')
    const name = p => {
      const i = p.lastIndexOf('/')
      return i < 0 ? `<b>${esc(p)}</b>` : `<span class="dir">${esc(p.slice(0, i + 1))}</span><b>${esc(p.slice(i + 1))}</b>`
    }
    const list = files.map((f, i) => `<button class="ql-file" data-jump="${i}" title="${esc(f.from ? `${f.from} → ${f.path}` : f.path)}">${badge(f)}<span class="p">${name(f.path)}</span>${count(f)}</button>`).join('')
    const line = l =>
      l.kind === 'hunk' || l.kind === 'note'
        ? `<div class="dl ${l.kind}"><span class="o"></span><span class="n"></span><span class="x">${esc(l.text)}</span></div>`
        : `<div class="dl ${l.kind}"><span class="o">${l.old ?? ''}</span><span class="n">${l.new ?? ''}</span><span class="x">${esc(l.text) || ' '}</span></div>`
    const lines = f => {
      if (f.diff?.binary) return `<p class="ql-dnote">${esc(tr('changes.binary'))}</p>`
      if (f.diff?.lines.length) return `<div class="ql-dlines"><div class="ql-dl">${f.diff.lines.map(line).join('')}</div></div>`
      return `<p class="ql-dnote">${esc(tr(f.code === '??' ? 'changes.untracked' : 'changes.noDiff'))}</p>`
    }
    const open = f => (f.code === 'D' ? '' : `<button class="icon-button" data-go="${esc(abs(f.path))}" title="${esc(tr('changes.openFile'))}" aria-label="${esc(tr('changes.openFile'))}">${iconOf(kindOfName(f.path))}</button>`)
    const diff = files.map((f, i) => `<section class="ql-dfile" data-i="${i}"><header>${badge(f)}<span class="p">${name(f.path)}</span>${count(f)}${open(f)}</header>${lines(f)}</section>`).join('')
    body.innerHTML = `<div class="ql-changes"><nav class="ql-files">${list}</nav><div class="ql-diff">${diff}</div></div>`
    const added = files.reduce((s, f) => s + (f.diff?.added ?? 0), 0)
    const removed = files.reduce((s, f) => s + (f.diff?.removed ?? 0), 0)
    foot.push(tr('changes.files', { n: files.length }), `+${added} −${removed}`, tr('changes.read', { time: new Date(d.collectedAt).toLocaleTimeString(t().lang, { hour: '2-digit', minute: '2-digit' }) }))
    if (d.truncated) foot.push(tr('changes.truncated'))
    foot.push(tr('changes.scope'))
  }
  /**
   * Past sessions of the session's project: a search field, then the hits with the session's
   * own title, who wrote it and when; a hit opens to the whole message. Query and hits stay on
   * the stack entry, so a step back from a file finds them again.
   */
  function showHistory(target) {
    ql.data = { kind: 'history', name: tr('history.title'), path: target.cwd }
    head(ql.data)
    $(root, '.ql-mode').hidden = true
    body.className = 'ql-body k-history'
    body.innerHTML = `<form class="ql-search">${ICONS.search}<input type="search" maxlength="100" autocomplete="off" spellcheck="false" placeholder="${esc(tr('history.placeholder'))}" aria-label="${esc(tr('history.placeholder'))}"></form><div class="ql-hits"></div>`
    const input = $(body, 'input')
    input.value = target.query ?? ''
    hits(target)
    requestAnimationFrame(() => input.focus({ preventScroll: true }))
  }

  function hits(target) {
    const box = $(body, '.ql-hits')
    const d = target.result
    const foot = $(root, '.ql-foot')
    foot.textContent = ''
    if (!d) return void (box.innerHTML = `<p class="ql-dnote">${esc(tr('history.prompt'))}</p>`)
    if (d.loading) return void (box.innerHTML = `<p class="ql-dnote">${esc(tr('loading'))}</p>`)
    if (d.unavailable) return void (box.innerHTML = empty('history', tr('history.unavailable')))
    if (!d.results?.length) return void (box.innerHTML = empty('search', tr('history.empty')))
    box.innerHTML = d.results
      .map(
        (r, i) => `<article class="ql-hit" data-hit="${i}" tabindex="0">
          <header><span class="who ${r.role === 'user' ? 'you' : 'agent'}">${esc(tr(r.role === 'user' ? 'history.you' : 'history.agent'))}</span><b>${esc(r.title || r.session.slice(0, 8))}</b><time>${esc(r.date ? date(Date.parse(r.date)) : tr('history.unknownDate'))}</time></header>
          <p class="ex">${(r.text.indexOf(r.excerpt) > 0 ? '…' : '') + mark(r.excerpt.replace(/\*\*|__|`/g, ''), target.query)}</p>
        </article>`,
      )
      .join('')
    foot.textContent = [tr('history.results', { n: d.results.length }), d.truncated ? tr('history.limited') : ''].filter(Boolean).join(' · ')
  }

  /** The text, escaped, with every place the query matches marked. */
  const mark = (text, query) => markParts(text, query).map(p => (p.hit ? `<mark>${esc(p.text)}</mark>` : esc(p.text))).join('')

  async function search(target, query) {
    target.query = query
    target.result = { loading: true }
    hits(target)
    const seq = ++ql.seq
    let d = { unavailable: true }
    try {
      const res = await fetch(`/api/session/${encodeURIComponent(target.history)}/history?q=${encodeURIComponent(query)}`)
      if (res.ok) d = await res.json()
    } catch {}
    if (seq !== ql.seq || ql.stack.at(-1) !== target) return
    target.result = d
    hits(target)
  }

  const date = ms => new Date(ms).toLocaleString(t().lang, { dateStyle: 'medium', timeStyle: 'short' })
  const size = n => sizeText(n, t())
  function empty(kind, text, open = false) {
    return `<div class="ql-empty">${iconOf(kind)}<p>${esc(text)}</p>${open ? `<button class="button primary" data-ql="open">${esc(tr('ql.open'))}</button>` : ''}</div>`
  }
  function code(text, line) {
    return `<div class="ql-code">${codeLines(text).map((l, i) => `<div class="ql-ln${i + 1 === line ? ' hit' : ''}" data-n="${i + 1}">${esc(l) || '​'}</div>`).join('')}</div>`
  }
  function table(rows) {
    const [first, ...rest] = rows
    const cell = (tag, c) => `<${tag}>${esc(c)}</${tag}>`
    return `<div class="ql-table"><table><thead><tr>${first.map(c => cell('th', c)).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${r.map(c => cell('td', c)).join('')}</tr>`).join('')}</tbody></table></div>`
  }
  function folder(d) {
    if (!d.entries.length) return empty('dir', tr('ql.emptyFolder'))
    return `<div class="ql-list" role="list">${d.entries
      .map(
        e => `<button class="ql-row${e.dir ? ' dir' : ''}" role="listitem" data-go="${esc(inFolder(d.path, e.name))}">
          ${iconOf(e.dir ? 'dir' : e.kind)}<span class="n">${esc(e.name)}</span><span class="m">${e.mtime ? esc(date(e.mtime)) : ''}</span><span class="s">${e.dir ? '' : esc(size(e.size))}</span>
        </button>`,
      )
      .join('')}</div>`
  }

  root.addEventListener('click', e => {
    if (e.target === scrim) return close()
    const go = e.target.closest('[data-go]')
    if (go) {
      ql.stack.push({ path: go.dataset.go, line: null })
      return show()
    }
    const hit = e.target.closest('.ql-hit')
    if (hit && !e.target.closest('[data-fs], a')) return openHit(hit)
    const jump = e.target.closest('[data-jump]')
    if (jump) {
      for (const b of root.querySelectorAll('.ql-file')) b.setAttribute('aria-current', String(b === jump))
      return $(body, `.ql-dfile[data-i="${jump.dataset.jump}"]`)?.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' })
    }
    if (e.target.closest('.ql-refresh')) return show(true)
    const mode = e.target.closest('[data-mode]')
    if (mode && ql.data) {
      ql.mode = mode.dataset.mode
      return render()
    }
    const d = ql.data ?? { path: ql.stack.at(-1)?.path }
    if (e.target.closest('.ql-close')) return close()
    if (e.target.closest('.ql-back')) return back()
    if (e.target.closest('.ql-open, [data-ql="open"]')) return system(d.path, 'open')
    if (e.target.closest('.ql-reveal')) return system(d.path, 'reveal')
    if (e.target.closest('.ql-copy')) return copy(d.line ? `${d.path}:${d.line}` : d.path)
  })
  /** A hit opens to the whole message, rendered; again, it folds back. */
  function openHit(el) {
    const target = ql.stack.at(-1)
    const r = target?.result?.results?.[Number(el.dataset.hit)]
    if (!r) return
    const open = el.classList.toggle('open')
    let full = $(el, '.full')
    if (open && !full) {
      full = document.createElement('div')
      full.className = 'full md'
      full.innerHTML = markdown(r.text)
      el.append(full)
      upgrade(full, target.cwd)
    }
    $(el, '.ex').hidden = open
    if (full) full.hidden = !open
  }
  root.addEventListener('submit', e => {
    if (!e.target.matches('.ql-search')) return
    e.preventDefault()
    const query = $(e.target, 'input').value.trim()
    const target = ql.stack.at(-1)
    if (target?.history && query.length >= 2) search(target, query)
  })
  root.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.ql-hit')) {
      e.preventDefault()
      openHit(e.target)
    }
  })

  // Before the page's own keys: Esc here must not close the session sheet as well.
  addEventListener(
    'keydown',
    e => {
      if (root.hidden || motion.target === 0 || !focus.isTop()) return
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if ((e.key === 'Backspace' && !typing) || (e.key === 'ArrowLeft' && e.altKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        back()
      }
    },
    true,
  )

  return { upgrade, look, back, refreshAvailability: syncActions, lookChanges: (key, el) => look({ changes: key }, el), lookHistory: (key, cwd, el) => look({ history: key, cwd }, el), close, isOpen: () => !root.hidden && motion.target === 1, relabel: () => !root.hidden && (labels(), ql.data && render()) }
}
