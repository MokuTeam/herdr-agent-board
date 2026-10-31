// Everything a process was handed on stdin, as UTF-8 (the Claude Code hook and status line read
// their input this way). Not Bun.stdin.text(): outside a top-level await it does not keep the
// process alive, which then exits before the input arrives.
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

const ESC = '\u001b'

/**
 * One line typed at the terminal with nothing shown (a secret's value): `prompt` on stderr, then
 * the keys read raw until Enter; Backspace takes one character back, Ctrl+C or Ctrl+D with nothing
 * typed ends it with null. Only for a terminal (process.stdin.isTTY).
 */
export function readHidden(prompt: string): Promise<string | null> {
  const input = process.stdin
  process.stderr.write(prompt)
  return new Promise(resolve => {
    let typed = ''
    const done = (value: string | null): void => {
      input.off('data', onData)
      input.setRawMode?.(false)
      input.pause()
      process.stderr.write('\n')
      resolve(value)
    }
    const onData = (chunk: Buffer | string): void => {
      // A paste in a terminal that brackets it: the brackets are not typed.
      const text = String(chunk).split(`${ESC}[200~`).join('').split(`${ESC}[201~`).join('')
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          done(typed)
          return
        }
        if (ch === '\u0003' || (ch === '\u0004' && typed === '')) {
          done(null)
          return
        }
        if (ch === '\u007f' || ch === '\b') typed = [...typed].slice(0, -1).join('')
        else if (ch >= ' ' || ch === '\t') typed += ch
      }
    }
    input.setRawMode?.(true)
    input.resume()
    input.setEncoding('utf8')
    input.on('data', onData)
  })
}
