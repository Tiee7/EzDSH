import type { PluginCompatibilityAssessment, PluginCompatibilityRequirements } from '../../shared/store.js'

interface ParsedVersion {
  readonly numeric: readonly number[]
  readonly prerelease?: readonly string[]
}

const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u

/** Compare DSH versions without adding a runtime semver dependency. */
export function compareDshVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left)
  const parsedRight = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = parsedLeft.numeric[index]! - parsedRight.numeric[index]!
    if (delta !== 0) return delta
  }
  if (parsedLeft.prerelease === undefined && parsedRight.prerelease === undefined) return 0
  if (parsedLeft.prerelease === undefined) return 1
  if (parsedRight.prerelease === undefined) return -1
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index]
    const rightIdentifier = parsedRight.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumber = /^\d+$/u.test(leftIdentifier) ? Number(leftIdentifier) : undefined
    const rightNumber = /^\d+$/u.test(rightIdentifier) ? Number(rightIdentifier) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return leftIdentifier.localeCompare(rightIdentifier)
  }
  return 0
}

export function assessPluginCompatibility(
  runtimeVersion: string | undefined,
  requirements: PluginCompatibilityRequirements | undefined,
): PluginCompatibilityAssessment {
  const normalizedRuntime = runtimeVersion?.trim() ?? ''
  if (requirements === undefined || (requirements.minDshVersion === undefined && requirements.maxDshVersion === undefined)) {
    return { status: 'unknown', runtimeVersion: normalizedRuntime || 'unknown', reason: 'The catalog does not declare a DSH runtime range.' }
  }
  if (normalizedRuntime === '') {
    return { status: 'unknown', runtimeVersion: 'unknown', reason: 'The installed DSH runtime version is unavailable.' }
  }
  try {
    if (requirements.minDshVersion !== undefined && compareDshVersions(normalizedRuntime, requirements.minDshVersion) < 0) {
      return { status: 'incompatible', runtimeVersion: normalizedRuntime, reason: `Requires DSH ${requirements.minDshVersion} or later.` }
    }
    if (requirements.maxDshVersion !== undefined && compareDshVersions(normalizedRuntime, requirements.maxDshVersion) > 0) {
      return { status: 'incompatible', runtimeVersion: normalizedRuntime, reason: `Requires DSH ${requirements.maxDshVersion} or earlier.` }
    }
  } catch {
    return { status: 'unknown', runtimeVersion: normalizedRuntime, reason: 'The DSH runtime version or declared compatibility range is malformed.' }
  }
  return { status: 'compatible', runtimeVersion: normalizedRuntime, reason: 'Declared DSH runtime range matches.' }
}

function parseVersion(value: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) throw new Error(`Invalid DSH version: ${value}`)
  const prerelease = match[4]?.split('.')
  if (prerelease?.some((identifier) => identifier === '')) throw new Error(`Invalid DSH prerelease: ${value}`)
  return {
    numeric: [Number(match[1]), Number(match[2] ?? '0'), Number(match[3] ?? '0')],
    ...(prerelease === undefined ? {} : { prerelease }),
  }
}
