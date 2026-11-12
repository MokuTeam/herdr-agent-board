// Threads mockups (#379). One set of sample threads, drawn twice: by the board's panel and by
// MokuPilot's tab. That is the design in small: one store, two views. Nothing here talks to a
// board; every click only changes what the mockup shows, and a note says where the real one goes.

const I = {
  chev: '<path d="m8 5 5 5-5 5"/>',
  down: '<path d="m6 8 4 4 4-4"/>',
  updown: '<path d="m6.5 8 3.5-3.5L13.5 8M6.5 12l3.5 3.5 3.5-3.5"/>',
  out: '<path d="M7 4.5h8.5V13M15 5 5 15"/>',
  clip: '<path d="m15.5 9.5-5.6 5.6a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.2 1.2 0 0 1-1.7-1.7L12 6.2"/>',
  file: '<path d="M5.5 2.5h6l3.5 3.5v11.5h-9.5Z"/><path d="M11.5 2.5V6H15"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  tasks: '<rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><path d="m6.6 10.2 2.2 2.2 4.6-4.8"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/>',
  team: '<path d="M3.5 5.5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H8.5L6 12.5v-2h-.5a2 2 0 0 1-2-2z"/><path d="M10.5 12.5h1.5l2.5 2v-2h.5a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2"/>',
  plus: '<path d="M10 4.5v11M4.5 10h11"/>',
  close: '<path d="m5.5 5.5 9 9m0-9-9 9"/>',
  more: '<circle cx="4.5" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.4" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10" r="1.4" fill="currentColor" stroke="none"/>',
  send: '<path d="M10 16V4m-5 5 5-5 5 5"/>',
  moon: '<path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7Z"/>',
  search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/>',
  back: '<path d="m12 5-5 5 5 5"/>',
  next: '<path d="M4 10h11.5m-4.5-4.5 4.5 4.5-4.5 4.5"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6 15 15M5 15l1.4-1.4M13.6 6.4 15 5"/>',
  // new for threads: a list whose lines carry a status dot
  threads: '<path d="M8 5.5h8.5M8 10h8.5M8 14.5h5.5"/><circle cx="4.3" cy="5.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.3" cy="10" r="1.3"/><circle cx="4.3" cy="14.5" r="1.3"/>',
  agent: '<rect x="2" y="3.5" width="16" height="13" rx="3"/><path d="M5.5 8.5 8 10.2l-2.5 1.8M10.5 12.5h4"/>',
  people: '<circle cx="7" cy="7.5" r="2.6"/><circle cx="13.2" cy="7.5" r="2.6"/><path d="M2.5 15.5c.7-2.4 2.4-3.6 4.5-3.6s3.8 1.2 4.5 3.6M9 15.5c.6-2.4 2.2-3.6 4.2-3.6s3.6 1.2 4.3 3.6"/>',
  link: '<path d="M8.5 11.5a3.2 3.2 0 0 0 4.5 0l2.6-2.6a3.2 3.2 0 0 0-4.5-4.5l-.9.9M11.5 8.5a3.2 3.2 0 0 0-4.5 0l-2.6 2.6a3.2 3.2 0 0 0 4.5 4.5l.9-.9"/>',
}
const ic = (name, cls = '') => `<svg viewBox="0 0 20 20"${cls ? ` class="${cls}"` : ''} aria-hidden="true">${I[name]}</svg>`

const STATUS = {
  owner: { label: 'Needs you', c: 'var(--orange)', mp: 'var(--mp-warn)' },
  doing: { label: 'Doing', c: 'var(--green)', mp: 'var(--mp-ai)' },
  waiting: { label: 'Waiting', c: 'var(--purple)', mp: 'var(--mp-wait)' },
  next: { label: 'Next', c: 'var(--gray)', mp: 'var(--mp-t5)' },
  done: { label: 'Done', c: 'var(--blue)', mp: 'var(--mp-ok)' },
}

// Who writes and who holds a thread. `col` is the column the session's card is in on the board.
const WHO = {
  you: { name: 'You', owner: true },
  moku: { name: 'Moku', col: 'doing', day: true },
  master: { name: 'atlas-master', col: 'doing' },
  mapper: { name: 'atlas-mapper', col: 'owner' },
  check: { name: 'atlas-check', col: 'done' },
  ops: { name: 'atlas-ops', col: 'waiting' },
  probe: { name: 'api-probe', peer: "ben's board" },
  ben: { name: 'ben', peer: 'ben', person: true },
}

