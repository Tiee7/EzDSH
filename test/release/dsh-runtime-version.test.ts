import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  PINNED_DSH_SOURCE_COMMIT,
  PINNED_DSH_RUNTIME_VERSION,
  PUBLISHED_DSH_PACKAGE_VERSION,
  assertPinnedDshSourceCommit,
  assertPinnedDshRuntimeVersion
} from '../../scripts/dsh-runtime-version.mjs'

describe('DSH Runtime version', () => {
  it('uses the exact vendored source Runtime pin', () => {
    expect(PINNED_DSH_RUNTIME_VERSION).toBe('0.1.3-alpha.1')
    expect(PINNED_DSH_SOURCE_COMMIT).toBe('d347e703908d0406b7a7ef80e3a0e594d86b2215')
  })

  it('rejects a vendored checkout that differs from the source commit pin', () => {
    expect(() => assertPinnedDshSourceCommit('fixture', '141eb6fef83422698aef7a981029e843e8161534'))
      .toThrow(/fixture.*d347e703.*141eb6fe/)
  })

  it('accepts the pinned vendored source commit', () => {
    expect(() => assertPinnedDshSourceCommit('fixture', PINNED_DSH_SOURCE_COMMIT)).not.toThrow()
  })

  it('keeps registry-only root DSH companions at the available published pin', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    const dshDependencies = Object.entries(packageJson.dependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))

    expect(dshDependencies.length).toBeGreaterThan(0)
    expect(dshDependencies.every(([, spec]) => spec === PUBLISHED_DSH_PACKAGE_VERSION)).toBe(true)
  })

  it('rejects a version that differs from the pin with useful details', () => {
    expect(() => assertPinnedDshRuntimeVersion('fixture', '0.1.0-rc.8'))
      .toThrow(/fixture.*0\.1\.3-alpha\.1.*0\.1\.0-rc\.8/)
  })

  it('accepts the pinned version', () => {
    expect(() => assertPinnedDshRuntimeVersion('fixture', '0.1.3-alpha.1')).not.toThrow()
  })

  it('verifies the authenticated token URL with slash-style workspace and session RPCs', async () => {
    const bundleRoot = await mkdtemp(join(tmpdir(), 'ezdsh-authenticated-runtime-bundle-'))
    const runtimeEntry = join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodeExecutable = join(bundleRoot, 'node-runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    const pnpmExecutable = join(bundleRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    const shellQuote = (value: string): string => `'${value.replace(/'/gu, "'\\\"'\\\"'")}'`

    try {
      await mkdir(dirname(runtimeEntry), { recursive: true })
      await mkdir(dirname(nodeExecutable), { recursive: true })
      await mkdir(dirname(pnpmExecutable), { recursive: true })
      await mkdir(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-loop'), { recursive: true })
      await mkdir(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-presets'), { recursive: true })
      await mkdir(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent'), { recursive: true })
      await mkdir(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-scope'), { recursive: true })
      await mkdir(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })
      await writeFile(nodeExecutable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} \"$@\"\n`, { mode: 0o755 })
      await writeFile(pnpmExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      await writeFile(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.3-alpha.1' }))
      await writeFile(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'index.js'), 'module.exports = {}\n')
      await writeFile(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'index.js'), 'module.exports = {}\n')
      await writeFile(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-subagent', 'index.js'), 'module.exports = {}\n')
      await writeFile(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-scope', 'index.js'), 'module.exports = {}\n')
      await writeFile(join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'), 'module.exports = {}\n')
      await writeFile(runtimeEntry, `
const http = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const token = 'runtime-token'
const cookie = 'dsh-auth-runtime=cookie-value'
const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://127.0.0.1')
  if (request.method === 'GET' && requestUrl.pathname === '/' && requestUrl.searchParams.get('token') === token) {
    response.writeHead(303, { location: '/', 'set-cookie': cookie + '; HttpOnly; Path=/' })
    response.end()
    return
  }
  if (request.headers.cookie !== cookie) {
    if (requestUrl.pathname === '/api/host.describe') setTimeout(() => process.exit(2), 0)
    response.writeHead(401)
    response.end('missing auth cookie')
    return
  }
  if (request.method === 'GET' && requestUrl.pathname === '/') {
    response.end('authenticated runtime root')
    return
  }
  let body = ''
  for await (const chunk of request) body += chunk
  const envelope = JSON.parse(body)
  const send = (value) => response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
  if (requestUrl.pathname === '/api/workspace/create' && envelope.method === 'workspace/create' && envelope.payload?.args?.request?.path) {
    send({ workspace: { workspaceId: 'workspace-1' } })
    return
  }
  if (requestUrl.pathname === '/api/session/create' && envelope.method === 'session/create' && envelope.payload?.args?.request?.workspaceId === 'workspace-1') {
    send({ sessionId: 'session-1' })
    return
  }
  response.writeHead(404)
  response.end('unexpected RPC contract')
})
server.listen(port, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + port + '/?token=' + token))
`)

      const verifier = resolve('scripts/verify-runtime-bundle.mjs')
      const result = spawnSync(process.execPath, [verifier, bundleRoot], { encoding: 'utf8', timeout: 15_000 })
      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
      expect(result.stdout).toMatch(/workspace and session creation succeeded/)
      expect(result.stderr).not.toContain('host.describe')
    } finally {
      await rm(bundleRoot, { recursive: true, force: true })
    }
  }, 20_000)

  it('rejects a selected Runtime entry whose owning manifest is stale before Runtime startup', async () => {
    const bundleRoot = await mkdtemp(join(tmpdir(), 'ezdsh-stale-runtime-bundle-'))
    const runtimeEntry = join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodeExecutable = join(
      bundleRoot,
      'node-runtime',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node'
    )
    const pnpmExecutable = join(
      bundleRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    )

    try {
      await mkdir(dirname(runtimeEntry), { recursive: true })
      await mkdir(dirname(nodeExecutable), { recursive: true })
      await mkdir(dirname(pnpmExecutable), { recursive: true })
      await writeFile(runtimeEntry, '// The version gate must run before this entry can start.\n')
      await writeFile(
        join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.8' })
      )
      await writeFile(nodeExecutable, '')
      await writeFile(pnpmExecutable, '')

      const verifier = resolve('scripts/verify-runtime-bundle.mjs')
      const result = spawnSync(process.execPath, [verifier, bundleRoot], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/selected DSH Runtime.*0\.1\.3-alpha\.1.*0\.1\.0-rc\.8/)
    } finally {
      await rm(bundleRoot, { recursive: true, force: true })
    }
  })

  it('rejects a selected Runtime entry from the previous pin before Runtime startup', async () => {
    const bundleRoot = await mkdtemp(join(tmpdir(), 'ezdsh-previous-runtime-bundle-'))
    const runtimeEntry = join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodeExecutable = join(
      bundleRoot,
      'node-runtime',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node'
    )
    const pnpmExecutable = join(
      bundleRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    )

    try {
      await mkdir(dirname(runtimeEntry), { recursive: true })
      await mkdir(dirname(nodeExecutable), { recursive: true })
      await mkdir(dirname(pnpmExecutable), { recursive: true })
      await writeFile(runtimeEntry, '// The version gate must run before this entry can start.\n')
      await writeFile(
        join(bundleRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' })
      )
      await writeFile(nodeExecutable, '')
      await writeFile(pnpmExecutable, '')

      const verifier = resolve('scripts/verify-runtime-bundle.mjs')
      const result = spawnSync(process.execPath, [verifier, bundleRoot], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/selected DSH Runtime.*0\.1\.3-alpha\.1.*0\.1\.1-rc\.2/)
    } finally {
      await rm(bundleRoot, { recursive: true, force: true })
    }
  })
})
