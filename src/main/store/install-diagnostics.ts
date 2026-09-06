import type { InstallDiagnostic, InstallDiagnosticCode } from '../../shared/store.js'

const DSH_GENERIC_LINES = [
  /^dsh:\s+pnpm failed in profile directory\b.*$/imu,
  /^dsh:\s+git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed.*$/imu,
]

/**
 * Turn package-manager output into a stable, actionable diagnosis.
 *
 * DSH currently appends the same git/allowBuilds hint to every failed
 * git-hosted install. That hint is not evidence of the failure cause, so this
 * parser deliberately matches the pnpm error code first and removes the
 * wrapper hint from the user-facing detail.
 */
export function diagnoseInstallFailure(error: unknown): InstallDiagnostic {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = cleanTechnicalDetail(raw)
  const code = classifyCode(raw)
  const packageSpec = extractPackageSpec(raw, code)
  return {
    code,
    ...(packageSpec === undefined ? {} : { packageSpec }),
    detail,
    suggestedAction: suggestedAction(code),
  }
}

function classifyCode(message: string): InstallDiagnosticCode {
  if (/Catalog entry rejected|Unsupported DSH plugin source|Invalid DSH plugin (?:package name|profile)/i.test(message)) return 'catalog-entry-invalid'
  if (/ERR_PNPM_INVALID_DEPENDENCY_NAME|invalid (?:alias|dependency)\b/i.test(message)) return 'invalid-dependency-name'
  if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(message)) return 'build-script-blocked'
  if (/ERR_PNPM_FETCH_404|\b404\b|No matching version found|not found in (?:the )?registry/i.test(message)) return 'package-not-found'
  if (/ERR_PNPM_FETCH|ENOTFOUND|ECONN(?:RESET|REFUSED)|ETIMEDOUT|timed? out|network/i.test(message)) return 'network'
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication|private repository|permission to .* denied/i.test(message)) return 'auth'
  if (/lockfile|supply-chain|integrity|checksum|ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_LOCKFILE/i.test(message)) return 'lockfile-policy'
  if (/EACCES|EPERM|permission denied|access is denied/i.test(message)) return 'permission'
  if (/Bundled pnpm is missing|pnpm not found|ENOENT/i.test(message)) return 'runtime-prerequisite'
  if (/prepare|preinstall|postinstall|build script|lifecycle script|exit code [1-9]\d*/i.test(message)) return 'build-failed'
  if (/was not added to profile|Cannot determine the package name added/i.test(message)) return 'postcondition'
  return 'unknown'
}

function cleanTechnicalDetail(message: string): string {
  let cleaned = message
  for (const pattern of DSH_GENERIC_LINES) cleaned = cleaned.replace(pattern, '')
  cleaned = cleaned
    .replace(/^DSH plugin command failed[^:]*:\s*/imu, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned.slice(0, 4_000)
}

function extractPackageSpec(message: string, code: InstallDiagnosticCode): string | undefined {
  if (code === 'invalid-dependency-name') {
    return /invalid alias ["']([^"']+)["']/i.exec(message)?.[1]
      ?? /invalid dependency ["']([^"']+)["']/i.exec(message)?.[1]
  }
  if (code === 'build-script-blocked') {
    const ignored = /Ignored build scripts:\s*([^\r\n]+)/i.exec(message)?.[1]
    return ignored?.split(',')[0]?.trim()
  }
  return /(?:GET|fetching|package)\s+(?:https?:\/\/[^\s]+|["']([^"']+)["'])/i.exec(message)?.[1]
}

function suggestedAction(code: InstallDiagnosticCode): string {
  switch (code) {
    case 'catalog-entry-invalid': return 'This catalog entry is malformed. Remove it from the catalog or correct its source metadata before asking users to install it.'
    case 'invalid-dependency-name': return 'This is an invalid package name or alias, not a build-permission problem. Correct the catalog source or the upstream package metadata; changing build permissions will not fix it.'
    case 'build-script-blocked': return 'The package needs a lifecycle build script that the current policy did not approve. The catalog must verify the exact build dependency or the package must be republished without that requirement.'
    case 'build-failed': return 'The package was downloaded, but its prepare/build step failed. The catalog maintainer must fix or republish the package for this Runtime.'
    case 'package-not-found': return 'The requested package, version, or Git ref was not found. Correct the catalog source and pin an existing version or commit.'
    case 'network': return 'The package source could not be reached. Check network or proxy settings and retry; if it reproduces, the catalog source is unavailable.'
    case 'auth': return 'The package source requires credentials or access that users do not have. Publish a public source or remove this catalog entry.'
    case 'lockfile-policy': return 'The package was rejected by integrity or supply-chain policy. Re-publish or re-verify the exact package before catalog admission.'
    case 'permission': return 'EzDSH could not write the profile. Check profile directory permissions and retry.'
    case 'runtime-prerequisite': return 'The bundled package-manager prerequisite is missing or unusable. Update or rebuild EzDSH before installing plugins.'
    case 'postcondition': return 'The command returned, but the package was not recorded in the target profile. The catalog source and Runtime integration need investigation.'
    case 'unknown': return 'The package-manager output did not match a known failure class. Open the detailed log and report it with the catalog source.'
  }
}
