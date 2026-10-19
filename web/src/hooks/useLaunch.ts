// New sessions on the page (the old page's launch.js as app.js used it): the window that starts
// one (components/launch/launch-window.ts, drawn by LaunchDialog.tsx), and the cards of sessions
// on their way — what the board draws for them and what their buttons and menus do. Retry on a
// session back from the archive is its Return once more (`onResume`, hooks/useArchive.ts).
import { createElement, createRef, type ReactNode, useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Item, LaunchView, Translator } from '../../../src/core/types.ts'
import { focusLaunch, type LaunchApi, launchApi } from '../api/launch.ts'
import type { LaunchSlots } from '../components/Card.tsx'
import { LaunchCard, type LaunchLook, LaunchNote } from '../components/launch/LaunchCard.tsx'
import type { LaunchRefs } from '../components/launch/LaunchDialog.tsx'
import { type LaunchWindow, launchWindow } from '../components/launch/launch-window.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import type { LaunchMenus, MenuOrigin } from '../models/board-menus.ts'
import { launchOf } from '../models/card.ts'
import { launcherName } from '../models/launch.ts'
import { pickShowing } from '../models/profiles.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { storage } from '../state/storage.ts'
import { useStore } from '../state/store.ts'
import { launchesOnTheirWay } from './useBoardView.ts'
import { useLatest } from './useLatest.ts'
import { useModalFocus } from './useModalFocus.ts'
import type { OpenLaunch } from './useNewSession.ts'

/** A pressed trust or close button stays off while its launch is as it was (`what:id` -> the launch then). */
export type Pressed = ReadonlyMap<string, string>

const pressedKey = (what: string, id: string) => `${what}:${id}`
/** The launch as its card shows it: a change draws the card anew, and its buttons are on again. */
const asShown = (l: LaunchView) => JSON.stringify(l)

export const isPressed = (pressed: Pressed, what: string, l: LaunchView): boolean =>
  pressed.get(pressedKey(what, l.id)) === asShown(l)

export interface CardDeps {
  t(): Translator
  canMutate(): boolean
  toast(text: string, error?: boolean): void
  api: Pick<LaunchApi, 'dismiss' | 'trust' | 'closeTab'>
  /** The server's launches, and the page's own until the server has them. */
  launches(): LaunchView[]
  local(): readonly LaunchView[]
  /** The page forgets one of its own. */
  forget(id: string): void
  retry(l: LaunchView, el: MenuOrigin | null): void
  /** A trust or close button pressed (null: let go). */
  press(key: string, shown: string | null): void
}

/** What a launch's buttons and menu items do. */
export type LaunchCards = ReturnType<typeof launchCards>

export function launchCards(deps: CardDeps) {
  const t = () => deps.t()
  const find = (id: string) => deps.launches().find(x => x.id === id) ?? deps.local().find(x => x.id === id)

  /** The folder-trust dialog, answered from the card: the server checks the screen before any key. */
  async function trust(id: string, button: Element | null = null): Promise<void> {
    const key = pressedKey('trust', id)
    const l = find(id)
    if (button && l) deps.press(key, asShown(l))
    const r = await deps.api.trust(id, t())
    if (!r.ok) {
      deps.press(key, null)
      deps.toast(r.error, true)
    }
  }

  async function closeTab(id: string, button: Element | null = null): Promise<void> {
    const key = pressedKey('closeTab', id)
    const l = find(id)
    if (button && l) deps.press(key, asShown(l))
    const r = await deps.api.closeTab(id, t())
    if (r.ok) deps.toast(t()('launch.trust.closed'))
    else {
      deps.press(key, null)
      deps.toast(r.error, true)
    }
  }

  async function dismiss(id: string): Promise<void> {
    deps.forget(id)
    const r = await deps.api.dismiss(id, t())
    if (!r.ok && r.error) deps.toast(r.error, true)
  }

  return {
    trust,
    closeTab,
    dismiss,
    /** A click on a card: true when it was one of a launch's buttons (`data-launch`). */
    onAction(target: unknown): boolean {
      const b = target instanceof Element ? target.closest<HTMLElement>('[data-launch]') : null
      if (!b) return false
      const id = b.dataset.id ?? ''
      const l = find(id)
      const what = b.dataset.launch
      if (what === 'dismiss') void dismiss(id)
      else if (what === 'retry' && l) deps.retry(l, b)
      else if (what === 'focus') void focusLaunch(id, { t: t(), canMutate: deps.canMutate(), toast: deps.toast })
      else if (what === 'trust') void trust(id, b)
      else if (what === 'closeTab') void closeTab(id, b)
      return true
    },
  }
}

