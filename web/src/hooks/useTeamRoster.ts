// The Team view and its topics for a shared thread's head (#394): the teammates' names, and where
// the owner can share to. Read only while `on` (the thread is shared, or the owner opened Share) and
// Team is on, and again when the Team revision moves; nothing is read otherwise.
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client.ts'
import { isTeamView, isThreadList, type TeamView, type ThreadView } from '../models/team.ts'
import { askedInTurn } from '../models/time.ts'

export function useTeamRoster(on: boolean, rev: number | undefined): { view: TeamView | null; topics: ThreadView[] } {
  const [state, setState] = useState<{ view: TeamView | null; topics: ThreadView[] }>({ view: null, topics: [] })
  const turn = useRef(askedInTurn())
  const live = on && rev !== undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new Team revision is when to read again
  useEffect(() => {
    if (!live) return
    const n = turn.current.ask()
    const ctl = new AbortController()
    Promise.all([
      api.get('/api/team', isTeamView, { cache: 'no-store', signal: ctl.signal }),
      api
        .get('/api/team/threads', isThreadList, { cache: 'no-store', signal: ctl.signal })
        .catch(() => ({ threads: [] })),
    ])
      .then(([view, list]) => {
        if (turn.current.last(n)) setState({ view, topics: list.threads })
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [live, rev])
  return live ? state : { view: null, topics: [] }
}
