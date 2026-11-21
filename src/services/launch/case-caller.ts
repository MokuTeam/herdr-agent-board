// Who runs spawn-agent --thread (#488): the session the thread's assignment is written as, read as
// the board command reads the session it runs in (services/own-session.ts, one function for both);
// the owner outside any. Asked only by --thread.
import { readCard } from '../../adapters/cards.ts'
import { type HerdrPane, snapshot } from '../../adapters/herdr.ts'
import type { Party } from '../../core/work-threads.ts'
import { ownSessionOf } from '../own-session.ts'

type Env = Readonly<Record<string, string | undefined>>

const herdrPane = async (pane: string): Promise<HerdrPane | undefined> =>
  (await snapshot()).panes.find(x => x.pane_id === pane)

/** The session running spawn-agent, or the owner. */
export async function caseCaller(
  env: Env = process.env,
  paneOf: (pane: string) => Promise<HerdrPane | undefined> = herdrPane,
): Promise<Party> {
  const s = await ownSessionOf({
    env,
    paneOf,
    readCard,
    nameOf: key => {
      const name = readCard(key)?.name
      return typeof name === 'string' && name ? name : undefined
    },
  })
  return s ? { kind: 'session', ...s } : { kind: 'owner' }
}