export interface Launch {
  dialog: LaunchWindow
  refs: LaunchRefs
  /** The window, grown out of `from` (an element, or where a menu was opened). */
  open: OpenLaunch
  /** It is open (not folding away): for the Back button's layers. */
  shown: boolean
  isOpen(): boolean
  close(): void
  /** What the board draws for sessions on their way, and their clicks. */
  slots: LaunchSlots
  /** What their menus do. */
  menus: LaunchMenus
  /** A session's key -> the card of the launch that started it, which it takes over on screen. */
  takeovers: ReadonlyMap<string, string>
}

/** What the board draws for sessions on their way (Card.tsx), and a click on their buttons. */
export function launchSlots(look: LaunchLook, onAction: (target: EventTarget | null) => boolean): LaunchSlots {
  return {
    card: (item: Item): ReactNode => {
      const l = launchOf(item)
      return l ? createElement(LaunchCard, { launch: l, look }) : null
    },
    note: (l: LaunchView): ReactNode => createElement(LaunchNote, { launch: l, look }),
    onAction: e => onAction(e.target),
  }
}

/** What the menus of their cards do (models/board-menus.ts). */
export function launchMenus(
  pending: () => readonly LaunchView[],
  cards: Pick<LaunchCards, 'trust' | 'closeTab' | 'dismiss'>,
  retry: (l: LaunchView, el: MenuOrigin | null) => void,
): LaunchMenus {
  return {
    placeholders: () => pending().map(launch => ({ launch })),
    trust: id => void cards.trust(id),
    closeTab: id => void cards.closeTab(id),
    retry,
    dismiss: id => void cards.dismiss(id),
  }
}

/** A session's key -> the card of the launch that started it, which it takes over on screen. */
export const takeoversOf = (launches: readonly LaunchView[]): ReadonlyMap<string, string> =>
  new Map(launches.flatMap(l => (l.key ? [[l.key, `launch:${l.id}`] as const] : [])))

/** The window's keys, before the page's own (capture on the window); returns how to stop. */
export function windowKeys(dialog: Pick<LaunchWindow, 'keydown'>): () => void {
  const onKey = (e: KeyboardEvent) => dialog.keydown(e)
  addEventListener('keydown', onKey, true)
  return () => removeEventListener('keydown', onKey, true)
}

/** localStorage, which may be missing or refuse (a private window; state/storage.ts). */
export const localStore = { get: storage.read, set: storage.set }

/**
 * Start a failed one again: the window with its values, or, for a session back from the archive,
 * its Return once more (its card goes, the Return makes a new one).
 */
export function retryLaunch(
  l: LaunchView,
  from: MenuOrigin | null,
  deps: {
    open(l: LaunchView, from: MenuOrigin | null): void
    dismiss(id: string): void
    onResume(l: LaunchView & { resume: string }): void
  },
): void {
  if (!l.resume) {
    deps.open(l, from)
    return
  }
  deps.dismiss(l.id)
  deps.onResume({ ...l, resume: l.resume })
}

export interface LaunchOptions {
  /** Retry on a session back from the archive: its Return again. */
  onResume?: (l: LaunchView & { resume: string }) => void
}