const THREADS = [
  {
    key: 'atlas-13', parent: 'atlas-12', title: 'Map the 2019 price columns', status: 'owner', who: 'mapper', when: '14:02', news: 2,
    summary: '214 of 217 rows mapped, 3 need a decision',
    entries: [
      { t: 'sys', when: '10:02', text: '<b>atlas-master</b> created this under {atlas-12} and handed it to <b>atlas-mapper</b>' },
      { t: 'status', who: 'mapper', to: 'doing', when: '10:03' },
      { t: 'note', who: 'mapper', when: '13:58', text: ['Mapped 214 of 217 rows. The three left have a row in both the 2019 and the 2021 price list, with different prices.', 'The report lists them with both prices.'], files: [{ name: 'mapping-report.md', size: '18 KB' }] },
      { t: 'new' },
      { t: 'ask', who: 'mapper', when: '14:02', text: 'Which price list wins when both have a row?', options: ['2021 always', 'The newer valid-from date'] },
    ],
  },
  {
    key: 'atlas-10', title: 'Send the weekly status to the client', status: 'owner', who: 'master', when: '13:38',
    summary: 'The agent says this is done', proposed: 'sent to the project list at 13:38, copy attached',
    entries: [
      { t: 'sys', when: 'Mon 09:05', text: '<b>You</b> created this' },
      { t: 'note', who: 'master', when: '13:38', text: ['Sent to the project list. The copy is attached.'], files: [{ name: 'weekly-status.md', size: '4 KB' }] },
    ],
  },
  {
    key: 'atlas-18', title: 'Prepare the notes for the 15:00 sync', status: 'doing', who: 'moku', when: '14:05',
    summary: 'Collecting what changed since Monday',
    entries: [],
  },
  {
    key: 'atlas-12', title: 'Import mapping for the order feed', status: 'doing', who: 'master', when: '14:02',
    summary: '1 of 3 parts done, one waits on you', kids: ['atlas-13', 'atlas-14', 'atlas-15'],
    entries: [
      { t: 'sys', when: '10:01', text: '<b>Moku</b> created this and handed it to <b>atlas-master</b>' },
      { t: 'note', who: 'master', when: '10:02', text: ['Split into three parts: the price columns ({atlas-13}), the totals ({atlas-14}) and the load into staging ({atlas-15}).'] },
      { t: 'status', who: 'check', to: 'done', key: 'atlas-14', when: '12:48' },
    ],
  },
  {
    key: 'atlas-16', title: 'Vendor API rate limits', status: 'doing', who: 'probe', shared: 'ben', when: '13:57', news: 1,
    summary: '600 requests a minute per key; backoff draft in review',
    entries: [
      { t: 'sys', when: 'Tue 16:10', text: '<b>You</b> shared this with <b>ben</b>. Entries from here on go to both boards.' },
      { t: 'note', who: 'probe', when: '11:32', text: ['Measured the vendor API: 600 requests a minute per key, then a 429 with Retry-After.'] },
      { t: 'note', who: 'ben', when: '11:40', text: ['We hold two keys, so the import can run at twice that.'] },
      { t: 'status', who: 'probe', to: 'doing', when: '13:55', summary: '600 requests a minute per key; backoff draft in review' },
      { t: 'new' },
      { t: 'held', who: 'mapper', when: '13:57', text: ['Backoff plan for the import, with the numbers from our side.'], files: [{ name: 'backoff-plan.md', size: '6 KB' }], why: "An agent's file waits for you to send" },
    ],
  },
  {
    key: 'atlas-9', title: 'Refresh the staging database', status: 'waiting', who: 'ops', when: '11:20',
    summary: 'Waits on the nightly snapshot, 02:00',
    entries: [
      { t: 'sys', when: '11:05', text: '<b>atlas-master</b> created this and handed it to <b>atlas-ops</b>' },
      { t: 'status', who: 'ops', to: 'waiting', when: '11:20', summary: 'the nightly snapshot, 02:00' },
    ],
  },
  { key: 'atlas-15', parent: 'atlas-12', title: 'Load the mapped feed into staging', status: 'next', when: '10:02', entries: [] },
  { key: 'atlas-17', title: 'Write the cutover checklist', status: 'next', when: '09:30', entries: [] },
  {
    key: 'atlas-14', parent: 'atlas-12', title: 'Validate totals against the March export', status: 'done', who: 'check', when: '12:48',
    summary: 'All 1,204 totals match',
    entries: [
      { t: 'sys', when: '10:02', text: '<b>atlas-master</b> created this under {atlas-12} and handed it to <b>atlas-check</b>' },
      { t: 'status', who: 'check', to: 'doing', when: '10:04' },
      { t: 'note', who: 'check', when: '12:48', text: ['Compared 1,204 order totals with the March export. All match to the cent.'], files: [{ name: 'totals-check.md', size: '9 KB' }] },
      { t: 'status', who: 'check', to: 'done', when: '12:48', summary: 'All 1,204 totals match' },
    ],
  },
  { key: 'atlas-8', title: 'Set up the atlas worktree', status: 'done', who: 'master', when: '09:12', summary: 'Branch and environment ready', entries: [] },
]
const byKey = key => THREADS.find(t => t.key === key)
const kids = t => (t.kids ?? []).map(byKey)
const rollup = t => `${kids(t).filter(k => k.status === 'done').length} of ${kids(t).length}`
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/* ------------------------------------------------------------------ the board */

