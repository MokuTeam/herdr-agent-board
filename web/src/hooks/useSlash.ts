// The chat box's slash command list (#191, models/slash.ts): read from the server once the box
// starts with a slash (a message that does not asks for nothing), again after a minute or for
// another session; the lit row, the keys that move it, the pick that completes the box.
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { Item } from '../../../src/core/types.ts'
import { api } from '../api/client.ts'
import {
  completion,
  noteUse,
  rankCommands,
  readUses,
  type SlashCommand,
  slashArgument,
  slashKey,
  slashQuery,
} from '../models/slash.ts'

/** How long a session's list is used before the box asks for it again. */
export const SLASH_FRESH_MS = 60_000
/** The most rows the list draws. */
const MAX_ROWS = 50

export interface SlashBox {
  /** The list shows: the box starts with a slash, something matches, and Esc did not close it. */
  open: boolean
  list: SlashCommand[]
  active: number
  /** The command whose argument is still to be typed ("/model "), for its hint. */
  argument: SlashCommand | null
  /** A key the list took (the box does nothing more with it). */
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean
  pick(index: number): void
  hover(index: number): void
  /** The message is going: a command in it counts one more send in this browser. */
  sent(text: string): void
  /** The box took or lost the focus: the list shows only while it has it (a draft kept from before opens nothing). */
  focus(on: boolean): void
}

export function useSlash(item: Pick<Item, 'key'> | null, text: string, setText: (text: string) => void): SlashBox {
  const key = item?.key ?? null
  const [focused, setFocused] = useState(false)
  const query = key && focused ? slashQuery(text) : null
  const asking = query !== null
  const [loaded, setLoaded] = useState<{ key: string; at: number; list: SlashCommand[] } | null>(null)
  const loading = useRef<string | null>(null)
  const [active, setActive] = useState(0)
  const [closedAt, setClosedAt] = useState<string | null>(null)
  const [uses, setUses] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!asking || !key) return
    if (loaded?.key === key && Date.now() - loaded.at < SLASH_FRESH_MS) return
    if (loading.current === key) return
    loading.current = key
    setUses(readUses())
    const ctl = new AbortController()
    api
      .sessionCommands(key, ctl.signal)
      .then(list => setLoaded({ key, at: Date.now(), list }))
      .catch(() => {})
      .finally(() => {
        if (loading.current === key) loading.current = null
      })
    return () => {
      ctl.abort()
      if (loading.current === key) loading.current = null
    }
  }, [asking, key, loaded])

  const own = loaded && loaded.key === key ? loaded.list : null
  const list = useMemo(
    () => (own && query !== null ? rankCommands(own, query, uses).slice(0, MAX_ROWS) : []),
    [own, query, uses],
  )
  // A new query lights its first row again.
  const [litFor, setLitFor] = useState(query)
  if (litFor !== query) {
    setLitFor(query)
    setActive(0)
  }
  const open = query !== null && list.length > 0 && closedAt !== text
  const at = Math.min(active, Math.max(0, list.length - 1))
  const argument = own ? slashArgument(text, own) : null

  const pick = (index: number) => {
    const c = list[index]
    if (c) setText(completion(c))
  }

  return {
    open,
    list,
    active: at,
    argument,
    onKeyDown(e) {
      if (!open) return false
      const typed = list[at]?.name.toLowerCase() === (query ?? '').toLowerCase()
      const action = slashKey(
        {
          key: e.key,
          shiftKey: e.shiftKey,
          isComposing: e.nativeEvent.isComposing,
          altKey: e.altKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        },
        typed,
      )
      if (!action) return false
      e.preventDefault()
      // Esc closes the list, not the panel; the board's own keys never see it.
      e.stopPropagation()
      if (action === 'next') setActive((at + 1) % list.length)
      else if (action === 'prev') setActive((at - 1 + list.length) % list.length)
      else if (action === 'complete') pick(at)
      else setClosedAt(text)
      return true
    },
    pick,
    hover: setActive,
    focus: setFocused,
    sent(sentText) {
      if (!/^\s*\//.test(sentText)) return
      noteUse(sentText, own)
      setUses(readUses())
    },
  }
}
