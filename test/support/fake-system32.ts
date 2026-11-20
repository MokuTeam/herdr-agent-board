// whoami.exe and icacls.exe under a SystemRoot of a test's own (secret-sinks.test.ts, #275): one
// program, which of the two by its file name. whoami says the user is anna; icacls says anna alone
// has the file, and on its first change of rights it swaps FAKE_SWAP_PATH for a link to
// FAKE_SWAP_TO, as a process of the same user racing the board would.
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
if (basename(process.execPath).toLowerCase().startsWith('whoami')) {
  console.log('"anna\\ben","S-1-5-21-1000"')
  process.exit(0)
}
const [path = ''] = args
if (args.length === 1) {
  console.log(`${path} anna\\ben:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files`)
  process.exit(0)
}
const swap = process.env.FAKE_SWAP_PATH
const to = process.env.FAKE_SWAP_TO
const done = `${to}.swapped`
if (swap && to && !existsSync(done)) {
  rmSync(swap, { force: true })
  symlinkSync(to, swap)
  writeFileSync(done, '')
}