const keyLinks = html => html.replace(/\{(atlas-\d+)\}/g, '<button class="keylink" data-open="$1">$1</button>')

function whoChip(id) {
  const w = WHO[id]
  if (!w) return ''
  if (w.owner) return '<span class="wt-who">You</span>'
  if (w.peer) {
    const note = w.person ? `Opens ${w.name} in the Team panel` : `Opens ${w.peer} in the Team panel. Another board's session has no card here`
    return `<button class="wt-who peer" data-toast="${esc(note)}">${ic(w.person ? 'people' : 'agent')}${w.name}</button>`
  }
  const where = w.day ? 'the day session in MokuPilot' : `the session's sheet · <code>#session=${w.name}</code>`
  return `<button class="wt-who" data-toast="Opens ${where}"><span class="dot" style="--c:${STATUS[w.col].c}"></span>${w.name}</button>`
}

function wtRow(t, { active = false, inParent = false } = {}) {
  const s = STATUS[t.status]
  const last = t.proposed ? `Says done: ${t.proposed}` : (t.summary ?? '')
  return `<button class="wt-row${active ? ' active' : ''}${t.status === 'done' ? ' done' : ''}" data-open="${t.key}">
    <span class="dot${t.status === 'next' ? ' idle' : ''}" style="--c:${s.c}"></span>
    <span class="wt-row-main">
      <span class="wt-row-top"><code class="wt-key">${t.key}</code><span class="wt-row-title">${t.title}</span>${t.kids ? `<span class="wt-rollup">${rollup(t)}</span>` : ''}<span class="wt-row-when">${t.when}</span></span>
      <span class="wt-row-bottom">${t.who ? whoChipPlain(t.who) : ''}<span class="wt-row-last">${!inParent && t.parent ? `in ${t.parent}${last ? ' · ' : ''}` : ''}${last}</span>${t.shared ? `<span class="wt-who peer">${ic('people')}${t.shared}</span>` : ''}${t.news ? `<span class="team-unread">${t.news}</span>` : ''}</span>
    </span></button>`
}
// Inside a row the whole row is the button, so the chip is drawn and not a button of its own.
function whoChipPlain(id) {
  const w = WHO[id]
  if (w.peer) return `<span class="wt-who peer">${ic(w.person ? 'people' : 'agent')}${w.name}</span>`
  return `<span class="wt-who"><span class="dot" style="--c:${STATUS[w.col].c}"></span>${w.name}</span>`
}

function wtSide(open) {
  const section = (title, status, limit) => {
    const list = THREADS.filter(t => t.status === status)
    if (!list.length) return ''
    const shown = limit ? list.slice(0, limit) : list
    return `<section class="wt-section"><h3>${title}<span class="n">${list.length}</span></h3>${shown.map(t => wtRow(t, { active: t.key === open })).join('')}${
      list.length > shown.length ? `<button class="wt-fold" data-toast="Shows the other ${list.length - shown.length}">and ${list.length - shown.length} more</button>` : ''
    }</section>`
  }
  return `<div class="wt-filter">
      <button class="lanechip" aria-pressed="true" style="--lane:#32ADE6">Atlas</button>
      <span class="search">${ic('search')}<span>Search</span></span>
    </div>
    ${section('Needs you', 'owner')}${section('Doing', 'doing')}${section('Waiting', 'waiting')}${section('Next', 'next')}${section('Done', 'done', 1)}`
}

