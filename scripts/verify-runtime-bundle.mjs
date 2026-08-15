import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractFile } from '@electron/asar'
import { x as extractArchive } from 'tar'

const projectRoot = resolve(import.meta.dirname, '..')
const bundleRoot = process.argv[2] === undefined
  ? join(projectRoot, 'out')
  : resolve(projectRoot, process.argv[2])
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-bundle-'))
let runtimeExtractionRoot

const nodeCandidates = [
  join(bundleRoot, 'node-runtime', 'bin', 'node'),
  join(bundleRoot, 'app.asar.unpacked', 'out', 'node-runtime', 'bin', 'node'),
  join(bundleRoot, 'app', 'out', 'node-runtime', 'bin', 'node')
]
let nodeExecutable = nodeCandidates.find((candidate) => {
  return existsSync(candidate)
})

const runtimeCandidates = [
  join(bundleRoot, 'dsh-runtime', 'lib', 'bin.js'),
  join(bundleRoot, 'app.asar.unpacked', 'out', 'dsh-runtime', 'lib', 'bin.js'),
  join(bundleRoot, 'app', 'out', 'dsh-runtime', 'lib', 'bin.js')
]
let runtimeEntry = runtimeCandidates.find((candidate) => {
  return existsSync(candidate)
})

if (nodeExecutable === undefined) {
  throw new Error(`Bundled Node executable was not found under ${bundleRoot}`)
}

if (runtimeEntry === undefined) {
  const archiveCandidates = [
    join(bundleRoot, 'dsh-runtime.tar.gz'),
    join(bundleRoot, 'app.asar.unpacked', 'out', 'dsh-runtime.tar.gz'),
    join(bundleRoot, 'app', 'out', 'dsh-runtime.tar.gz')
  ]
  let archivePath = archiveCandidates.find((candidate) => {
    try {
      return require('node:fs').existsSync(candidate)
    } catch {
      return false
    }
  })
  if (archivePath === undefined) {
    const appAsar = join(bundleRoot, 'app.asar')
    if (existsSync(appAsar)) {
      archivePath = join(temporaryRoot, 'dsh-runtime.tar.gz')
      await writeFile(archivePath, extractFile(appAsar, 'out/dsh-runtime.tar.gz'))
    }
  }
  if (archivePath === undefined) {
    throw new Error(`Bundled DSH Runtime directory or archive was not found under ${bundleRoot}`)
  }
  runtimeExtractionRoot = join(temporaryRoot, 'extracted')
  await mkdir(runtimeExtractionRoot, { recursive: true })
  await extractArchive({ file: archivePath, cwd: runtimeExtractionRoot, strict: true })
  runtimeEntry = join(runtimeExtractionRoot, 'dsh-runtime', 'lib', 'bin.js')
}
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

async function rpc(method, payload) {
  const response = await fetch(`${url}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `ezdsh-verification-${method}`,
      method,
      payload
    }),
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) {
    throw new Error(`${method} failed over HTTP ${String(response.status)}: ${await response.text()}`)
  }
  const body = await response.json()
  if (body?.result?.ok !== true) {
    const error = body?.result?.error
    throw new Error(`${method} failed: ${String(error?.code ?? 'unknown')}: ${String(error?.message ?? 'unknown error')}`)
  }
  return body.result.value
}

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
      await rpc('host.describe', {})
      healthy = true
      break
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

  const workspacePath = join(testRoot, 'workspace')
  await mkdir(workspacePath)
  const createdWorkspace = await rpc('workspace.create', { path: workspacePath })
  const workspaceId = createdWorkspace?.workspace?.workspaceId
  if (typeof workspaceId !== 'string') {
    throw new Error(`workspace.create returned no workspace id: ${JSON.stringify(createdWorkspace)}`)
  }
  const createdSession = await rpc('session.create', { workspaceId })
  if (typeof createdSession?.sessionId !== 'string') {
    throw new Error(`session.create returned no session id: ${JSON.stringify(createdSession)}`)
  }

  console.log(`Verified bundled DSH Runtime ${runtimeIdentity.version} at ${url} (workspace and session creation succeeded)`)
} finally {
  if (childExit === undefined) signalChild('SIGTERM')
  await waitForExit(5_000)
  if (childExit === undefined) {
    signalChild('SIGKILL')
    await waitForExit(5_000)
  }
  if (childExit === undefined) throw new Error('Bundled DSH Runtime process did not exit')
  await rm(testRoot, { recursive: true, force: true })
  await rm(temporaryRoot, { recursive: true, force: true })
}
