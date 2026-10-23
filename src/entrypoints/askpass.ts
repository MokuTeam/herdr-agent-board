// ssh's askpass for the admin's login by password (adapters/ssh.ts openAskpass): ssh runs the
// board's Bun with its prompt as the one argument, and BUN_OPTIONS has that Bun import this file
// (the prompt an argument, never an option of Bun's). It asks the board on loopback with the
// one-time token ssh's environment carries, and prints the board's answer for ssh. No answer (a
// key's passphrase, a prompt the board refuses and ends ssh for, no board): exit 1, nothing
// printed. The password is in no argument and no file.
import { connect } from 'node:net'

const prompt = process.argv.at(-1) ?? ''
const port = Number(process.env.BOARD_ASKPASS_PORT)
const token = process.env.BOARD_ASKPASS_TOKEN ?? ''

function ask(): Promise<string | null> {
  return new Promise(resolve => {
    let got = ''
    const socket = connect({ host: '127.0.0.1', port }, () => socket.write(`${JSON.stringify({ token, prompt })}\n`))
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      got += chunk
    })
    socket.on('error', () => resolve(null))
    socket.on('close', () => {
      try {
        const said = JSON.parse(got.split('\n')[0] ?? '') as { answer?: unknown }
        resolve(typeof said.answer === 'string' ? said.answer : null)
      } catch {
        resolve(null)
      }
    })
  })
}

const answer = Number.isInteger(port) && port > 0 && token !== '' ? await ask() : null
if (answer === null) process.exit(1)
process.stdout.write(`${answer}\n`)