function wtEntry(e, t) {
  const w = WHO[e.who]
  if (e.t === 'new') return '<div class="team-unread-line">New</div>'
  if (e.t === 'sys') return `<div class="notice"><span class="notice-mark">${ic('plus')}</span><span class="notice-text">${keyLinks(e.text)}</span><span class="when">${e.when}</span></div>`
  if (e.t === 'status') {
    const s = STATUS[e.to]
    const what = e.key ? `set {${e.key}} to` : 'set'
    return `<div class="notice"><span class="notice-mark" style="--c:${s.c}">${ic(e.to === 'done' ? 'check' : e.to === 'waiting' ? 'clock' : 'next')}</span><span class="notice-text">${keyLinks(`<b>${w.name}</b> ${what} <b>${s.label}</b>${e.summary ? `: ${e.summary}` : ''}`)}</span><span class="when">${e.when}</span></div>`
  }
  if (e.t === 'ask') {
    return `<div class="asked"><b>${w.name} asks you</b><p>${e.text}</p>
      <div class="options">${e.options.map(o => `<button class="mini" data-toast="Writes your answer into the thread, sets it back to Doing and types it into ${w.name}">${o}</button>`).join('')}</div></div>`
  }
  const files = (e.files ?? []).map(f => `<button class="fs-chip" data-toast="Opens the file from the board's copy · <code>thread-files/${t.key}/${f.name}</code>">${ic('file')}${f.name} <small>${f.size}</small></button>`).join('')
  const body = e.text.map(p => `<p>${keyLinks(p)}</p>`).join('') + files
  if (w.owner) return `<div class="team-msg out"><div class="team-msg-row"><div class="team-bubble">${body}<span class="team-msg-foot">${e.when}</span></div></div></div>`
  const mark = w.person
    ? `<div class="team-agent-mark">${ic('people', 'team-glyph')}<button data-toast="Opens ${w.name} in the Team panel">${w.name}</button></div>`
    : `<div class="team-agent-mark">${ic('agent', 'team-glyph')}<button data-toast="${w.peer ? `A session on ${w.peer}: opens the peer in the Team panel` : `Opens the session's sheet · <code>#session=${w.name}</code>`}">${w.name}</button>${w.peer ? `<span>${w.peer}</span>` : ''}</div>`
  const held = e.t === 'held'
    ? `<div class="wt-held">${e.why}<span class="spacer"></span><button class="mini" data-toast="Discards the entry's copy for ben. It stays in your thread">Keep local</button><button class="mini primary" data-toast="Sends the entry and its file to ben's board, end to end encrypted">Send</button></div>`
    : ''
  return `<div class="team-msg${w.person ? '' : ' agent'}${held ? ' held' : ''}"><div class="team-msg-row"><div class="team-bubble">${mark}${body}${held}<span class="team-msg-foot">${e.when}</span></div></div></div>`
}

