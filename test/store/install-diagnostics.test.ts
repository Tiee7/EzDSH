import { describe, expect, it } from 'vitest'
import { diagnoseInstallFailure } from '../../src/main/store/install-diagnostics'

describe('diagnoseInstallFailure', () => {
  it('identifies an invalid dependency name and does not suggest allowBuilds', () => {
    const diagnostic = diagnoseInstallFailure(new Error([
      'DSH plugin command failed (code=1, signal=null):',
      '[ERR_PNPM_INVALID_DEPENDENCY_NAME] Refusing to place a dependency under /profile/node_modules',
      'with the invalid alias "nihaixia#v2.3.1"',
      'dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed',
    ].join('\n')))

    expect(diagnostic.code).toBe('invalid-dependency-name')
    expect(diagnostic.packageSpec).toBe('nihaixia#v2.3.1')
    expect(diagnostic.detail).toContain('invalid alias')
    expect(diagnostic.suggestedAction).not.toMatch(/allowBuilds/i)
  })

  it('identifies a blocked lifecycle script separately', () => {
    const diagnostic = diagnoseInstallFailure(new Error(
      'DSH plugin command failed: [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: plugin@https://codeload.github.com/org/plugin/tar.gz/abc'
    ))

    expect(diagnostic.code).toBe('build-script-blocked')
    expect(diagnostic.packageSpec).toContain('plugin@https://codeload.github.com')
    expect(diagnostic.suggestedAction).toMatch(/catalog|review|build/i)
  })

  it('removes the DSH generic git hint when extracting the technical detail', () => {
    const diagnostic = diagnoseInstallFailure(new Error([
      '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/missing - 404',
      'dsh: pnpm failed in profile directory /profile',
      'dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed',
    ].join('\n')))

    expect(diagnostic.code).toBe('package-not-found')
    expect(diagnostic.detail).not.toMatch(/git-hosted plugins build/i)
    expect(diagnostic.detail).toContain('404')
  })
})

describe('environment diagnosis evidence', () => {
  it.each([
    ['[ERR_PNPM_FETCH_401] GET https://registry.example/pkg - 401', 'auth'],
    ['[ERR_PNPM_FETCH_403] GET https://registry.example/pkg - 403', 'auth'],
    ['[ERR_PNPM_FETCH_401]', 'auth'],
    ['[ERR_PNPM_FETCH_403]', 'auth'],
    ['[ERR_PNPM_FETCH_404] GET https://registry.example/pkg - 404', 'package-not-found'],
    ['[ERR_PNPM_FETCH_401] package not found in registry; network error', 'auth'],
    ['[ERR_PNPM_TARBALL_INTEGRITY] checksum mismatch after network retry', 'lockfile-policy'],
    ['EACCES: permission denied while retrying network install', 'permission'],
    ['spawn git ENOENT', 'unknown'],
    ['ENOENT: no such file or directory, open /tmp/profile/package.json', 'unknown'],
    ['Bundled pnpm is missing at /app/node_modules/pnpm/bin/pnpm.cjs', 'runtime-prerequisite'],
    ['ENOTFOUND registry.example', 'network'],
    ['ETIMEDOUT while fetching package', 'network'],
  ] as const)('classifies %s as %s', (message, expected) => {
    expect(diagnoseInstallFailure(new Error(message)).code).toBe(expected)
  })

  it('does not prescribe rebuilding EzDSH for a missing external command', () => {
    const result = diagnoseInstallFailure(new Error('spawn git ENOENT'))
    expect(result.suggestedAction).not.toMatch(/update or rebuild EzDSH/i)
    expect(result.detail).toContain('spawn git ENOENT')
  })

  it.each([
    ['EACCES: permission denied, open /tmp/pnpm-lockfile.yaml', 'permission'],
    ['EPERM: operation not permitted, rename /tmp/pnpm-lockfile.yaml', 'permission'],
    ['ENOENT: no such file or directory, open /tmp/pnpm-lockfile.yaml', 'unknown'],
    ['ENOENT: no such file or directory, open /tmp/pnpm/package.json', 'unknown'],
    ['Bundled pnpm is missing at /app/node_modules/pnpm/bin/pnpm.cjs', 'runtime-prerequisite'],
    ['[ERR_PNPM_TARBALL_INTEGRITY] lockfile checksum mismatch', 'lockfile-policy'],
  ] as const)('prioritizes concrete filesystem evidence in %s as %s', (message, expected) => {
    expect(diagnoseInstallFailure(new Error(message)).code).toBe(expected)
  })
})
