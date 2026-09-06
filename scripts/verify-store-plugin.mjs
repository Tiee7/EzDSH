#!/usr/bin/env node

/**
 * Verify one catalog DSH plugin in an isolated pnpm project.
 *
 * This is the admission check for StorePluginVerification. It intentionally
 * runs the real package manager, including lifecycle scripts, so a catalog
 * entry is not marked passed by a static source check alone.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PNPM = process.platform === 'win32'
  ? join(ROOT, 'node_modules', '.bin', 'pnpm.cmd')
  : join(ROOT, 'node_modules', '.bin', 'pnpm')

function parseArgs(argv) {
  const result = { allowBuild: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--source') result.source = argv[++index]
    else if (argument === '--package-name') result.packageName = argv[++index]
    else if (argument === '--dsh-version') result.dshVersion = argv[++index]
    else if (argument === '--pnpm-version') result.pnpmVersion = argv[++index]
    else if (argument === '--allow-build') result.allowBuild.push(argv[++index])
    else if (argument === '--json') result.json = true
    else if (argument === '--help' || argument === '-h') result.help = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return result
}

function usage() {
  return [
    'Usage: node scripts/verify-store-plugin.mjs --source <npm:...|github:...> --package-name <name>',
    '       [--dsh-version <version>] [--pnpm-version <version>] [--allow-build <exact-spec>] [--json]'
  ].join('\n')
}

function packageManifestPath(root, packageName) {
  return join(root, 'node_modules', ...packageName.split('/'), 'package.json')
}

function classifyFailure(output) {
  if (/ERR_PNPM_INVALID_DEPENDENCY_NAME|invalid alias/i.test(output)) return 'invalid-dependency-name'
  if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(output)) return 'build-script-blocked'
  if (/404|not found/i.test(output)) return 'package-not-found'
  if (/401|403|unauthori[sz]ed|private repository/i.test(output)) return 'auth'
  if (/ENOTFOUND|ECONN|ETIMEDOUT|timed? out|network/i.test(output)) return 'network'
  if (/prepare|preinstall|postinstall|build script|lifecycle script/i.test(output)) return 'build-failed'
  return 'unknown'
}

async function verify(options) {
  if (options.source === undefined || options.packageName === undefined) throw new Error(usage())
  const workspace = await mkdtemp(join(tmpdir(), 'ezdsh-store-plugin-'))
  try {
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'ezdsh-store-preflight', private: true, dependencies: {} }) + '\n')
    const args = ['add', '--lockfile=false', ...options.allowBuild.map((spec) => `--allow-build=${spec}`), options.source]
    const child = spawnSync(PNPM, args, {
      cwd: workspace,
      env: { ...process.env, PATH: [dirname(PNPM), process.env.PATH ?? ''].filter(Boolean).join(delimiter) },
      encoding: 'utf8'
    })
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim()
    if (child.error !== undefined || child.status !== 0) {
      return {
        status: 'failed',
        checkedAt: new Date().toISOString(),
        source: options.source,
        dshVersion: options.dshVersion ?? 'unknown',
        pnpmVersion: options.pnpmVersion ?? 'unknown',
        packageName: options.packageName,
        allowBuilds: options.allowBuild,
        reason: `${classifyFailure(output)}: ${output.slice(-2000)}`
      }
    }
    let manifest
    try {
      manifest = JSON.parse(await readFile(packageManifestPath(workspace, options.packageName), 'utf8'))
    } catch {
      return {
        status: 'failed',
        checkedAt: new Date().toISOString(),
        source: options.source,
        dshVersion: options.dshVersion ?? 'unknown',
        pnpmVersion: options.pnpmVersion ?? 'unknown',
        packageName: options.packageName,
        allowBuilds: options.allowBuild,
        reason: `postcondition: package ${options.packageName} was not materialized in node_modules`
      }
    }
    if (manifest.name !== options.packageName) {
      return {
        status: 'failed',
        checkedAt: new Date().toISOString(),
        source: options.source,
        dshVersion: options.dshVersion ?? 'unknown',
        pnpmVersion: options.pnpmVersion ?? 'unknown',
        packageName: options.packageName,
        allowBuilds: options.allowBuild,
        reason: `postcondition: installed manifest name ${String(manifest.name)} does not match ${options.packageName}`
      }
    }
    if (manifest.dsh?.bundle === undefined) {
      return {
        status: 'failed',
        checkedAt: new Date().toISOString(),
        source: options.source,
        dshVersion: options.dshVersion ?? 'unknown',
        pnpmVersion: options.pnpmVersion ?? 'unknown',
        packageName: options.packageName,
        allowBuilds: options.allowBuild,
        reason: `postcondition: ${options.packageName} does not declare dsh.bundle`
      }
    }
    return {
      status: 'passed',
      checkedAt: new Date().toISOString(),
      source: options.source,
      dshVersion: options.dshVersion ?? 'unknown',
      pnpmVersion: options.pnpmVersion ?? 'unknown',
      packageName: options.packageName,
      allowBuilds: options.allowBuild
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(usage())
    process.exit(0)
  }
  const result = await verify(options)
  if (options.json === true) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${result.status}: ${result.packageName}`)
    if (result.reason !== undefined) console.error(result.reason)
  }
  process.exit(result.status === 'passed' ? 0 : 1)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
