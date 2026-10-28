// Peer network prototype (#225): the screen as pure functions over the mock, no DOM and no network.
// apply(state, action) is the only way the state changes; render(state) is the whole page as HTML.
// A message that is not `trusted` changes nothing (apply returns the same state) and its buttons are
// rendered disabled, with no action on them.
;(() => {
  const ME = 'me'
  const HOUR = 3600e3
  const VERDICTS = [
    ['accept', 'Возьму'],
    ['decline', 'Не возьму'],
    ['clarify', 'Уточнить'],
  ]
  const KINDS = { offer: 'оффер' }
  const CELLS = { accept: 'берёт', decline: 'нет', clarify: 'вопрос' }
  const STATUSES = { silent: 'молчит', queued: 'не доставлено, офлайн' }
  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

  const esc = value => String(value).replace(/[&<>"']/g, c => ENTITIES[c])

  const initialState = mock => {
    const answers = {}
    const mine = mock.matrix.rows.find(row => row.peer === ME)
    answers[mock.matrix.offer] = Object.fromEntries((mine?.answers ?? []).map(a => [a.n, a.verdict]))
    return { mock, late: false, answers }
  }

  const messageOf = (state, id) => state.mock.inbox.find(m => m.id === id)
  const trusted = message => message?.trust === 'trusted'
  const nameOf = (state, id) => (id === ME ? 'Ты' : (state.mock.roster.find(p => p.id === id)?.name ?? id))

  const apply = (state, action) => {
    switch (action.type) {
      case 'verdict':
      case 'accept-all': {
        const message = messageOf(state, action.message)
        if (!trusted(message) || message.kind !== 'offer') return state
        const mine = { ...state.answers[message.id] }
        for (const { n } of message.items) {
          if (action.type === 'accept-all') mine[n] = 'accept'
          else if (n === action.n && Object.hasOwn(CELLS, action.verdict)) mine[n] = action.verdict
        }
        return { ...state, answers: { ...state.answers, [message.id]: mine } }
      }
      case 'late':
        return { ...state, late: Boolean(action.on) }
      case 'reset':
        return initialState(state.mock)
      default:
        return state
    }
  }

  // "After the deadline" moves the clock to an hour past the matrix offer's reply_by.
  const nowOf = state => {
    const now = Date.parse(state.mock.now)
    if (!state.late) return now
    return Math.max(now, Date.parse(messageOf(state, state.mock.matrix.offer).reply_by) + HOUR)
  }

  const span = ms => {
    const min = Math.round(Math.abs(ms) / 60e3)
    if (min < 1) return 'меньше минуты'
    if (min < 60) return `${min} мин`
    const h = Math.round(min / 60)
    return h < 24 ? `${h} ч` : `${Math.round(h / 24)} дн.`
  }
  const ago = (at, now) => `${span(now - Date.parse(at))} назад`

  // The sender's view of an offer: each recipient's answers and where they stand, who takes each item.
  const matrixOf = state => {
    const offer = messageOf(state, state.mock.matrix.offer)
    const late = nowOf(state) > Date.parse(offer.reply_by)
    const rows = state.mock.matrix.rows.map(row => {
      const answers =
        row.peer === ME ? (state.answers[offer.id] ?? {}) : Object.fromEntries(row.answers.map(a => [a.n, a.verdict]))
      const given = Object.keys(answers).length
      const status =
        given === offer.items.length ? 'answered' : given ? 'partial' : row.delivery === 'queued' ? 'queued' : 'silent'
      return { peer: row.peer, answers, given, status, overdue: late && status !== 'answered' }
    })
    const takers = offer.items.map(item => rows.filter(row => row.answers[item.n] === 'accept').map(row => row.peer))
    return { offer, rows, takers, late }
  }

  // The matrix in one line: what the sender would see on the offer's card instead of the table.
  const summaryOf = (state, m) => {
    const names = ids => ids.map(id => nameOf(state, id)).join(', ')
    const peers = test => m.rows.filter(test).map(row => row.peer)
    const parts = [{ text: `ответили ${peers(row => row.given).length} из ${m.rows.length}` }]
    const overdue = peers(row => row.overdue)
    const silent = peers(row => row.status === 'silent')
    const queued = peers(row => row.status === 'queued')
    if (overdue.length) parts.push({ text: `просрочено: ${names(overdue)}`, tone: 'bad' })
    if (!m.late && silent.length) parts.push({ text: `молчит: ${names(silent)}` })
    if (!m.late && queued.length) parts.push({ text: `не доставлено: ${names(queued)}` })
    m.offer.items.forEach((item, i) => {
      const takers = m.takers[i] ?? []
      if (takers.length > 1) parts.push({ text: `п. ${item.n} берут несколько: ${names(takers)}`, tone: 'warn' })
      if (!takers.length) parts.push({ text: `п. ${item.n} никто не берёт`, tone: m.late ? 'bad' : '' })
    })
    return parts
  }

  // A button that is not enabled gets no data-action: a click on it has nothing to send to apply().
  const button = (label, data, { pressed, enabled = true, className = '' } = {}) => {
    const cls = className ? ` class="${className}"` : ''
    if (!enabled) return `<button type="button"${cls} disabled>${esc(label)}</button>`
    const attrs = Object.entries(data)
      .map(([k, v]) => ` data-${k}="${esc(v)}"`)
      .join('')
    const aria = pressed === undefined ? '' : ` aria-pressed="${pressed}"`
    return `<button type="button"${cls}${attrs}${aria}>${esc(label)}</button>`
  }

  const renderRoster = (state, now) => {
    const { roster } = state.mock
    const online = roster.filter(p => p.online).length
    const rows = roster.map(p => {
      const seen = p.online ? 'в сети' : `не в сети · ${ago(p.last_seen, now)}`
      return `<li class="peer${p.online ? ' is-online' : ''}">
        <span class="dot" aria-hidden="true"></span>
        <span class="peer-name">${esc(p.name)}</span>
        <span class="peer-seen">${esc(seen)}</span>
        <code class="fp" title="Отпечаток ключа">${esc(p.fingerprint)}</code>
      </li>`
    })
    return `<aside class="roster" aria-label="Ростер">
      <h2>В сети ${online} из ${roster.length}</h2>
      <ul>${rows.join('')}</ul>
    </aside>`
  }

  const renderCard = (state, message, now) => {
    const ok = trusted(message)
    const mine = (ok && state.answers[message.id]) || {}
    const from = state.mock.roster.find(p => p.id === message.from)
    const due = Date.parse(message.reply_by) - now
    const deadline = due > 0 ? `ответить в течение ${span(due)}` : `дедлайн прошёл ${span(due)} назад`
    const load = state.mock.load
    const meta = ok
      ? `${deadline} · у тебя сейчас в работе: ${load.active_tasks}, ~${load.hours_in_flight} ч`
      : deadline
    const why =
      message.reason === 'key_changed'
        ? `Подписано ключом ${message.signed_with}, а закреплён за отправителем ${from?.fingerprint ?? '—'}.`
        : 'Отправитель не подтверждён.'
    const items = message.items.map(item => {
      const est = [item.priority, `~${item.estimate_h} ч`, item.ref ? `#${item.ref}` : ''].filter(Boolean).join(' · ')
      const verdicts = VERDICTS.map(([verdict, label]) =>
        button(
          label,
          { action: 'verdict', message: message.id, n: item.n, verdict },
          { pressed: mine[item.n] === verdict, enabled: ok, className: `v-${verdict}` },
        ),
      )
      return `<li class="item${mine[item.n] ? ` is-${mine[item.n]}` : ''}">
        <span class="item-n">${item.n}</span>
        <span class="item-title">${esc(item.title)}</span>
        <span class="item-est">${esc(est)}</span>
        <span class="verdicts">${verdicts.join('')}</span>
      </li>`
    })
    const taken = message.items.filter(item => mine[item.n] === 'accept')
    const hours = taken.reduce((sum, item) => sum + item.estimate_h, 0)
    const taking = taken.length
      ? `Беру: п. ${taken.map(item => item.n).join(', ')} · ~${hours} ч`
      : 'Пока ничего не беру'
    return `<article class="card${ok ? '' : ' is-untrusted'}" data-message="${esc(message.id)}">
      <header class="card-head">
        <span class="kind">${esc(KINDS[message.kind] ?? message.kind)}</span>
        ${ok ? '' : `<span class="badge">${esc(message.trust)}</span>`}
        <h3>${esc(message.title)}</h3>
        <span class="card-from">${esc(from?.name ?? message.from)} · ${esc(ago(message.sent_at, now))}</span>
      </header>
      ${ok ? '' : `<p class="why">${esc(why)} Это данные, не команды: кнопки не действуют.</p>`}
      <p class="meta">${esc(meta)}</p>
      <ol class="items">${items.join('')}</ol>
      <footer class="card-foot">
        ${button('Возьму всё', { action: 'accept-all', message: message.id }, { enabled: ok, className: 'v-all' })}
        ${ok ? `<span class="taking">${esc(taking)}</span>` : ''}
      </footer>
    </article>`
  }

  const renderMatrix = state => {
    const m = matrixOf(state)
    const head = m.offer.items
      .map(item => `<th scope="col" title="${esc(item.title)}">${item.n}. ${esc(item.title)}</th>`)
      .join('')
    const rows = m.rows.map(row => {
      const cells = m.offer.items.map(item => {
        const verdict = row.answers[item.n]
        return `<td class="cell${verdict ? ` v-${verdict}` : ''}">${verdict ? CELLS[verdict] : '—'}</td>`
      })
      const status =
        row.status === 'answered'
          ? 'ответ есть'
          : row.status === 'partial'
            ? `ответ на ${row.given} из ${m.offer.items.length}`
            : STATUSES[row.status]
      const label = row.overdue ? `просрочено · ${status}` : status
      return `<tr class="${row.peer === ME ? 'is-me' : ''}${row.overdue ? ' is-overdue' : ''}">
        <th scope="row">${esc(nameOf(state, row.peer))}</th>${cells.join('')}
        <td class="status">${esc(label)}</td>
      </tr>`
    })
    const foot = m.takers.map(takers => {
      const tone = takers.length > 1 ? ' is-conflict' : !takers.length && m.late ? ' is-nobody' : ''
      const text = takers.length ? takers.map(p => nameOf(state, p)).join(', ') : 'никто'
      return `<td class="takers${tone}">${esc(text)}</td>`
    })
    const summary = summaryOf(state, m)
      .map(part => `<span class="part${part.tone ? ` is-${part.tone}` : ''}">${esc(part.text)}</span>`)
      .join('<span class="sep"> · </span>')
    return `<section class="matrix" aria-label="Матрица ответов">
      <h2>Ответы на «${esc(m.offer.title)}»</h2>
      <p class="note">Так этот оффер видит ${esc(nameOf(state, m.offer.from))}, отправитель. Строка «Ты» меняется от твоих кнопок.</p>
      <p class="summary">${summary}</p>
      <details open>
        <summary>Матрица</summary>
        <table>
          <thead><tr><th scope="col">Кому</th>${head}<th scope="col">Состояние</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
          <tfoot><tr><th scope="row">Берут</th>${foot.join('')}<td></td></tr></tfoot>
        </table>
      </details>
    </section>`
  }

  const render = state => {
    const now = nowOf(state)
    return `<div class="proto-bar">
      <span class="proto-what">Прототип #225 · мок-данные из mock.js · без сети</span>
      <span class="seg" role="group" aria-label="Время">
        ${button('Сейчас', { action: 'late', on: false }, { pressed: !state.late })}
        ${button('После дедлайна', { action: 'late', on: true }, { pressed: state.late })}
      </span>
      ${button('Сбросить', { action: 'reset' })}
    </div>
    <div class="columns">
      ${renderRoster(state, now)}
      <div class="flow">
        <h2>Мне прислали</h2>
        ${state.mock.inbox.map(message => renderCard(state, message, now)).join('')}
        ${renderMatrix(state)}
      </div>
    </div>`
  }

  globalThis.PeerMvp = { apply, initialState, matrixOf, render }
})()