function wtThread(t) {
  const s = STATUS[t.status]
  const parent = t.parent ? `<span class="wt-crumb"><button data-open="${t.parent}">${t.parent}</button>${ic('chev')}</span>` : ''
  const subs = t.kids ? `<div class="wt-subs">${kids(t).map(k => wtRow(k, { inParent: true })).join('')}</div>` : ''
  const proposed = t.proposed
    ? `<div class="wt-proposed"><p><b>${WHO[t.who].name}</b> says this is done: ${t.proposed}</p><button class="mini" data-toast="Stays under Needs you, and the agent is told">Keep open</button><button class="mini primary" data-toast="Sets Done">${ic('check')}Confirm</button></div>`
    : ''
  const feed = t.entries.length
    ? `<div class="team-day"><span>Today</span></div>${t.entries.map(e => wtEntry(e, t)).join('')}`
    : '<div class="wt-empty"><b>No entries yet</b>A thread without a feed is a plain item: a key, a title and a status. The first status change or note starts its history.</div>'
  return `<div class="wt-thread">
    <header class="wt-head">
      <div class="wt-bar">
        <button class="icon-button plain wt-back" data-back aria-label="Back to the list">${ic('back')}</button>
        ${parent}<span class="spacer"></span>
        <button class="icon-button plain" aria-label="Copy the link" data-toast="Copies <code>http://127.0.0.1:&amp;lt;port&amp;gt;/#thread=${t.key}</code>">${ic('link')}</button>
        <button class="icon-button plain" aria-label="More" data-toast="A menu: Share, Move to a lane, Add a sub-thread, Drop">${ic('more')}</button>
      </div>
      <h3 class="wt-title"><code>${t.key}</code>${t.title}</h3>
      <div class="wt-pills">
        <button class="status-pill" style="--c:${s.c}" data-toast="A menu: Next, Doing, Waiting, Needs you, Done"><span class="dot${t.status === 'next' ? ' idle' : ''}" style="--c:${s.c}"></span>${s.label}${ic('updown', 'updown')}</button>
        ${t.who ? whoChip(t.who) : '<button class="wt-who" data-toast="A menu of the lane\'s sessions">Nobody yet</button>'}
        <span class="lane-pill" style="--lane:#32ADE6">Atlas</span>
        ${t.shared ? `<span class="wt-shared">${ic('people')}Shared with ${t.shared}</span>` : ''}
      </div>
      ${t.summary && !t.proposed ? `<p class="wt-summary">${t.summary}</p>` : ''}
      ${proposed}${subs}
    </header>
    <div class="wt-scroll">${feed}</div>
    <div class="wt-foot">
      <div class="wt-compose">
        <button class="icon-button plain" aria-label="Attach">${ic('clip')}</button>
        <span class="field">${t.status === 'owner' && !t.proposed ? 'Answer' : 'Add a note'}</span>
        <button class="team-send" aria-label="Send" data-toast="Your note goes into the thread${t.shared ? ` and to ${t.shared}'s board` : ''}">${ic('send')}</button>
      </div>
    </div>
  </div>`
}

function mountPanel(el) {
  const state = { open: el.dataset.open || null, pane: el.dataset.pane || 'thread' }
  const draw = () => {
    const t = byKey(state.open) ?? THREADS[0]
    const open = THREADS.filter(x => x.status !== 'done').length
    el.innerHTML = `<header class="sheet-head">
        <div class="sheet-title"><h2>Threads</h2><p class="sheet-meta">${open} open · ${THREADS.filter(x => x.status === 'owner').length} need you</p></div>
        <div class="sheet-tools"><button class="icon-button" aria-label="New thread" data-toast="A new thread in the lane shown">${ic('plus')}</button><button class="icon-button" aria-label="Close">${ic('close')}</button></div>
      </header>
      <div class="wt-body" data-pane="${state.pane}"><nav class="wt-side">${wtSide(state.open)}</nav><div class="wt-main">${wtThread(t)}</div></div>`
  }
  el.addEventListener('click', ev => {
    const open = ev.target.closest('[data-open]')
    if (open) { state.open = open.dataset.open; state.pane = 'thread'; draw(); return }
    if (ev.target.closest('[data-back]')) { state.pane = 'list'; draw() }
  })
  draw()
}

const threadChip = (key, toast = 'Opens the thread in the panel') => {
  const t = byKey(key)
  return `<button class="wt-chip" data-toast="${toast} · <code>#thread=${key}</code>"><span class="dot${t.status === 'next' ? ' idle' : ''}" style="--c:${STATUS[t.status].c}"></span>${key}</button>`
}

function mountBoard(el) {
  const colHead = (id, label, c, n) => `<div class="col-head"><span class="dot${id === 'idle' ? ' idle' : ''}" style="--c:${c}"></span><span>${label}</span><span class="n">${n}</span></div>`
  const colLabel = (label, c, idle) => `<div class="col-label"><span class="dot${idle ? ' idle' : ''}" style="--c:${c}"></span>${label}</div>`
  el.innerHTML = `<div class="page">
    <header class="toolbar">
      <div class="toolbar-row">
        <p class="summary"><b>2</b> need you · 2 working · 1 waiting</p>
        <div class="toolbar-filters">
          <div class="segmented"><button aria-pressed="true">All<span class="n">6</span></button><button>Atlas<span class="n">5</span></button><button>Personal<span class="n">1</span></button></div>
          <span class="search">${ic('search')}<span>Search</span></span>
        </div>
        <div class="toolbar-actions">
          <button class="pill-toggle">${ic('next')}<span>Next</span></button>
          <button class="pill-toggle">${ic('tasks')}<span>Tasks</span><span class="n">3</span></button>
          <button class="pill-toggle due on" data-toast="Opens the threads panel. The count is the threads that need you">${ic('threads')}<span>Threads</span><span class="n">2</span></button>
          <button class="pill-toggle unread">${ic('team')}<span>Team</span><span class="n">1</span></button>
          <button class="pill-toggle icon-only" aria-label="Settings">${ic('gear')}</button>
          <span class="live"></span>
        </div>
      </div>
      <div class="columns-head">
        ${colHead('work', 'Working', 'var(--green)', 2)}${colHead('me', 'Needs you', 'var(--orange)', 1)}${colHead('ext', 'Waiting', 'var(--purple)', 1)}${colHead('done', 'Done', 'var(--blue)', 1)}${colHead('idle', 'Idle', 'var(--gray)', 1)}
      </div>
    </header>
    <main class="board">
      <section class="lane" style="--lane:#32ADE6">
        <div class="lane-bar"><span class="lane-tag">Atlas</span><span class="lane-count">5</span></div>
        <div class="lane-grid">
          <div class="col has-cards">${colLabel('Working', 'var(--green)')}
            <article class="card"><div class="card-top"><span class="dot work" style="--c:var(--green)"></span><span class="name">atlas-master</span><span class="age">4m</span></div>
              <div class="what">Coordinating the order feed import</div>
              <div class="now"><span class="tool">Bash</span><span class="detail">board thread changes</span></div>
              <div class="wt-chips">${threadChip('atlas-12')}${threadChip('atlas-10')}<button class="wt-chip more" data-toast="Lists the session's other threads">+2</button></div></article>
          </div>
          <div class="col has-cards">${colLabel('Needs you', 'var(--orange)')}
            <article class="card" data-col="me"><div class="card-top"><span class="dot" style="--c:var(--orange)"></span><span class="name">atlas-mapper</span><span class="age">3m</span></div>
              <div class="what">Mapping the 2019 price columns</div>
              <div class="ask"><b>Asks:</b> Which price list wins when both have a row?</div>
              <div class="wt-chips">${threadChip('atlas-13')}</div></article>
          </div>
          <div class="col has-cards">${colLabel('Waiting', 'var(--purple)')}
            <article class="card"><div class="card-top"><span class="dot" style="--c:var(--purple)"></span><span class="name">atlas-ops</span><span class="age">2h</span></div>
              <div class="what">Refreshing the staging database</div>
              <div class="chip">${ic('clock')}<span>the nightly snapshot, 02:00</span></div>
              <div class="wt-chips">${threadChip('atlas-9')}</div></article>
          </div>
          <div class="col has-cards">${colLabel('Done', 'var(--blue)')}
            <article class="card"><div class="card-top"><span class="dot" style="--c:var(--blue)"></span><span class="name">atlas-check</span><span class="age">1h</span></div>
              <div class="what">Totals validated against the March export</div>
              <div class="said">All 1,204 totals match to the cent. The check is in the thread.</div>
              <div class="wt-chips">${threadChip('atlas-14')}</div></article>
          </div>
          <div class="col has-cards">${colLabel('Idle', 'var(--gray)', true)}
            <article class="card compact"><div class="card-top">${ic('moon', 'moon')}<span class="name">atlas-notes</span><span class="age">1d</span></div></article>
          </div>
        </div>
      </section>
    </main>
  </div>`
}

/* ------------------------------------------------------------------ MokuPilot */

const MP_GLYPH = {
  owner: '<circle cx="7.5" cy="7.5" r="6" stroke-width="1.6"/><circle cx="7.5" cy="7.5" r="2.4" fill="currentColor" stroke="none"/>',
  doing: '<circle cx="7.5" cy="7.5" r="6" stroke-width="1.8" stroke-dasharray="24 14"/>',
  handed: '<circle cx="7.5" cy="7.5" r="6" stroke-width="1.6"/><path d="M5.6 9.4 9.4 5.6M6.4 5.6h3v3" stroke-width="1.5"/>',
  waiting: '<circle cx="7.5" cy="7.5" r="6" stroke-width="1.6"/><path d="M7.5 4.6v3l1.9 1.4" stroke-width="1.5"/>',
  next: '<circle cx="7.5" cy="7.5" r="6" stroke-width="1.6"/>',
  done: '<circle cx="7.5" cy="7.5" r="6.8" fill="currentColor" stroke="none"/><path d="m4.6 7.8 2 2 3.8-4.2" style="stroke:#fff" stroke-width="1.7"/>',
}
const mpKind = t => (t.status === 'doing' && t.who && t.who !== 'moku' ? 'handed' : t.status)
const mpGlyph = t => {
  const kind = mpKind(t)
  return `<svg class="mp-glyph" viewBox="0 0 15 15" style="color:${STATUS[t.status].mp}" aria-hidden="true">${MP_GLYPH[kind]}</svg>`
}
function mpOwner(id) {
  const w = WHO[id]
  if (!w || w.day) return ''
  const c = w.peer ? 'var(--mp-wait)' : STATUS[w.col].mp
  const note = w.peer ? `Opens ${w.peer === 'ben' ? 'ben' : w.peer} in the board's Team panel` : `Opens ${w.name}'s sheet on the board · <code>#session=${w.name}</code>`
  return `<button class="mp-owner" data-toast="${esc(note)}"><i style="--c:${c}"></i>${w.name}${w.peer && !w.person ? ` · ${w.peer}` : ''}${ic('out')}</button>`
}

