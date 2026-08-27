import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const destination = join(projectRoot, 'out', 'pnpm')
const executableName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })

// electron-builder may omit node_modules/.bin symlinks. Keep a real launcher
// in out/ so the DSH command can find pnpm in a production bundle.
if (process.platform === 'win32') {
  await writeFile(
    join(destination, executableName),
    '@echo off\r\nnode "%~dp0..\\..\\node_modules\\pnpm\\bin\\pnpm.mjs" %*\r\n',
    'utf8'
  )
} else {
  await writeFile(
    join(destination, executableName),
    '#!/usr/bin/env node\nimport \'../../node_modules/pnpm/bin/pnpm.mjs\'\n',
    'utf8'
  )
  await chmod(join(destination, executableName), 0o755)
}

console.log(`Staged bundled pnpm launcher at ${join(destination, executableName)}`)
