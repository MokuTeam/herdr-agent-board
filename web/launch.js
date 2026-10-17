// New sessions from the board: the window that starts one, its folder picker, and the cards of
// sessions on their way. The window grows out of what opened it and, once the session is
// started, folds into the new card in its lane; Esc or Cancel folds it back where it came from.
//
// The folder picker: a path field with completion (folders only; the server lists them and
// says whether a path exists), suggestions from the context (the card's folder, the lane's
// folders, folders of sessions on the board and of recent Claude sessions), and a column view
// to browse, Finder style. The browser offers no picker that gives an absolute path, so this is ours.
import { baseName, categoryForDir, folderSuggestions, NAME_MAX, slugName, splitPathInput, suggestName } from '../src/core/launch/names.ts'
import { reducedMotion, Spring } from './src/models/spring.ts'
import { launchContext, launchDraftBook } from './src/models/launch-drafts.ts'
import { draftOf, fieldOf, formProblems, formStart, goButton, startBody, startedLaunch, workspaceChoice, workspaceName, worktreeNote } from './src/models/launch-form.ts'
import { completionItems, failureHint, folderColumn, chainOf, growFrom, keepsLocal, launchColumn, launcherLine, launchWhere, needsYou, pendingLaunches, retries, rootItems, stepText, suggestionItems, windowPaint } from './src/models/launch.ts'
import { modalFocus } from './src/models/modal-focus.ts'

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const svg = body => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`
const ICON = {
  folder: svg('<path d="M2.5 6a1.5 1.5 0 0 1 1.5-1.5h3.6l1.7 1.8H16A1.5 1.5 0 0 1 17.5 7.8v7.7A1.5 1.5 0 0 1 16 17H4a1.5 1.5 0 0 1-1.5-1.5Z"/>'),
  drive: svg('<rect x="3" y="6" width="14" height="8" rx="2"/><path d="M13.5 10h.01"/>'),
  home: svg('<path d="M3.5 9.5 10 4l6.5 5.5M5.5 8v8h9V8"/>'),
  ok: svg('<path d="m5 10.5 3.2 3.2L15 7"/>'),
  bad: svg('<circle cx="10" cy="10" r="7"/><path d="M10 6.5v4.2M10 13.4h.01"/>'),
  spin: svg('<path class="spin-path" d="M10 3a7 7 0 1 1-7 7"/>'),
  chev: svg('<path d="m8 5 5 5-5 5"/>'),
  close: svg('<path d="m5.5 5.5 9 9m0-9-9 9"/>'),
  warn: svg('<path d="M10 3.5 17.5 16h-15Z"/><path d="M10 8.5v3.2M10 13.8h.01"/>'),
  plus: svg('<path d="M10 4.5v11M4.5 10h11"/>'),
}

/**
 * deps: t() the translator, toast, canMutate(), data() the board payload, onDialogChange() for
 * the mobile Back stack, onStarted(launch) once a session is on its way (the page shows its
 * lane and draws the card), focusLaunch(id) to go to a launch's pane in herdr.
 */
export function initLaunch({ t, toast, canMutate, data, onDialogChange = () => {}, onStarted = () => {}, focusLaunch = () => {} }) {
  const tr = (k, v) => t()(k, v)
  const store = {
    get: k => { try { return localStorage.getItem(k) } catch { return null } },
    set: (k, v) => { try { localStorage.setItem(k, v) } catch {} },
  }
  async function post(url, body) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify(body) })
      const r = await res.json().catch(() => ({}))
      return res.ok && r.ok !== false ? { ok: true, ...r } : { ok: false, ...r, error: r.error || tr('err.status', { code: res.status }) }
    } catch (err) {
      return { ok: false, error: tr('err.offline', { why: err.message }) }
    }
  }

  // ------------------------------------------------------------ the window
  const root = document.createElement('div')
  root.className = 'launch'
  root.hidden = true
  root.innerHTML = `
    <div class="launch-scrim"></div>
    <section class="launch-win" role="dialog" aria-modal="true" aria-labelledby="launch-title" tabindex="-1">
      <header class="launch-head">
        <div class="launch-titles"><h3 id="launch-title"></h3><p class="launch-sub"></p></div>
        <button type="button" class="icon-button launch-close">${ICON.close}</button>
      </header>
      <form class="launch-body" novalidate autocomplete="off">
        <div class="group">
          <label class="row"><span class="row-label" data-t="launch.name"></span><input class="row-value" name="name" maxlength="${NAME_MAX}" spellcheck="false"></label>
          <p class="field-note" data-for="name" hidden></p>
          <div class="row folder-row">
            <span class="row-label" data-t="launch.folder"></span>
            <div class="row-value folder-field">
              <input name="cwd" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="launch-pop">
              <span class="folder-state" aria-hidden="true"></span>
              <button type="button" class="folder-browse" aria-expanded="false"></button>
            </div>
            <div class="folder-pop" id="launch-pop" role="listbox" hidden></div>
          </div>
          <p class="field-note" data-for="cwd" hidden></p>
          <div class="folder-cols" hidden></div>
          <div class="row"><span class="row-label" data-t="row.category"></span><div class="row-value chips launch-cats"></div></div>
          <div class="row where-row">
            <span class="row-label" data-t="launch.where"></span>
            <div class="row-value where">
              <select name="workspace"></select>
              <input name="newWorkspace" maxlength="40" spellcheck="false" hidden>
            </div>
          </div>
          <p class="field-note" data-for="workspace" hidden></p>
          <div class="row wt-row" hidden>
            <span class="row-label" data-t="launch.worktree"></span>
            <div class="row-value wt">
              <label class="wt-toggle"><input type="checkbox" name="wt"><span data-t="launch.worktreeNew"></span></label>
              <input name="branch" maxlength="100" spellcheck="false" hidden>
            </div>
          </div>
          <p class="field-note wt-note" data-for="worktree" hidden></p>
        </div>
        <div class="group message-group">
          <textarea name="message" rows="3" spellcheck="true"></textarea>
        </div>
        <p class="launch-error" role="alert" hidden></p>
      </form>
      <footer class="launch-foot">
        <span class="launch-keys"></span>
        <button type="button" class="button launch-cancel"></button>
        <button type="button" class="button primary launch-go"></button>
      </footer>
    </section>`
  document.body.append(root)
  const $ = sel => root.querySelector(sel)
  const win = $('.launch-win')
  const focus = modalFocus(root, win)
  const scrim = $('.launch-scrim')
  const form = $('form')
  const f = {
    name: form.elements.name,
    cwd: form.elements.cwd,
    workspace: form.elements.workspace,
    newWorkspace: form.elements.newWorkspace,
    wt: form.elements.wt,
    branch: form.elements.branch,
    message: form.elements.message,
  }

  // What is being made: the values, and which of them the user set (those stop following the folder).
  let s = null
  let options = { launcher: { kind: 'herdr', agent: 'claude' }, workspaces: [], recent: [], board: '' }
  const local = new Map() // launch id -> launch, until the server's board has it
  const drafts = launchDraftBook()

  function labels() {
    for (const el of root.querySelectorAll('[data-t]')) el.textContent = tr(el.dataset.t)
    $('#launch-title').textContent = tr(s?.retry ? 'launch.retryTitle' : 'launch.title')
    $('.launch-close').title = tr('sheet.close')
    $('.launch-close').setAttribute('aria-label', tr('sheet.closeLabel'))
    $('.folder-browse').textContent = tr('launch.browse')
    f.name.placeholder = tr('launch.namePlaceholder')
    f.cwd.placeholder = tr('launch.folderPlaceholder')
    f.newWorkspace.placeholder = tr('launch.workspaceName')
    f.branch.placeholder = tr('launch.branch')
    f.message.placeholder = tr('launch.message')
    $('.launch-cancel').textContent = tr('cancel')
    $('.launch-go').textContent = tr('launch.start')
    $('.launch-keys').textContent = tr('launch.keys')
    $('.launch-sub').textContent = launcherLine(options.launcher, tr)
  }

  // ------------------------------------------------------------ motion: out of the origin and back
  const motion = new Spring({ value: 0, damping: 1, response: 0.34, precision: 0.002, onUpdate: v => paint(v), onRest: v => v === 0 && finishClose() })
  let from = { dx: 0, dy: 24, s: 0.94 }
  let origin = null

  function measure(rect) {
    const saved = win.style.transform
    win.style.transform = 'none'
    const w = win.getBoundingClientRect()
    win.style.transform = saved
    return growFrom(rect, w, innerHeight)
  }
  function paint(p) {
    const look = windowPaint(p, from, reducedMotion.matches)
    win.style.transform = look.transform
    win.style.opacity = look.opacity
    scrim.style.opacity = look.scrim
  }
  const rectOf = o => (o instanceof Element ? (o.isConnected ? o.getBoundingClientRect() : null) : o ?? null)

  /**
   * Open the window. ctx: { category, cwd, workspace (label), item (a card it is for), newWorkspace,
   * retry (a failed launch to start again) }. `from` is the element or rect it grows out of.
   */
  async function open(ctx = {}, fromEl = null) {
    if (!canMutate()) return toast(tr('mobile.readOnly'), true)
    origin = fromEl
    s = { ctx, draftKey: launchContext(ctx, d().filter), set: {}, check: null, git: null, cache: new Map(), retry: ctx.retry ?? null }
    root.hidden = false
    focus.open(fromEl instanceof Element ? fromEl : document.activeElement)
    labels()
    fill(ctx)
    from = measure(rectOf(fromEl))
    if (motion.value <= 0.001) paint(0)
    motion.to(1, { damping: 1, response: 0.34 })
    setTimeout(() => {
      const first = ctx.newWorkspace ? f.newWorkspace : f.name
      first.focus({ preventScroll: true })
      first.select?.()
    }, 30)
    onDialogChange()
    // Workspaces and recent folders come from the server; the window is usable before they do.
    const opts = await fetch('/api/launch/options').then(r => r.json()).catch(() => null)
    if (!opts || !s || s.ctx !== ctx) return
    options = opts
    labels()
    renderWorkspaces()
    if (!s.set.cwd && !f.cwd.value) applyFolder(suggestions()[0]?.path ?? '', false)
  }

  /** Keep the whole form for this opening context, never just a prompt for another project. */
  function close(to = null, started = false) {
    if (root.hidden || motion.target === 0) return
    if (!started) drafts.write(s.draftKey, draftForm())
    closePop()
    from = measure(rectOf(to) ?? rectOf(origin))
    motion.to(0, { damping: 1, response: 0.28 })
    if (reducedMotion.matches) motion.set(0)
    onDialogChange()
  }
  function finishClose() {
    root.hidden = true
    s = null
    focus.close()
    origin = null
  }

  // ------------------------------------------------------------ values
  const d = () => data()
  const catTitle = id => d().categories.find(c => c.id === id)?.title ?? id

  const fields = () => ({ name: f.name.value, cwd: f.cwd.value, workspace: f.workspace.value, newWorkspace: f.newWorkspace.value, wt: f.wt.checked, branch: f.branch.value, message: f.message.value })
  const workspaceLabel = () => (f.workspace.value ? f.workspace.selectedOptions[0]?.textContent ?? '' : '')
  const draftForm = () => draftOf(fields(), s.category, workspaceLabel())

  function fill(ctx) {
    const start = formStart(ctx, ctx.retry ? null : drafts.read(s.draftKey), { items: d().items ?? [], filter: d().filter })
    s.category = start.category
    s.set = start.set
    s.workspace = start.workspace
    f.cwd.value = start.cwd
    showEnd()
    f.name.value = start.name
    f.message.value = start.message
    f.wt.checked = start.wt
    f.branch.value = start.branch
    for (const el of root.querySelectorAll('.field-note, .launch-error')) el.hidden = true
    renderCats()
    renderWorkspaces()
    renderWorktree()
    if (start.cwd) checkFolder()
    else setState('')
  }

  function renderCats() {
    const box = $('.launch-cats')
    box.innerHTML = d()
      .categories.map(c => `<button type="button" data-cat="${esc(c.id)}" style="--lane:${esc(c.color)}" aria-pressed="${c.id === s.category}">${esc(c.title)}</button>`)
      .join('')
  }

  /** Workspaces herdr has, the board's own left out; the last choice is a new one. */
  function renderWorkspaces() {
    if (!s) return
    const choice = workspaceChoice({ workspaces: options.workspaces, board: options.board, want: s.workspace, wanted: s.set.workspace, category: s.category, title: catTitle(s.category), items: d().items ?? [], fallback: store.get('board.launch.workspace') ?? options.focused })
    f.workspace.innerHTML =
      choice.list.map(w => `<option value="${esc(w.id)}"${w.id === choice.value ? ' selected' : ''}>${esc(w.label)}</option>`).join('') +
      `<option value=""${choice.create ? ' selected' : ''}>${esc(tr('launch.newWorkspace'))}</option>`
    f.newWorkspace.hidden = !choice.create
    if (choice.create && !f.newWorkspace.value) f.newWorkspace.value = choice.seed || defaultWorkspaceName()
  }
  const defaultWorkspaceName = () => workspaceName(s.category, catTitle(s.category), f.cwd.value, tr)

  // ------------------------------------------------------------ folder: state, completion, browsing
  let checkTimer = 0
  async function dirs(path, git = false) {
    const key = `${path}\n${git}`
    if (s?.cache.has(key)) return s.cache.get(key)
    const res = await fetch('/api/fs/dirs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': '1' }, body: JSON.stringify({ path, git }) })
      .then(r => r.json())
      .catch(() => null)
    if (res && s) s.cache.set(key, res)
    return res
  }

  function setState(kind, note = '') {
    const el = $('.folder-state')
    el.dataset.state = kind
    el.innerHTML = kind === 'ok' ? ICON.ok : kind === 'bad' ? ICON.bad : kind === 'wait' ? ICON.spin : ''
    noteFor('cwd', note)
    syncGo()
  }
  function noteFor(field, text, error = true) {
    const el = root.querySelector(`.field-note[data-for="${field}"]`)
    if (!el) return
    el.hidden = !text
    el.textContent = text
    el.classList.toggle('error', !!text && error)
  }

  /** What the server says about the folder field, a moment after the typing stops. */
  function checkFolder() {
    clearTimeout(checkTimer)
    // What was checked before is about another folder now.
    s.check = null
    s.git = null
    const path = f.cwd.value.trim()
    if (!path) return setState('')
    setState('wait')
    checkTimer = setTimeout(() => runCheck(path), 160)
  }

  async function runCheck(path) {
    clearTimeout(checkTimer)
    const r = await dirs(path, true)
    if (!s || f.cwd.value.trim() !== path) return
    s.check = { ...r, input: path }
    if (r?.slow) setState('bad', tr('launch.err.cwdSlow', { path }))
    else if (!r || !r.exists) setState('bad', tr('launch.err.cwdMissing', { path }))
    else if (!r.dir) setState('bad', tr('launch.err.cwdFile', { path }))
    else setState('ok')
    s.git = r?.git ?? null
    renderWorktree()
    // The folder decides the category until the user picks one.
    if (r?.exists && r.dir && !s.set.category) {
      const cat = categoryForDir(d().categories, r.path)
      if (cat && cat !== s.category) {
        s.category = cat
        renderCats()
        renderWorkspaces()
      }
    }
  }

  // A long path shows its end, where the folder's own name is, unless it is being edited.
  const showEnd = () => requestAnimationFrame(() => document.activeElement !== f.cwd && (f.cwd.scrollLeft = f.cwd.scrollWidth))
  f.cwd.addEventListener('blur', showEnd)

  function applyFolder(path, byUser = true) {
    f.cwd.value = path
    showEnd()
    if (byUser) s.set.cwd = true
    if (!s.set.name) f.name.value = path ? suggestName(path, d().items ?? []) : ''
    if (!s.set.branch) f.branch.value = ''
    checkFolder()
    syncGo()
  }

  const suggestions = () => folderSuggestions({ context: { cwd: s.ctx.item?.cwd ?? s.ctx.cwd, category: s.category }, categories: d().categories, items: d().items ?? [], recent: options.recent ?? [] })

  // The list under the field: suggestions while it is untouched, folders that match once typing.
  let pop = { items: [], active: -1, open: false }
  let popSeq = 0
  async function showPop(typed) {
    const seq = ++popSeq
    let items
    if (!typed) items = suggestionItems(suggestions(), tr)
    else {
      // Nothing but "C:" or "~" yet (no folder in it): the drives and home.
      const { dir, prefix } = splitPathInput(f.cwd.value)
      const r = await dirs(dir)
      if (seq !== popSeq || !s) return
      items = dir ? completionItems(r, dir, prefix) : rootItems(r, prefix, tr)
    }
    if (seq !== popSeq || !s) return
    pop = { items, active: -1, open: items.length > 0 }
    const el = $('.folder-pop')
    el.hidden = !pop.open
    f.cwd.setAttribute('aria-expanded', String(pop.open))
    el.innerHTML = items
      .map((x, i) => `<div class="pop-item" role="option" id="launch-opt-${i}" data-i="${i}" title="${esc(x.detail)}">${ICON.folder}<span class="pop-name">${esc(x.label)}</span><span class="pop-detail">${esc(x.why ?? x.detail)}</span></div>`)
      .join('')
  }
  function closePop() {
    pop = { items: [], active: -1, open: false }
    $('.folder-pop').hidden = true
    f.cwd.setAttribute('aria-expanded', 'false')
    f.cwd.removeAttribute('aria-activedescendant')
  }
  function lightPop(i) {
    pop.active = i
    for (const el of root.querySelectorAll('.pop-item')) el.classList.toggle('active', Number(el.dataset.i) === i)
    const el = root.querySelector(`#launch-opt-${i}`)
    if (el) {
      f.cwd.setAttribute('aria-activedescendant', el.id)
      el.scrollIntoView({ block: 'nearest' })
    }
  }
  function takePop(i) {
    const x = pop.items[i]
    if (!x) return
    if (x.complete) {
      // A completed folder name goes on with its separator, so its own folders come next.
      const sep = splitPathInput(f.cwd.value).sep
      applyFolder(x.path + sep)
      showPop(true)
    } else {
      applyFolder(x.path)
      closePop()
    }
    f.cwd.focus()
  }

  f.cwd.addEventListener('input', () => {
    applyFolder(f.cwd.value)
    showPop(true)
  })
  f.cwd.addEventListener('focus', () => showPop(false))
  f.cwd.addEventListener('blur', () => setTimeout(() => document.activeElement !== f.cwd && closePop(), 120))
  f.cwd.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !(pop.open && pop.active >= 0)) {
      e.preventDefault()
      closePop()
      return submit()
    }
    if (!pop.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        showPop(false)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = pop.items.length
      lightPop(pop.active < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (pop.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
    } else if ((e.key === 'Enter' || e.key === 'Tab') && pop.active >= 0) {
      e.preventDefault()
      e.stopPropagation()
      takePop(pop.active)
    } else if (e.key === 'Tab' && pop.items.length === 1) {
      e.preventDefault()
      takePop(0)
    }
  })
  $('.folder-pop').addEventListener('pointerdown', e => e.preventDefault())
  $('.folder-pop').addEventListener('click', e => {
    const el = e.target.closest('.pop-item')
    if (el) takePop(Number(el.dataset.i))
  })

  // Columns, Finder style: the drives (and home), then each folder down to the chosen one, then
  // its subfolders. A click picks a folder and opens it in the next column; arrows walk.
  const cols = $('.folder-cols')
  let browse = { open: false, chain: [], focus: null }

  async function openBrowse() {
    browse.open = true
    cols.hidden = false
    $('.folder-browse').setAttribute('aria-expanded', 'true')
    closePop()
    const r = f.cwd.value.trim() ? await dirs(f.cwd.value.trim()) : null
    const at = r?.exists && r.dir ? r.path : ''
    await showChain(at ? ['', ...chainOf(at, r.sep ?? '\\')] : [''])
  }
  function closeBrowse() {
    browse.open = false
    cols.hidden = true
    $('.folder-browse').setAttribute('aria-expanded', 'false')
  }

  async function showChain(chain) {
    browse.chain = chain
    const lists = await Promise.all(chain.map(p => dirs(p)))
    if (!s || browse.chain !== chain) return
    cols.innerHTML = lists
      .map((r, i) => {
        const col = folderColumn(r, chain[i + 1], tr)
        const body = col.rows.length
          ? col.rows.map(x => `<button type="button" class="col-row${x.on ? ' on' : ''}" data-path="${esc(x.path)}" data-col="${i}" title="${esc(x.path)}">${ICON[x.icon]}<span>${esc(x.name)}</span>${x.chev ? ICON.chev : ''}</button>`).join('')
          : `<p class="col-empty">${esc(col.empty)}</p>`
        return `<div class="col-list" role="listbox" aria-label="${esc(col.label)}">${body}</div>`
      })
      .join('')
    cols.scrollLeft = cols.scrollWidth
  }

  cols.addEventListener('click', e => {
    const row = e.target.closest('.col-row')
    if (!row) return
    const i = Number(row.dataset.col)
    applyFolder(row.dataset.path)
    showChain([...browse.chain.slice(0, i + 1), row.dataset.path]).then(() => cols.querySelector(`.col-row[data-path="${CSS.escape(row.dataset.path)}"]`)?.focus({ preventScroll: true }))
  })
  cols.addEventListener('dblclick', e => {
    if (e.target.closest('.col-row')) closeBrowse()
  })
  cols.addEventListener('keydown', e => {
    const row = e.target.closest('.col-row')
    if (!row) return
    const list = [...row.parentElement.querySelectorAll('.col-row')]
    const i = list.indexOf(row)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.click()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      row.parentElement.nextElementSibling?.querySelector('.col-row')?.click()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      row.parentElement.previousElementSibling?.querySelector('.col-row.on')?.click()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      closeBrowse()
      f.cwd.focus()
    }
  })
  $('.folder-browse').addEventListener('click', () => (browse.open ? closeBrowse() : openBrowse()))

  // ------------------------------------------------------------ the rest of the form
  $('.launch-cats').addEventListener('click', e => {
    const b = e.target.closest('button[data-cat]')
    if (!b) return
    s.category = b.dataset.cat
    s.set.category = true
    renderCats()
    if (!s.set.workspace) renderWorkspaces()
  })
  f.name.addEventListener('input', () => {
    s.set.name = true
    noteFor('name', '')
    if (!s.set.branch) renderWorktree()
    syncGo()
  })
  f.workspace.addEventListener('change', () => {
    s.set.workspace = true
    const create = !f.workspace.value
    s.workspace = create ? { create: f.newWorkspace.value } : { id: f.workspace.value }
    f.newWorkspace.hidden = !create
    if (create) {
      if (!f.newWorkspace.value) f.newWorkspace.value = defaultWorkspaceName()
      f.newWorkspace.focus()
      f.newWorkspace.select()
    }
    noteFor('workspace', '')
  })
  f.newWorkspace.addEventListener('input', () => {
    s.set.workspace = true
    s.workspace = { create: f.newWorkspace.value }
  })
  f.wt.addEventListener('change', () => {
    renderWorktree()
    if (f.wt.checked) f.branch.focus()
  })
  f.branch.addEventListener('input', () => {
    s.set.branch = true
    renderWorktree()
  })

  /** The worktree choice shows for folders in a git checkout: a new branch in a sibling folder. */
  function renderWorktree() {
    if (!s) return
    const git = s.git
    $('.wt-row').hidden = !git
    if (!git) {
      noteFor('worktree', '')
      return syncGo()
    }
    f.branch.hidden = !f.wt.checked
    if (!s.set.branch) f.branch.value = slugName(f.name.value || baseName(f.cwd.value))
    const note = worktreeNote(git, f.wt.checked, f.branch.value, tr)
    noteFor('worktree', note.text, note.error)
    syncGo()
  }

  const problems = () => formProblems(fields(), s.check, s.git, tr)
  function syncGo() {
    if (!s) return
    const go = $('.launch-go')
    const look = goButton({ canMutate: canMutate(), problems: problems(), checking: $('.folder-state').dataset.state === 'wait', sending: !!s.sending }, tr)
    go.disabled = look.disabled
    go.title = look.title
  }

  async function submit() {
    if (!s || s.sending) return
    // Enter can come before the folder was checked: check it now, then go on with that answer.
    const cwd = f.cwd.value.trim()
    if (cwd && s.check?.input !== cwd) {
      await runCheck(cwd)
      if (!s || f.cwd.value.trim() !== cwd) return
    }
    const bad = problems()
    if (Object.keys(bad).length) {
      for (const [k, v] of Object.entries(bad)) noteFor(k, v)
      root.querySelector(`[name="${fieldOf(Object.keys(bad)[0])}"]`)?.focus()
      return
    }
    if (!canMutate()) return toast(tr('mobile.readOnly'), true)
    const body = startBody(fields(), { check: s.check, git: s.git, category: s.category, label: workspaceLabel() })
    const ws = body.workspace
    const st = s
    const draftVersion = drafts.write(st.draftKey, draftForm())
    st.sending = true
    syncGo()
    const r = await post('/api/launch', body)
    st.sending = false
    // Closed (or opened anew) while the request was out: the start still counts, the old form does not.
    const here = s === st
    if (!r.ok) {
      if (!here) return toast(r.error, true)
      syncGo()
      if (r.field) {
        noteFor(r.field, r.error)
        root.querySelector(`[name="${fieldOf(r.field)}"]`)?.focus()
      } else {
        $('.launch-error').hidden = false
        $('.launch-error').textContent = r.error
      }
      return
    }
    if (ws.id) store.set('board.launch.workspace', ws.id)
    if (st.retry) post(`/api/launch/${encodeURIComponent(st.retry.id)}/dismiss`, {})
    drafts.clear(st.draftKey, draftVersion)
    const launch = startedLaunch(r.id, body, Date.now())
    local.set(r.id, launch)
    onStarted(launch)
    // The window folds into the new card, where the session will be.
    if (here) requestAnimationFrame(() => close(document.querySelector(`.card[data-key="launch:${CSS.escape(r.id)}"]`), true))
  }

  $('.launch-go').addEventListener('click', submit)
  $('.launch-cancel').addEventListener('click', () => close())
  $('.launch-close').addEventListener('click', () => close())
  // A click beside the window closes it only while nothing was written in it yet.
  scrim.addEventListener('click', () => (f.message.value.trim() ? win.focus({ preventScroll: true }) : close()))
  form.addEventListener('submit', e => {
    e.preventDefault()
    submit()
  })

  // Keys before the page's own: Esc closes the innermost thing first, Ctrl+Enter starts, Tab
  // stays in the window.
  addEventListener(
    'keydown',
    e => {
      if (root.hidden || motion.target === 0 || !focus.isTop()) return
      // Enter and Esc while an input method composes belong to it (they pick or drop a word).
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (pop.open) closePop()
        else if (browse.open) {
          closeBrowse()
          f.cwd.focus()
        } else close()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        submit()
      } else if (e.key === 'Enter' && e.target.matches?.('input[name="name"], input[name="newWorkspace"], input[name="branch"]')) {
        e.preventDefault()
        submit()
      }
    },
    true,
  )

  // ------------------------------------------------------------ sessions on their way
  /** Launches of the board to draw as cards of their own: not yet a session on the board. */
  function pending() {
    const server = d().launches ?? []
    const now = Date.now()
    for (const [id, l] of local) if (!keepsLocal(l, server, now)) local.delete(id)
    return pendingLaunches(server, [...local.values()], d().items ?? [], now)
  }

  /** Board items for them, in their lane: "Working" while they start, "Needs me" once they failed or wait for a dialog. */
  function placeholders() {
    return pending().map(l => ({
      key: `launch:${l.id}`,
      launchOnly: true,
      launch: l,
      name: l.name,
      category: l.category,
      column: launchColumn(l),
      cwd: l.cwd,
      workspace: l.workspace,
      activity: l.startedAt,
      status: 'starting',
    }))
  }

  /** The lines a launch adds to a card: how it goes, or why it failed and what to do. */
  function note(l) {
    if (!l) return ''
    const go = l.pane ? `<button class="button" data-launch="focus" data-id="${esc(l.id)}">${esc(tr('card.focus'))}</button>` : ''
    if (l.state === 'failed') {
      // Failed only at its first message, the session runs: a retry would start a second one.
      const retry = !retries(l) ? '' : `<button class="button" data-launch="retry" data-id="${esc(l.id)}">${esc(tr('launch.retry'))}</button>`
      return `<div class="launch-note failed"><div class="ln-why">${ICON.warn}<span>${esc(l.error || tr('launch.failed'))}</span></div><div class="ln-hint">${esc(tr(failureHint(l)))}</div><div class="ln-actions">${retry}${go}<button class="button plain" data-launch="dismiss" data-id="${esc(l.id)}">${esc(tr('launch.dismiss'))}</button></div></div>`
    }
    if (l.state === 'trust') {
      // Claude stopped at "Do you trust this folder?": the folder, and the two ways on.
      const busy = l.step === 'trusting' ? ' disabled' : ''
      return `<div class="launch-note waiting trust"><div class="ln-why">${ICON.warn}<span>${esc(tr('launch.trust.title'))}</span></div><div class="ln-folder" title="${esc(l.cwd)}">${esc(l.cwd)}</div><div class="ln-hint">${esc(tr('launch.trust.hint'))}</div><div class="ln-actions"><button class="button primary" data-launch="trust" data-id="${esc(l.id)}"${busy}>${esc(tr(l.step === 'trusting' ? 'launch.step.trusting' : 'launch.trust.go'))}</button><button class="button" data-launch="closeTab" data-id="${esc(l.id)}"${busy}>${esc(tr('launch.trust.close'))}</button>${go}</div></div>`
    }
    if (l.state === 'waiting') {
      return `<div class="launch-note waiting"><div class="ln-why">${ICON.warn}<span>${esc(tr('launch.step.dialog'))}</span></div><div class="ln-hint">${esc(tr('launch.hint.dialog'))}</div><div class="ln-actions">${go}</div></div>`
    }
    return `<div class="launch-note"><span class="ln-spin">${ICON.spin}</span><span>${esc(stepText(l, tr, options.launcher.name ?? ''))}</span></div>`
  }

  /** The card of a session on its way that is not on the board yet. */
  function cardHTML(it) {
    const l = it.launch
    const icon = needsYou(l) ? `<span class="dot" style="--c:var(--orange)"></span>` : `<span class="dot work launching" style="--c:var(--green)"></span>`
    const where = launchWhere(l, tr)
    return `<div class="card-top">${icon}<span class="name">${esc(l.name)}</span><span class="age">${esc(tr('launch.new'))}</span></div><div class="said" title="${esc(l.cwd)}">${esc(where)}</div>${note(l)}`
  }

  /** What the buttons in those lines do. Returns true when the click was one of them. */
  function onCardAction(e) {
    const b = e.target.closest('[data-launch]')
    if (!b) return false
    const id = b.dataset.id
    const l = (d().launches ?? []).find(x => x.id === id) ?? local.get(id)
    if (b.dataset.launch === 'dismiss') dismiss(id)
    else if (b.dataset.launch === 'retry' && l) open({ retry: l }, b)
    else if (b.dataset.launch === 'focus') focusLaunch(id)
    else if (b.dataset.launch === 'trust') trust(id, b)
    else if (b.dataset.launch === 'closeTab') closeTab(id, b)
    return true
  }

  /** The folder-trust dialog, answered from the card: the server checks the screen before any key. */
  async function trust(id, b = null) {
    if (b) b.disabled = true
    const r = await post(`/api/launch/${encodeURIComponent(id)}/trust`, {})
    if (!r.ok) {
      if (b?.isConnected) b.disabled = false
      toast(r.error, true)
    }
  }

  async function closeTab(id, b = null) {
    if (b) b.disabled = true
    const r = await post(`/api/launch/${encodeURIComponent(id)}/close`, {})
    if (r.ok) toast(tr('launch.trust.closed'))
    else {
      if (b?.isConnected) b.disabled = false
      toast(r.error, true)
    }
  }

  async function dismiss(id) {
    local.delete(id)
    const r = await post(`/api/launch/${encodeURIComponent(id)}/dismiss`, {})
    if (!r.ok && r.error) toast(r.error, true)
  }

  return {
    open,
    close: () => close(),
    isOpen: () => !root.hidden && motion.target === 1,
    relabel: () => !root.hidden && labels(),
    placeholders,
    cardHTML,
    note,
    onCardAction,
    dismiss,
    trust,
    closeTab,
    retry: (l, el) => open({ retry: l }, el),
    syncAvailability: () => syncGo(),
  }
}
