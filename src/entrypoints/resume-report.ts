// The resume command of a session in another profile than the default one, reported to herdr
// (core/resume.ts), so that herdr brings the session back with it after a restart:
//
//   bun resume-report.ts <pane> <session id> <command>...
//
// The SessionStart hook starts it in a process of its own, so that Claude's start does not wait.
// herdr keeps a command only for the session it holds for the pane (its own hook reported it, and
// it sees Claude there), and only with a --seq newer than its own hook's: before each try it is
// asked for the pane's agent. Claude with this session: the report goes, with the time as --seq;
// once herdr takes it, done. Claude with another session (a /clear since): no report, done.
// No Claude or no session yet, or herdr answering with an error: the next try (REPORT_DELAYS_MS).
// After the last, nothing: herdr resumes the session its own way, as before.
import { agentGet, herdrText } from '../adapters/herdr.ts'
import { REPORT_DELAYS_MS, RESUME_AGENT, reportArgs, SESSION_ID } from '../core/resume.ts'

const [pane = '', session = '', ...command] = process.argv.slice(2)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  if (!pane || !SESSION_ID.test(session) || !command.length) return
  for (const delay of REPORT_DELAYS_MS) {
    await sleep(delay)
    let held: string | null
    try {
      const agent = await agentGet(pane, 5000)
      held = agent?.kind === RESUME_AGENT ? agent.session : null
    } catch {
      continue
    }
    if (held && held !== session) return
    if (held !== session) continue
    try {
      await herdrText(reportArgs(pane, session, Date.now(), command), 10_000)
      return
    } catch {}
  }
}

main().catch(() => {})
