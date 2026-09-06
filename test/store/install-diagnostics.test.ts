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
