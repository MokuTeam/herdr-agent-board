// Which menu a right click, a long press or the menu key opens on the board, and what its items
// do. Cards, lanes, the board's empty space, the open session's head, starting sessions and
// file chips get the board's own menu; fields, selected text and links keep the browser's, and
// Shift+right click always gives the browser's (copy, paste, the inspector). Which menu and what
// its items do is src/models/board-menus.ts; here are the listeners that open it.
import { isMenuKey, keepsNativeMenu, keyPoint, LONG_PRESS_MS, menuFor as boardMenuFor, pressOpensMenu, SLOP, typingIn } from './src/models/board-menus.ts'

/**
 * board: what the page knows and can do (app.js): t(), menu, canMutate(), canEdit(), item(key),
 * column(it), category(it), state(), launch (launch.js), and do: { open, focus, write, wake,
 * sleep, rename, move, dismiss, clear, changes, history, newSession, cats, filter, sleepers,
 * search, copy, openPath, look, focusLaunch }.
 */
export function initBoardMenus(board) {
  const { menu } = board
  let keyAt = -1e9
  let pressAt = -1e9
  let swallowUntil = 0

  /** The menu for whatever is under `target`, or null when the browser's own should show. */
  const menuFor = (target, at) => boardMenuFor(target, at, board)

  function show(target, at, source) {
    const m = menuFor(target, at)
    if (!m) return false
    menu.open(m.items, { x: at.x, y: at.y, source, label: m.label, onPick: m.pick, origin: document.activeElement })
    return true
  }

  /** Text the user selected, under the pointer: the browser's menu copies it. */
  function inSelection(target) {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false
    return sel.getRangeAt(0).intersectsNode(target)
  }

  document.addEventListener('contextmenu', e => {
    const now = performance.now()
    // The menu key and a long press open ours themselves; the browser's that follows them must
    // not. A touch that was no long press of ours (text, the toolbar) keeps the browser's.
    if (e.pointerType === 'touch') return void (now - pressAt < 1500 && e.preventDefault())
    if (e.button !== 2 && now - keyAt < 1500) return void e.preventDefault() // the key's own event: button -1
    const el = e.target instanceof Element ? e.target : e.target.parentElement
    if (keepsNativeMenu(el, { shift: e.shiftKey, inSelection: inSelection(e.target) })) return
    if (show(e.target, { x: e.clientX, y: e.clientY }, 'mouse')) e.preventDefault()
  })

  // The menu key and Shift+F10: the menu of what has the focus, under it.
  addEventListener('keydown', e => {
    if (!isMenuKey(e) || menu.isOpen()) return
    const el = document.activeElement
    if (typingIn(el)) return
    const focused = !!el && el !== document.body
    const target = focused ? el : document.querySelector('#board')
    const at = keyPoint(target.getBoundingClientRect(), focused)
    if (show(target, at, 'keyboard')) {
      e.preventDefault()
      keyAt = performance.now()
    }
  })

  // Touch: a long press opens the menu where the finger is, unless the finger moved (a scroll)
  // or lifted first. The tap it ends in does not also open the card.
  let press = null
  addEventListener(
    'pointerdown',
    e => {
      if (e.pointerType !== 'touch' || !e.isPrimary) return
      const el = e.target instanceof Element ? e.target : null
      if (!el || !pressOpensMenu(el)) return
      clearTimeout(press?.timer)
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        target: el,
        timer: setTimeout(() => {
          const p = press
          press = null
          if (!p) return
          if (show(p.target, { x: p.x, y: p.y }, 'touch')) {
            pressAt = performance.now()
            swallowUntil = pressAt + 900
            getSelection()?.removeAllRanges()
            navigator.vibrate?.(8)
          }
        }, LONG_PRESS_MS),
      }
    },
    true,
  )
  const cancel = e => {
    if (!press || (e.pointerId !== undefined && e.pointerId !== press.id)) return
    if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < SLOP) return
    clearTimeout(press.timer)
    press = null
  }
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) addEventListener(type, cancel, true)
  addEventListener('scroll', () => press && cancel({ type: 'scroll' }), true)
  addEventListener(
    'click',
    e => {
      if (performance.now() > swallowUntil) return
      swallowUntil = 0
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    true,
  )

  return { menuFor }
}
