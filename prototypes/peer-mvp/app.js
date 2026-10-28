// Peer network prototype (#225): wires peer.js to the page. One state in memory; every click on a
// button with a data-action goes through apply() and the page is drawn again. Nothing is stored or sent.
;(() => {
  const { apply, initialState, render } = globalThis.PeerMvp
  const root = document.getElementById('app')
  let state = initialState(globalThis.PEER_MOCK)

  const paint = () => {
    root.innerHTML = render(state)
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('button[data-action]')
    if (!target || target.disabled) return
    const { action, message, n, verdict, on } = target.dataset
    state = apply(state, { type: action, message, n: Number(n), verdict, on: on === 'true' })
    paint()
  })

  paint()
})()
