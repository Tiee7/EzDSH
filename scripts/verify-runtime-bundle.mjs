import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertPinnedDshRuntimeVersion } from './dsh-runtime-version.mjs'
import { removeWithRetry } from './retry-remove.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const isPrePackageVerification = process.argv[2] === undefined
const bundleRoot = isPrePackageVerification
  ? join(projectRoot, 'out')
  : resolve(projectRoot, process.argv[2])

const nodeExecutableName = process.platform === 'win32' ? 'node.exe' : 'node'
const nodeCandidates = [
  join(bundleRoot, 'node-runtime', 'bin', nodeExecutableName),
  join(bundleRoot, 'app', 'out', 'node-runtime', 'bin', nodeExecutableName)
]
let nodeExecutable = nodeCandidates.find((candidate) => {
  return existsSync(candidate)
})

const runtimeCandidates = [
  // The packaged source Runtime is authoritative when present. The npm
  // package remains in the app only as a development/helper dependency while
  // upstream 0.1.3-alpha.1 is not published to the registry.
  join(bundleRoot, 'dsh-runtime', 'lib', 'bin.js'),
  join(bundleRoot, 'app', 'out', 'dsh-runtime', 'lib', 'bin.js'),
  join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  join(bundleRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ...(isPrePackageVerification
    ? [join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
    : []),
]
let runtimeEntry = runtimeCandidates.find((candidate) => {
  return existsSync(candidate)
})

if (nodeExecutable === undefined) {
  throw new Error(`Bundled Node executable was not found under ${bundleRoot}`)
}

if (runtimeEntry === undefined) {
  throw new Error(`Bundled DSH Runtime package was not found under ${bundleRoot}`)
}

function findSelectedDshRuntimeManifest(entry) {
  let directory = dirname(entry)
  while (true) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === '@deepseek-ai/dsh') {
        return { manifest, manifestPath }
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Selected DSH Runtime entry has no owning @deepseek-ai/dsh manifest: ${entry}`)
}

const selectedRuntimeManifest = findSelectedDshRuntimeManifest(runtimeEntry)
assertPinnedDshRuntimeVersion(
  `selected DSH Runtime manifest at ${selectedRuntimeManifest.manifestPath}`,
  selectedRuntimeManifest.manifest.version
)
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ezdsh-runtime-bundle-'))

// DSH's plugin command invokes pnpm by name. Verify the application ships it
// so a production install never depends on the shell PATH of the user who
// launches the desktop app.
const pnpmExecutableName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const pnpmCandidates = isPrePackageVerification
  ? [join(projectRoot, 'node_modules', '.bin', pnpmExecutableName)]
  : [
      join(bundleRoot, 'node_modules', '.bin', pnpmExecutableName),
      join(bundleRoot, 'app', 'node_modules', '.bin', pnpmExecutableName),
      join(bundleRoot, 'out', 'pnpm', pnpmExecutableName),
      join(bundleRoot, 'app', 'out', 'pnpm', pnpmExecutableName)
    ]
if (!pnpmCandidates.some((candidate) => existsSync(candidate))) {
  throw new Error(`Bundled pnpm executable was not found under ${bundleRoot}`)
}

// Several runtime seams are keyed by Symbols exported from shared packages.
// A copied root dependency and pnpm's canonical dependency can therefore look
// identical while being different JavaScript modules. Verify that every
// importer uses the same physical module exposed at the runtime root; otherwise
// model tool calls or preset composition fail after packaging.
const runtimeRoot = resolve(runtimeEntry, '..', '..')
const runtimeRequire = createRequire(join(runtimeRoot, 'package.json'))
function assertSharedRuntimeModule(packageName, importerNames) {
  const rootEntry = runtimeRequire.resolve(packageName)
  const rootRealpath = realpathSync(rootEntry)
  for (const importerName of importerNames) {
    const importerEntry = runtimeRequire.resolve(importerName)
    const importerRequire = createRequire(importerEntry)
    const importerEntryPath = importerRequire.resolve(packageName)
    if (realpathSync(importerEntryPath) !== rootRealpath) {
      throw new Error(
        `Bundled DSH Runtime has duplicate ${packageName} modules for ${importerName}:\n`
        + `root: ${rootEntry}\nimporter: ${importerEntryPath}`
      )
    }
  }
}
assertSharedRuntimeModule('@deepseek-ai/dsh-tools', ['@deepseek-ai/dsh-agent-loop'])
assertSharedRuntimeModule('@deepseek-ai/dsh-scope', [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-persona'
])
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

async function rpc(method, payload, cookie) {
  const response = await fetch(`${url}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `ezdsh-verification-${method}`,
      method,
      payload: { args: payload }
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
let resolveRuntimeWebUrl
const announcedRuntimeWebUrl = new Promise((resolveRuntimeUrl) => {
  resolveRuntimeWebUrl = resolveRuntimeUrl
})
const capture = (chunk) => {
  output = `${output}${String(chunk)}`.slice(-20_000)
  const match = /dsh web:\s*(https?:\/\/[^\s]+)/iu.exec(output)
  if (match !== null && resolveRuntimeWebUrl !== undefined) {
    resolveRuntimeWebUrl(match[1])
    resolveRuntimeWebUrl = undefined
  }
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
  let runtimeWebUrl
  let authCookie
  while (Date.now() < deadline && childExit === undefined && runtimeWebUrl === undefined) {
    const remainingMs = deadline - Date.now()
    runtimeWebUrl = await Promise.race([
      announcedRuntimeWebUrl,
      exited.then(() => undefined),
      new Promise((resolveWait) => setTimeout(() => resolveWait(undefined), Math.min(250, remainingMs)))
    ])
  }
  if (runtimeWebUrl !== undefined) {
    const tokenResponse = await fetch(runtimeWebUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000)
    })
    authCookie = tokenResponse.headers.get('set-cookie')?.split(';', 1)[0]
    if (authCookie === undefined || authCookie === '') {
      throw new Error(`Bundled DSH Runtime token exchange failed: ${String(tokenResponse.status)} ${await tokenResponse.text()}`)
    }
  }
  while (Date.now() < deadline && childExit === undefined) {
    try {
      if (authCookie === undefined) throw new Error('Runtime did not announce a tokenized web URL')
      const rootResponse = await fetch(url, {
        headers: { Cookie: authCookie },
        signal: AbortSignal.timeout(10_000)
      })
      if (!rootResponse.ok) throw new Error(`authenticated Runtime root failed: HTTP ${String(rootResponse.status)}`)
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
  const createdWorkspace = await rpc('workspace/create', { request: { path: workspacePath } }, authCookie)
  const workspaceId = createdWorkspace?.workspace?.workspaceId
  if (typeof workspaceId !== 'string') {
    throw new Error(`workspace.create returned no workspace id: ${JSON.stringify(createdWorkspace)}`)
  }
  const createdSession = await rpc('session/create', { request: { workspaceId } }, authCookie)
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
  await removeWithRetry(testRoot)
  await removeWithRetry(temporaryRoot)
}
