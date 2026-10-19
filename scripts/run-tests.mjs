// Node 20 does not expand a quoted test glob; directory discovery also executes
// our helper fixtures. Select test modules explicitly and use Node's own runner. The child process group is stopped on cancellation.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

export async function testFiles(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'fixtures') files.push(...await testFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path)
  }
  return files.sort()
}

// Include detached grandchildren: runTree() deliberately starts a new process group.
// Only groups whose leader is a known descendant can be signalled as a group.
export function descendantTargets(root, rows) {
  const descendants = new Set([root])
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, parent] of rows) if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true }
  }
  const groups = new Set(rows.filter(([pid, , pgid]) => descendants.has(pid) && descendants.has(pgid)).map(([, , pgid]) => pgid))
  const singles = rows.filter(([pid, , pgid]) => descendants.has(pid) && !groups.has(pgid)).map(([pid]) => pid)
  return [...groups].map(pid => -pid).concat(singles)
}

export async function main(args = process.argv.slice(2)) {
  const files = await testFiles(fileURLToPath(new URL('../test/', import.meta.url)))
  if (!files.length) throw new Error('No test modules found')
  const win = process.platform === 'win32'
  const child = spawn(process.execPath, ['--test', ...args, ...files], {
    stdio: 'inherit', detached: !win, shell: false,
  })
  let interrupted = null
  let cleanup = Promise.resolve()
  let cleanupFailed = false
  const interrupt = signal => {
    if (interrupted) return
    interrupted = signal
    cleanup = (async () => {
    if (win) {
      await new Promise(resolve => {
        const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
        const kill = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: false, windowsHide: true })
        const failed = message => { cleanupFailed = true; console.error(`Could not terminate test process tree: ${message}`); child.kill(); resolve() }
        kill.once('error', error => failed(error.message))
        kill.once('close', code => code === 0 ? resolve() : failed(`taskkill exited ${code}`))
      })
    } else {
      let targets = [-child.pid]
      try {
        const { stdout } = await exec('/bin/ps', ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 << 20 })
        const rows = stdout.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number))
        targets = descendantTargets(child.pid, rows)
        if (!targets.includes(-child.pid)) targets.push(-child.pid)
      } catch (error) {
        cleanupFailed = true
        console.error(`Could not inspect detached test descendants: ${error.message}`)
      }
      const terminate = sig => {
        for (const pid of targets) try { process.kill(pid, sig) } catch (error) {
          if (error.code !== 'ESRCH') { cleanupFailed = true; console.error(`Could not stop test process ${pid}: ${error.message}`) }
        }
      }
      terminate(signal)
      await new Promise(resolve => setTimeout(resolve, 250))
      terminate('SIGKILL')
    }
    })().catch(error => { cleanupFailed = true; console.error(`Test cleanup failed: ${error.message}`); child.kill() })
  }
  const onInt = () => interrupt('SIGINT')
  const onTerm = () => interrupt('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    await cleanup
    process.exitCode = cleanupFailed ? 1 : interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : result.code ?? (result.signal === 'SIGINT' ? 130 : 1)
  } finally {
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
