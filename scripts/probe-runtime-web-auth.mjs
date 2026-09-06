import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, WebContentsView } from 'electron'

const projectRoot = resolve(import.meta.dirname, '..')
const mode = process.argv[2] ?? 'iframe'
if (mode !== 'iframe' && mode !== 'view') {
  throw new Error(`Unknown probe mode: ${mode}`)
}

const runtimeEntry = join(projectRoot, 'vendor', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')
const runtimeManifest = JSON.parse(readFileSync(join(projectRoot, 'vendor', 'deepseek-harness', 'apps', 'cli', 'package.json'), 'utf8'))
const runtimePackageByTarget = {
  'darwin-arm64': 'node-bin-darwin-arm64',
  'win32-x64': 'node-win-x64',
}
const target = `${process.platform}-${process.arch}`
const runtimePackage = runtimePackageByTarget[target]
if (runtimePackage === undefined) throw new Error(`Unsupported Runtime authentication probe target: ${target}`)
const nodeExecutable = join(
  projectRoot,
  'node_modules',
  runtimePackage,
  'bin',
  process.platform === 'win32' ? 'node.exe' : 'node',
)

function listen(server, host = '127.0.0.1') {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        reject(new Error('Probe server did not expose a TCP port'))
        return
      }
      resolveListen(address.port)
    })
  })
}

function waitForRuntimeUrl(child) {
  return new Promise((resolveUrl, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      reject(new Error(`DSH did not announce its Web URL\n${output.replace(/token=[^&\s]+/giu, 'token=[REDACTED]')}`))
    }, 45_000)
    const capture = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-20_000)
      const match = /dsh web:\s*(https?:\/\/[^\s]+)/iu.exec(output)
      if (match === null) return
      clearTimeout(timeout)
      resolveUrl(match[1])
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`DSH exited before announcing its Web URL (code=${String(code)}, signal=${String(signal)})\n${output}`))
    })
  })
}

async function waitForBody(readBody) {
  const deadline = Date.now() + 30_000
  let lastBody = ''
  while (Date.now() < deadline) {
    try {
      lastBody = String(await Promise.race([
        readBody(),
        new Promise((resolveWait) => setTimeout(() => resolveWait(''), 2_000)),
      ]))
      if (lastBody.includes('dsh web authentication required')) return lastBody
      if (lastBody.trim().length > 80) return lastBody
    } catch {
      // Navigation can replace the execution context while the token redirects.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`Runtime surface did not render useful content; last body: ${lastBody}`)
}

async function runProbe() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ezdsh-runtime-web-auth-'))
  let runtimeChild
  let outerServer
  let window
  let runtimeView
  try {
    console.error(`[probe] starting DSH ${String(runtimeManifest.version)} for Electron ${mode} surface`)
    const portAllocator = createServer()
    const runtimePort = await listen(portAllocator)
    await new Promise((resolveClose) => portAllocator.close(resolveClose))

    runtimeChild = spawn(nodeExecutable, [
      '--expose-internals',
      runtimeEntry,
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      String(runtimePort),
      '--no-open',
    ], {
      cwd: temporaryRoot,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        DSH_HOME: join(temporaryRoot, 'harness'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const runtimeUrl = await waitForRuntimeUrl(runtimeChild)
    console.error('[probe] Runtime announced an authenticated Web URL')
    window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })

    let body
    if (mode === 'iframe') {
      outerServer = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><iframe title="runtime" src="${runtimeUrl}" sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"></iframe>`)
      })
      const outerPort = await listen(outerServer, 'localhost')
      console.error('[probe] loading cross-site iframe')
      await Promise.race([
        window.loadURL(`http://localhost:${String(outerPort)}`),
        new Promise((resolveWait) => setTimeout(resolveWait, 10_000)),
      ])
      console.error('[probe] inspecting iframe body')
      const runtimeOrigin = new URL(runtimeUrl).origin
      body = await waitForBody(async () => {
        const frame = window.webContents.mainFrame.framesInSubtree.find((candidate) => candidate.url.startsWith(runtimeOrigin))
        if (frame === undefined) return ''
        return frame.executeJavaScript('document.body?.innerText ?? ""')
      })
    } else {
      runtimeView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      })
      window.contentView.addChildView(runtimeView)
      runtimeView.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
      await runtimeView.webContents.loadURL(runtimeUrl)
      body = await waitForBody(() => runtimeView.webContents.executeJavaScript('document.body?.innerText ?? ""'))
    }

    if (body.includes('dsh web authentication required')) {
      throw new Error(`${mode} Runtime surface received the DSH authentication-required page`)
    }
    console.log(`Verified DSH ${String(runtimeManifest.version)} in Electron ${mode} surface without an authentication error`)
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  } finally {
    if (runtimeView !== undefined && !runtimeView.webContents.isDestroyed()) runtimeView.webContents.close()
    if (window !== undefined && !window.isDestroyed()) window.destroy()
    if (outerServer !== undefined) {
      outerServer.closeAllConnections()
      await new Promise((resolveClose) => outerServer.close(resolveClose))
    }
    if (runtimeChild?.pid !== undefined) {
      try {
        if (process.platform !== 'win32') process.kill(-runtimeChild.pid, 'SIGTERM')
        else runtimeChild.kill('SIGTERM')
      } catch {
        // Runtime already exited.
      }
    }
    rmSync(temporaryRoot, { recursive: true, force: true })
    app.exit(process.exitCode ?? 0)
  }
}

void app.whenReady().then(runProbe).catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  app.exit(1)
})