export function useLaunch({ onResume }: LaunchOptions = {}): Launch {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ t, board, onResume })
  const [refs] = useState<LaunchRefs>(() => ({ layer: createRef(), win: createRef() }))
  const focus = useModalFocus(refs.layer, refs.win)
  const focusRef = useLatest(focus)
  const [pressed, setPressed] = useState<Pressed>(() => new Map())

  const [dialog] = useState(() =>
    launchWindow({
      t: () => latest.current.t,
      canMutate: () => latest.current.board.canMutate,
      data: () => {
        const { data, ui } = latest.current.board
        return {
          categories: data?.categories ?? [],
          items: data?.items ?? [],
          filter: ui.filter,
          profiles: data?.profiles ?? [],
        }
      },
      toast: (text, error) => latest.current.board.toast(text, error),
      api: launchApi,
      layer: () => refs.layer.current,
      win: () => refs.win.current,
      focus: () => focusRef.current,
      store: localStore,
      onStarted: l => {
        // The new card must be in sight: its lane and its profile shown, then drawn at once (the
        // window folds into it).
        const { data, ui, dispatch } = latest.current.board
        const pick = pickShowing(ui.profile, data?.profiles, l.profile)
        flushSync(() => {
          if (ui.filter !== 'all' && ui.filter !== l.category) dispatch({ type: 'filter', id: l.category })
          if (pick !== null) dispatch({ type: 'profile', id: pick })
          dispatch({ type: 'launched', launch: l })
        })
      },
      now: () => Date.now(),
      viewportHeight: () => innerHeight,
    }),
  )
  useEffect(() => () => dialog.stop(), [dialog])

  useEffect(() => windowKeys(dialog), [dialog])

  // Fresh data came or went: the Start button says so.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the data going stale or fresh is when to look again, not what it reads
  useEffect(() => dialog.sync(), [dialog, board.canMutate])

  // Retry: the window with its values, or a Return once more for a session back from the archive.
  const retryWith =
    (dismiss: (id: string) => unknown) =>
    (l: LaunchView, el: MenuOrigin | null): void =>
      retryLaunch(l, el, {
        open: (l, from) => void dialog.retry(l, from),
        dismiss: id => void dismiss(id),
        onResume: l => latest.current.onResume?.(l),
      })
  const [cards] = useState(() => {
    const made: LaunchCards = launchCards({
      t: () => latest.current.t,
      canMutate: () => latest.current.board.canMutate,
      toast: (text, error) => latest.current.board.toast(text, error),
      api: launchApi,
      launches: () => latest.current.board.data?.launches ?? [],
      local: () => latest.current.board.ui.launched,
      forget: id => latest.current.board.dispatch({ type: 'launchGone', id }),
      retry: (l, el) => retryWith(made.dismiss)(l, el),
      press: (key, shown) =>
        setPressed(now => {
          const next = new Map(now)
          if (shown === null) next.delete(key)
          else next.set(key, shown)
          return next
        }),
    })
    return made
  })

  const shown = useStore(dialog.openNow)
  const launcher = useStore(dialog.launcher)
  const { data, ui, now } = board
  const pending = useMemo(() => launchesOnTheirWay(data, ui.launched, now), [data, ui.launched, now])
  const latestPending = useLatest(pending)

  const slots = useMemo(
    () =>
      launchSlots({ t, launcher: launcherName(launcher), pressed: (what, l) => isPressed(pressed, what, l) }, target =>
        cards.onAction(target),
      ),
    [t, launcher, pressed, cards],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryWith reads only what never changes (the window) and the latest values
  const menus = useMemo(
    () => launchMenus(() => latestPending.current, cards, retryWith(cards.dismiss)),
    [cards, latestPending],
  )
  const takeovers = useMemo(() => takeoversOf(data?.launches ?? []), [data])

  return {
    dialog,
    refs,
    open: (ctx, from) => void dialog.open(ctx, from),
    shown,
    isOpen: dialog.isOpen,
    close: dialog.close,
    slots,
    menus,
    takeovers,
  }
}