function mpRow(t, { child = false } = {}) {
  const note = t.proposed ? `<span class="mp-note warn">Says done: ${t.proposed}</span>` : t.summary ? `<span class="mp-note${t.status === 'owner' ? ' warn' : ''}">${t.summary}</span>` : ''
  const owner = mpKind(t) !== 'doing' && mpKind(t) !== 'next' && t.who && !WHO[t.who].day ? mpOwner(t.who) : ''
  const line2 = owner || (!child && t.parent) ? `<span class="mp-line2">${owner}${!child && t.parent ? `<span>in ${t.parent}</span>` : ''}</span>` : ''
  return `<div class="mp-row${t.kids ? ' parent' : ''}${child ? ' child' : ''}${t.status === 'done' ? ' done' : ''}" data-open="${t.key}" role="button" tabindex="0">
    ${mpGlyph(t)}
    <span class="mp-row-main"><span class="mp-row-title"><span class="mp-key">${t.key}</span><span class="t">${t.title}</span></span>${note}${line2}</span>
    <span class="mp-meta">${t.kids ? `${rollup(t)} · ` : ''}${t.when}${t.news ? `<span class="mp-new">${t.news}</span>` : ''}</span>
  </div>`
}

function mpList() {
  const section = (title, list, limit) => {
    if (!list.length) return ''
    const shown = limit ? list.slice(0, limit) : list
    return `<section><p class="mp-cap">${title}<span class="n">${list.length}</span></p><div class="mp-card">${shown.map(t => mpRow(t)).join('')}${
      list.length > shown.length ? `<button class="mp-more" data-toast="Shows the other ${list.length - shown.length}">${list.length - shown.length} more</button>` : ''
    }</div></section>`
  }
  const of = kind => THREADS.filter(t => mpKind(t) === kind)
  return section('Needs you', of('owner')) + section('Now', of('doing')) + section('Handed off', of('handed')) + section('Waiting', of('waiting')) + section('Next', of('next')) + section('Done', of('done'), 1)
}

