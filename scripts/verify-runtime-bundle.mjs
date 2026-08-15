import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const bundleRoot = process.argv[2] === undefined
  ? join(projectRoot, 'out')
  : resolve(projectRoot, process.argv[2])
const nodeExecutable = join(bundleRoot, 'node-runtime', 'bin', 'node')
const runtimeEntry = join(bundleRoot, 'dsh-runtime', 'lib', 'bin.js')
const testRoot = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-verification-'))

const runtimeIdentity = JSON.parse(execFileSync(nodeExecutable, [
  '-p',
  'JSON.stringify({ platform: process.platform, arch: process.arch, version: process.version })'
], { encoding: 'utf8' }))
if (runtimeIdentity.platform !== process.platform || runtimeIdentity.arch !== process.arch) {
  throw new Error(`Bundled Node target ${runtimeIdentity.platform}-${runtimeIdentity.arch} does not match build host ${process.platform}-${process.arch}`)
}

async function allocatePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : undefined
  await new Promise((resolveClose) => server.close(resolveClose))
  if (port === undefined) throw new Error('Unable to allocate a verification port')
  return port
}

const port = await allocatePort()
const url = `http://127.0.0.1:${String(port)}`
const child = spawn(nodeExecutable, [
  runtimeEntry,
  'web',
  '--host',
  '127.0.0.1',
  '--port',
  String(port)
], {
  cwd: testRoot,
  env: {
    ...process.env,
    DSH_HOME: join(testRoot, 'harness')
  },
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
const capture = (chunk) => {
  output = `${output}${String(chunk)}`.slice(-20_000)
}
child.stdout.on('data', capture)
child.stderr.on('data', capture)

let childExit
let resolveExited
const exited = new Promise((resolveExit) => {
  resolveExited = resolveExit
  child.once('exit', (code, signal) => {
    childExit = { code, signal }
    resolveExit()
  })
})
child.once('error', (error) => {
  capture(`\n[spawn error] ${String(error)}\n`)
  if (childExit === undefined) {
    childExit = { error }
    resolveExited()
  }
})

function signalChild(signal) {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through when the process group has already exited.
    }
  }
  child.kill(signal)
}

async function waitForExit(timeoutMs) {
  let timeout
  try {
    await Promise.race([
      exited,
      new Promise((resolveWait) => {
        timeout = setTimeout(resolveWait, timeoutMs)
      })
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

try {
  const deadline = Date.now() + 45_000
  let healthy = false
  while (Date.now() < deadline && childExit === undefined) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) {
        healthy = true
        break
      }
    } catch {
      // Runtime is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }

  if (!healthy) {
    const exitDetail = childExit === undefined
      ? 'process was still running'
      : 'error' in childExit
        ? `process failed to start: ${String(childExit.error)}`
        : `process exited with code=${String(childExit.code)} signal=${String(childExit.signal)}`
    throw new Error(`Bundled DSH Runtime did not become healthy (${exitDetail})\n${output}`)
  }

  console.log(`Verified bundled DSH Runtime ${runtimeIdentity.version} at ${url}`)
} finally {
  if (childExit === undefined) signalChild('SIGTERM')
  await waitForExit(5_000)
  if (childExit === undefined) {
    signalChild('SIGKILL')
    await waitForExit(5_000)
  }
  if (childExit === undefined) throw new Error('Bundled DSH Runtime process did not exit')
  await rm(testRoot, { recursive: true, force: true })
}
