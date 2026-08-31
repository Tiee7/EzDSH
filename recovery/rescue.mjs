#!/usr/bin/env node

/*
 * EzDSH Rescue Channel
 *
 * This file intentionally has no dependency on Electron, EzDSH, or DSH. It is
 * copied into the user's backup directory so it can still inspect and restore
 * user data when the desktop app or bundled Runtime cannot start.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

const COMPONENTS = ['harness', 'state', 'workflow']
const SNAPSHOT_PATTERN = /^ezdsh-(manual|pre-update|pre-restore)-[^/]+\.tar\.gz$/u
const here = dirname(fileURLToPath(import.meta.url))
const cli = parseArgs(process.argv.slice(2))
const root = resolve(cli.root ?? dirname(here))
const backupsRoot = join(root, 'backups')

function parseArgs(args) {
  const options = {}
  const positional = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--yes') {
      options.yes = true
    } else if (arg === '--repair') {
      options.repair = true
    } else if (arg === '--root' || arg === '--data-root') {
      options.root = args[index + 1]
      index += 1
    } else if (arg === '--port') {
      options.port = Number(args[index + 1])
      index += 1
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  return { ...options, command: positional[0] ?? 'serve', selector: positional[1] ?? 'latest' }
}

async function main() {
  if (cli.command === 'serve') {
    await serve(cli.port ?? 0)
    return
  }
  if (cli.command === 'list') {
    for (const snapshot of await listSnapshots()) printSnapshot(snapshot)
    return
  }
  if (cli.command === 'verify') {
    const snapshot = await resolveSnapshot(cli.selector)
    const result = await verify(snapshot)
    console.log(`${result.ok ? 'OK' : 'FAILED'} ${result.snapshotName}`)
    console.log(`expected: ${result.expectedSha256}`)
    if (result.actualSha256 !== undefined) console.log(`actual:   ${result.actualSha256}`)
    if (result.note !== undefined) console.log(result.note)
    if (!result.ok) process.exitCode = 2
    return
  }
  if (cli.command === 'restore') {
    const snapshot = await resolveSnapshot(cli.selector)
    const preview = await previewRestore(snapshot)
    printPreview(preview)
    if (!cli.yes) {
      console.log('\nDry run only. Re-run with --yes to apply this restore.')
      return
    }
    const result = await restore(snapshot, preview)
    console.log(`Restored ${result.snapshotName} at ${result.restoredAt}`)
    console.log(`Previous user data was kept at ${result.previousDataPath}`)
    if (result.missingCredentials.length > 0) {
      console.log(`Credentials requiring re-entry: ${result.missingCredentials.join(', ')}`)
    }
    return
  }
  if (cli.command === 'doctor') {
    const report = await doctor(cli.repair === true)
    console.log(`Scanned ${report.scannedFiles} session log file(s); ${report.healthyFiles} healthy.`)
    for (const issue of report.issues) {
      console.log(`${issue.repaired ? 'REPAIRED' : issue.kind.toUpperCase()} ${issue.path}${issue.line ? `:${issue.line}` : ''} — ${issue.message}`)
    }
    if (report.issues.length > 0 && report.repairedFiles.length === 0) process.exitCode = 2
    return
  }
  throw new Error(`Unknown command: ${cli.command}. Use list, verify, restore, or serve.`)
}

async function listSnapshots() {
  let names
  try {
    names = await readdir(backupsRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const snapshots = []
  for (const name of names.filter((candidate) => SNAPSHOT_PATTERN.test(candidate))) {
    try {
      snapshots.push(await readSnapshot(name))
    } catch {
      // Incomplete archives are ignored until the user supplies the exact file.
    }
  }
  return snapshots.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt))
}

async function readSnapshot(name) {
  if (!SNAPSHOT_PATTERN.test(name) || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid snapshot name: ${name}`)
  }
  const archivePath = join(backupsRoot, name)
  const manifest = JSON.parse(await readFile(`${archivePath}.manifest.json`, 'utf8'))
  if (manifest.archiveName !== name || manifest.formatVersion !== 1) {
    throw new Error(`Invalid recovery manifest for ${name}`)
  }
  return { archiveName: name, archivePath, manifest }
}

function snapshotComponents(snapshot) {
  const components = snapshot.manifest.components ?? ['harness', 'state']
  if (!Array.isArray(components)
    || components[0] !== 'harness'
    || components[1] !== 'state'
    || (components.length !== 2 && (components.length !== 3 || components[2] !== 'workflow'))) {
    throw new Error(`Invalid recovery components for ${snapshot.archiveName}`)
  }
  return components
}

async function resolveSnapshot(selector) {
  if (!selector || selector.trim() === '') throw new Error('Snapshot selector cannot be empty')
  const snapshots = await listSnapshots()
  const candidates = selector === 'latest'
    ? snapshots.filter((snapshot) => snapshot.manifest.kind !== 'pre-restore')
    : snapshots.filter((snapshot) => snapshot.archiveName === selector || snapshot.archiveName.startsWith(selector))
  if (candidates.length === 0) throw new Error(`Snapshot not found: ${selector}`)
  if (candidates.length > 1) throw new Error(`Snapshot selector is ambiguous: ${selector}`)
  return candidates[0]
}

async function verify(snapshot) {
  try {
    const actualSha256 = await sha256File(snapshot.archivePath)
    return {
      ok: actualSha256 === snapshot.manifest.sha256,
      snapshotName: snapshot.archiveName,
      expectedSha256: snapshot.manifest.sha256,
      actualSha256,
      ...(actualSha256 === snapshot.manifest.sha256 ? {} : { note: 'checksum mismatch' }),
    }
  } catch (error) {
    return {
      ok: false,
      snapshotName: snapshot.archiveName,
      expectedSha256: snapshot.manifest.sha256,
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

async function previewRestore(snapshot) {
  const verification = await verify(snapshot)
  if (!verification.ok) throw new Error(`checksum verification failed for ${snapshot.archiveName}`)
  const entries = await archiveEntries(snapshot)
  const missingCredentials = []
  for (const relativePath of snapshot.manifest.redactedFiles ?? []) {
    if (!(await isFile(join(backupsRoot, 'vault', snapshot.archiveName, safeRelative(relativePath))))) {
      missingCredentials.push(relativePath)
    }
  }
  return { snapshotName: snapshot.archiveName, entries, missingCredentials }
}

async function restore(snapshot, preview) {
  const components = snapshotComponents(snapshot)
  const staging = join(backupsRoot, `.ezdsh-rescue-staging-${Date.now()}-${process.pid}`)
  const aside = join(root, `.ezdsh-rescue-pre-restore-${Date.now()}`)
  const touched = []
  await mkdir(staging, { recursive: true, mode: 0o700 })
  try {
    await run('tar', ['-xzf', snapshot.archivePath, '-C', staging], backupsRoot)
    await validateTree(staging, staging)
    for (const component of components) {
      if (!(await isDirectory(join(staging, component)))) {
        throw new Error(`archive is missing component ${component}`)
      }
    }

    await mkdir(aside, { recursive: true, mode: 0o700 })
    try {
      for (const component of components) {
        const target = join(root, component)
        const saved = join(aside, component)
        if (await pathExists(target)) await rename(target, saved)
        touched.push(component)
        await rename(join(staging, component), target)
      }
      await restoreCredentials(snapshot)
    } catch (error) {
      for (const component of [...touched].reverse()) {
        const target = join(root, component)
        const saved = join(aside, component)
        await rm(target, { recursive: true, force: true })
        if (await pathExists(saved)) await rename(saved, target)
      }
      throw error
    }
    return {
      snapshotName: snapshot.archiveName,
      restoredAt: new Date().toISOString(),
      missingCredentials: preview.missingCredentials,
      previousDataPath: aside,
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function restoreCredentials(snapshot) {
  const vaultRoot = join(backupsRoot, 'vault', snapshot.archiveName)
  for (const relativePath of snapshot.manifest.redactedFiles ?? []) {
    const source = join(vaultRoot, safeRelative(relativePath))
    if (!(await isFile(source))) continue
    const destination = join(root, safeRelative(relativePath))
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(source, destination)
    await chmod(destination, 0o600).catch(() => undefined)
  }
}

async function doctor(repair = false) {
  const sessionRoot = join(root, 'harness', 'sessions')
  const files = await collectSessionLogFiles(sessionRoot)
  const issues = []
  const repairedFiles = []
  let healthyFiles = 0
  for (const file of files) {
    const fileIssues = await inspectSessionLog(file, repair)
    if (fileIssues.length === 0) healthyFiles += 1
    const displayPath = relative(root, file).split(sep).join('/')
    for (const issue of fileIssues) {
      issues.push({ ...issue, path: displayPath })
      if (issue.repaired) repairedFiles.push(displayPath)
    }
  }
  return { scannedFiles: files.length, healthyFiles, repairedFiles, issues }
}

async function collectSessionLogFiles(directory) {
  const files = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const candidate = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectSessionLogFiles(candidate))
    else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd') || entry.name === 'sessions.db')) files.push(candidate)
  }
  return files.sort()
}

async function inspectSessionLog(path, repair) {
  if (path.endsWith('sessions.db')) {
    return [{ kind: 'unsupported-backend', message: 'SQLite session logs require the DSH Runtime backend for a full integrity check' }]
  }
  const content = await readFile(path)
  if (path.endsWith('.jsonl.zstd')) {
    try {
      const frames = scanZstdFrames(content)
      if (frames.tornStart !== undefined) return [{ kind: 'invalid-compressed-log', message: `Session log ends inside a Zstandard frame at byte ${frames.tornStart}` }]
      return inspectJsonlBuffer(path, Buffer.concat(frames.frames.map((frame) => zstdDecompressSync(content.subarray(frame.start, frame.end)))), false)
    } catch (error) {
      return [{ kind: 'invalid-compressed-log', message: error instanceof Error ? error.message : String(error) }]
    }
  }
  return inspectJsonlBuffer(path, content, repair)
}

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  const magic = 0xFD2FB528
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== magic) throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`invalid Zstandard frame header at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const hasChecksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`invalid Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (hasChecksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

async function inspectJsonlBuffer(path, content, repair) {
  if (content.length === 0) return [{ kind: 'empty-log', message: 'Session log is empty' }]
  const hasTrailingNewline = content.at(-1) === 0x0A
  const lines = content.toString('utf8').split('\n')
  if (hasTrailingNewline) lines.pop()
  const header = parseJsonRecord(lines[0] ?? '')
  if (!header || header.type !== 'session' || typeof header.version !== 'number' || typeof header.id !== 'string') {
    return [{ kind: 'invalid-header', line: 1, message: 'First JSONL record is not a valid session header' }]
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || parseJsonRecord(line)) continue
    const isTornFinalRecord = !hasTrailingNewline && index === lines.length - 1
    if (!isTornFinalRecord) return [{ kind: 'invalid-record', line: index + 1, message: 'A committed JSONL record cannot be parsed; automatic repair is refused' }]
    const issue = { kind: 'incomplete-final-record', line: index + 1, message: 'The final JSONL record is incomplete; the committed prefix is still readable' }
    if (repair) {
      const newlineOffset = content.lastIndexOf(0x0A)
      if (newlineOffset >= 0) {
        await writeAtomicBuffer(path, content.subarray(0, newlineOffset + 1))
        issue.repaired = true
      }
    }
    return [issue]
  }
  return []
}

function parseJsonRecord(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

async function archiveEntries(snapshot) {
  const result = await run('tar', ['-tzf', snapshot.archivePath], backupsRoot)
  const entries = result.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)
  for (const entry of entries) validateArchiveEntry(entry)
  return entries
}

function validateArchiveEntry(entry) {
  const normalized = entry.replaceAll('\\', '/').replace(/^\.\//u, '')
  const segments = normalized.split('/').filter(Boolean)
  if (
    normalized === ''
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.includes('..')
    || !COMPONENTS.includes(segments[0])
  ) {
    throw new Error(`Unsafe recovery archive entry: ${entry}`)
  }
}

function safeRelative(value) {
  const normalized = String(value).replaceAll('\\', '/').replace(/^\.\//u, '')
  const segments = normalized.split('/').filter(Boolean)
  if (
    normalized === ''
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.includes('..')
    || !COMPONENTS.includes(segments[0])
  ) {
    throw new Error(`Unsafe recovery path: ${value}`)
  }
  return normalized
}

async function validateTree(directory, archiveRoot) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name)
    const relativePath = relative(archiveRoot, candidate).split(sep).join('/')
    validateArchiveEntry(relativePath)
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relativePath}`)
    if (entry.isDirectory()) await validateTree(candidate, archiveRoot)
    else if (!entry.isFile()) throw new Error(`Unsupported archive entry: ${relativePath}`)
  }
}

async function serve(port) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/list') {
        return sendJson(response, await listSnapshots())
      }
      if (url.pathname === '/api/verify') {
        const snapshot = await resolveSnapshot(url.searchParams.get('name') ?? 'latest')
        return sendJson(response, await verify(snapshot))
      }
      if (url.pathname === '/api/doctor') {
        return sendJson(response, await doctor(url.searchParams.get('repair') === '1'))
      }
      if (url.pathname === '/api/restore') {
        const snapshot = await resolveSnapshot(url.searchParams.get('name') ?? 'latest')
        const preview = await previewRestore(snapshot)
        if (url.searchParams.get('apply') !== '1') return sendJson(response, { dryRun: true, ...preview })
        if (request.method !== 'POST') return sendJson(response, { error: 'Applying a restore requires POST' }, 405)
        return sendJson(response, { dryRun: false, ...await restore(snapshot, preview) })
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(renderHtml())
    } catch (error) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  await new Promise((resolveServer) => server.listen(port, '127.0.0.1', resolveServer))
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  console.log(`EzDSH Recovery is running at http://127.0.0.1:${actualPort}`)
  console.log('Close this terminal to stop the rescue channel.')
}

function renderHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>EzDSH Recovery</title>
<style>body{font:16px system-ui;margin:40px;max-width:900px}button{margin-right:8px;padding:8px 14px}li{margin:14px 0}.error{color:#b42318}.meta{color:#667085;font-size:14px}</style>
<h1>EzDSH Recovery</h1>
<p>独立救援通道：先校验快照，再恢复用户环境。Credential 明文不会进入 Archive。</p>
<div id="status">Loading backups…</div>
<script>
const esc = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
async function load(){
  const items=await fetch('/api/list').then(r=>r.json());
  document.querySelector('#status').innerHTML=items.length ? '<ul>'+items.map(item=>
    '<li><strong>'+esc(item.archiveName)+'</strong><div class="meta">'+esc(item.manifest.kind)+' · '+esc(item.manifest.createdAt)+' · EzDSH '+esc(item.manifest.appVersion)+'</div>'+
    '<button onclick="verify(\\''+encodeURIComponent(item.archiveName)+'\\')">Verify</button><button onclick="restore(\\''+encodeURIComponent(item.archiveName)+'\\')">Restore</button></li>').join('')+'</ul>' : '<p>No complete snapshots found.</p>';
}
async function verify(name){const result=await fetch('/api/verify?name='+name).then(r=>r.json());alert(result.ok?'Checksum OK':'Checksum FAILED: '+(result.note||''));}
async function restore(name){const preview=await fetch('/api/restore?name='+name).then(r=>r.json());if(preview.error){alert(preview.error);return;}const message='Restore '+preview.snapshotName+'?\\n\\n'+preview.entries.length+' archive entries will replace harness, state, and workflow.'+(preview.missingCredentials.length?'\\n\\nCredentials to re-enter: '+preview.missingCredentials.join(', '):'');if(confirm(message))alert(JSON.stringify(await fetch('/api/restore?name='+name+'&apply=1',{method:'POST'}).then(r=>r.json()),null,2));}
load().catch(error=>document.querySelector('#status').innerHTML='<p class="error">'+esc(error)+'</p>');
</script>`
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

function printSnapshot(snapshot) {
  console.log(`${snapshot.archiveName}  ${snapshot.manifest.kind}  ${snapshot.manifest.createdAt}  EzDSH ${snapshot.manifest.appVersion}`)
}

function printPreview(preview) {
  console.log(`Snapshot: ${preview.snapshotName}`)
  console.log(`Entries: ${preview.entries.length}`)
  if (preview.missingCredentials.length > 0) {
    console.log(`Credentials requiring re-entry: ${preview.missingCredentials.join(', ')}`)
  }
}

async function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

async function writeAtomicBuffer(path, content) {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, content, { mode: 0o600 })
  await rename(tempPath, path)
}

async function run(command, args, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolveResult({ stdout, stderr })
      else reject(new Error(`Recovery command failed: ${command} ${args.join(' ')}: ${stderr || stdout}`))
    })
  })
}

async function isFile(path) {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function pathExists(path) {
  try { await lstat(path); return true } catch { return false }
}

main().catch((error) => {
  console.error(`EzDSH Recovery failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