function mpEntry(e, t) {
  const w = WHO[e.who]
  if (e.t === 'new') return ''
  if (e.t === 'sys') return `<div class="mp-ev"><i></i><span>${keyLinks(e.text)}</span><time>${e.when}</time></div>`
  if (e.t === 'status') {
    const s = STATUS[e.to]
    return `<div class="mp-ev"><i style="--c:${s.mp}"></i><span>${keyLinks(`<b>${w.name}</b> ${e.key ? `set {${e.key}} to` : 'set'} <b>${s.label}</b>${e.summary ? `: ${e.summary}` : ''}`)}</span><time>${e.when}</time></div>`
  }
  if (e.t === 'ask') {
    return `<div class="mp-ask"><b>${w.name} asks you</b><p>${e.text}</p><div class="options">${e.options.map(o => `<button class="mp-btn" data-toast="Your answer goes into the thread and into ${w.name}">${o}</button>`).join('')}</div></div>`
  }
  const files = (e.files ?? []).map(f => `<button class="mp-file" data-toast="Opens the file from the board's copy">${ic('file')}${f.name} · ${f.size}</button>`).join('')
  const held = e.t === 'held' ? `<p style="color:var(--mp-t3)">${e.why}. <button class="keylink plain" data-toast="Opens the thread on the board, where you send or keep it">Open on the board</button></p>` : ''
  return `<article class="mp-entry${e.t === 'held' ? ' held' : ''}"><header>${w.owner ? '<b>You</b>' : mpOwner(e.who)}<time>${e.when}</time></header>${e.text.map(p => `<p>${keyLinks(p)}</p>`).join('')}${files}${held}</article>`
}

function mpThread(t) {
  const s = STATUS[t.status]
  const subs = t.kids ? `<section><p class="mp-cap">Sub-threads<span class="n">${rollup(t)}</span></p><div class="mp-card">${kids(t).map(k => mpRow(k, { child: false })).join('')}</div></section>` : ''
  const proposed = t.proposed
    ? `<div class="mp-ask"><b>${WHO[t.who].name} says this is done</b><p>${t.proposed}</p><div class="options"><button class="mp-btn" data-toast="Stays under Needs you">Keep open</button><button class="mp-btn primary" data-toast="Sets Done">Confirm</button></div></div>`
    : ''
  const feed = t.entries.length
    ? `<section><p class="mp-cap">Feed</p><div class="mp-feedlist">${t.entries.map(e => mpEntry(e, t)).join('')}</div></section>`
    : '<p class="mp-empty">No entries yet. A thread without a feed is the plain item it was on the old board.</p>'
  return `<div class="mp-thead">
      <button class="mp-back" data-back>${ic('back')}Threads</button>
      <h3><code>${t.key}</code>${t.title}</h3>
      <div class="mp-pills">
        <button class="mp-status" style="--c:${s.mp}" data-toast="A menu: Next, Doing, Waiting, Needs you, Done">${s.label}${ic('updown')}</button>
        ${t.who ? mpOwner(t.who) : ''}
        ${t.parent ? `<button class="mp-link" data-open="${t.parent}">in ${t.parent}</button>` : ''}
        ${t.shared ? `<span class="mp-link">${ic('people')}shared with ${t.shared}</span>` : ''}
        <button class="mp-link" data-toast="Opens <code>#thread=${t.key}</code> in the board's window">${ic('out')}Board</button>
      </div>
      ${t.summary && !t.proposed ? `<p class="sum">${t.summary}</p>` : ''}
    </div>${proposed}${subs}${feed}`
}

