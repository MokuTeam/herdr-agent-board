// The web board on its own, without the terminal board around it: `bun src/entrypoints/server.ts`.
import { liveConfig } from '../adapters/config-file.ts'
import { type BoardServer, startServer } from '../server/app.ts'
import { defaultDeps } from '../services/deps.ts'

let server: BoardServer | undefined
const cfg = liveConfig(() => void server?.refresh())
startServer({ deps: defaultDeps(cfg, msg => console.error(msg)) })
  .then(s => {
    server = s
    console.log(`agent board: ${s.url}`)
  })
  .catch((err: unknown) => {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    console.error(
      code === 'EADDRINUSE'
        ? 'agent board: the port is taken, another board already serves it'
        : err instanceof Error
          ? err.message
          : String(err),
    )
    process.exit(1)
  })
