// The test launcher owns these pipes and binds the app-server identity outside the requests.

import { createInterface } from 'node:readline'

process.on('message', message => process.stdout.write(`${JSON.stringify(message)}\n`))
for await (const line of createInterface({ input: process.stdin })) process.send?.(JSON.parse(line))