function mountMokupilot(el) {
  const narrow = el.classList.contains('narrow')
  const state = { open: el.dataset.open || null, dir: '' }
  const chat = `<div class="mp-chat">
      <div class="mp-feed">
        <div class="mp-msg you">Hand the order feed import to a master and keep me posted.</div>
        <div class="mp-msg moku"><span class="who">Moku</span>Done. It is <button class="keylink" data-open="atlas-12">atlas-12</button>, with atlas-master. Its parts report into their threads, and I hear when one closes or needs you.</div>
        <div class="mp-report">${ic('threads')}<span><button class="keylink" data-open="atlas-14">atlas-14</button> done: All 1,204 totals match <small>· 12:48</small></span></div>
        <div class="mp-report">${ic('threads')}<span><button class="keylink" data-open="atlas-13">atlas-13</button> needs the owner: Which price list wins when both have a row? · <button class="keylink" data-open="atlas-16">atlas-16</button> +1 <small>· 14:02</small></span></div>
        <div class="mp-msg you">What is left on the order feed before the 15:00 sync?</div>
        <div class="mp-msg moku"><span class="who">Moku</span>Three parts under <button class="keylink" data-open="atlas-12">atlas-12</button>. The totals are validated. The price columns (<button class="keylink" data-open="atlas-13">atlas-13</button>) wait on you: which price list wins when both have a row. The load into staging starts after that.</div>
      </div>
      <div class="mp-composer">
        <span class="mp-selected">${ic('threads')}atlas-13 · Map the 2019 price columns</span>
        <div class="mp-input"><span class="field">Message Moku</span><span class="send">${ic('send')}</span></div>
      </div>
    </div>`
  const draw = () => {
    const t = byKey(state.open)
    el.innerHTML = `<div class="mp-titlebar"><span class="rec"></span><b>Today</b><span>Thu 12 Nov · day mode</span><span class="spacer"></span><button class="mp-ib" aria-label="Settings">${ic('gear')}</button></div>
      <div class="mp-split">${narrow ? '' : chat}
        <aside class="mp-inspector">
          <div class="mp-tabs"><div class="mp-seg"><button aria-pressed="true">Threads</button><button>Transcript</button></div><span class="spacer"></span>
            <button class="mp-scope" data-toast="Today, a lane, or everything open">Today${ic('down')}</button></div>
          <div class="mp-pane ${state.dir}">${t ? mpThread(t) : mpList()}</div>
          ${t ? `<div class="mp-tfoot"><div class="mp-input"><span class="field">${t.status === 'owner' && !t.proposed ? 'Answer' : 'Add a note'}</span><span class="send">${ic('send')}</span></div></div>` : ''}
        </aside>
      </div>`
  }
  el.addEventListener('click', ev => {
    if (ev.target.closest('[data-toast]')) return
    const open = ev.target.closest('[data-open]')
    if (open) { state.open = open.dataset.open; state.dir = 'in'; draw(); return }
    if (ev.target.closest('[data-back]')) { state.open = null; state.dir = 'back'; draw() }
  })
  draw()
}

/* ------------------------------------------------------------------ the page */

function toast(from, html) {
  const host = from.closest('.frame, .mp')
  if (!host) return
  host.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = 'toast'
  el.innerHTML = html
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
  host.append(el)
  setTimeout(() => el.remove(), 3200)
}

function start() {
  const main = document.querySelector('.mock-main')
  const root = document.documentElement
  for (const el of document.querySelectorAll('[data-mount="board"]')) mountBoard(el)
  for (const el of document.querySelectorAll('[data-mount="panel"]')) mountPanel(el)
  for (const el of document.querySelectorAll('[data-mount="mokupilot"]')) mountMokupilot(el)

  document.addEventListener('click', ev => {
    const t = ev.target.closest('[data-toast]')
    if (t) toast(t, t.dataset.toast)
  })

  // ?theme=dark&width=phone set the start state when the page is opened as a file.
  const asked = new URLSearchParams(location.search)
  const state = {
    view: location.hash === '#mokupilot' ? 'mokupilot' : 'board',
    width: asked.get('width') ?? (window.innerWidth < 820 ? 'phone' : 'desktop'),
    theme: asked.get('theme') ?? 'auto',
  }
  const apply = () => {
    main.dataset.view = state.view
    main.dataset.width = state.width
    if (state.theme === 'auto') delete root.dataset.theme
    else root.dataset.theme = state.theme
    for (const group of document.querySelectorAll('.mock-bar [data-set]')) {
      for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === state[group.dataset.set]))
    }
  }
  for (const group of document.querySelectorAll('.mock-bar [data-set]')) {
    group.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-v]')
      if (!b) return
      state[group.dataset.set] = b.dataset.v
      if (group.dataset.set === 'view') history.replaceState(null, '', `#${state.view}`)
      apply()
    })
  }
  window.addEventListener('hashchange', () => {
    state.view = location.hash === '#mokupilot' ? 'mokupilot' : 'board'
    apply()
  })
  apply()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
else start()
