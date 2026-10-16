// Everything a process was handed on stdin, as UTF-8 (the Claude Code hook and status line read
// their input this way). Not Bun.stdin.text(): outside a top-level await it does not keep the
// process alive, which then exits before the input arrives.
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}
