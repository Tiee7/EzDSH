import { access, cp, mkdir, realpath, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const runtimeSource = join(projectRoot, 'vendor', 'deepseek-harness')
const destination = join(projectRoot, 'out', 'dsh-runtime')

await rm(destination, { recursive: true, force: true })
await mkdir(dirname(destination), { recursive: true })

execFileSync('pnpm', [
  '--dir', runtimeSource,
  'deploy',
  '--legacy',
  '--filter', '@deepseek-ai/dsh',
  '--prod',
  destination
], {
  cwd: projectRoot,
  env: { ...process.env, CI: 'true' },
  stdio: 'inherit'
})

// `apps/web/dist` is a generated workspace artifact and therefore is not part
// of the source checkout copied by deploy. The web bundle is required by the
// Web profile, so publish it into the deployed package's real directory.
const deployedWebLink = join(
  destination,
  'node_modules',
  '.pnpm',
  'node_modules',
  '@deepseek-ai',
  'dsh-web-frontend'
)
const deployedWebRoot = await realpath(deployedWebLink)
try {
  await access(join(deployedWebRoot, 'dist', 'index.html'))
} catch {
  await cp(join(runtimeSource, 'apps', 'web', 'dist'), join(deployedWebRoot, 'dist'), {
    recursive: true,
    force: true
  })
}

console.log(`Staged DSH Runtime at ${destination}`)
