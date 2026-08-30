import { describe, expect, it } from 'vitest'
import { dirname } from 'node:path'
import {
  buildDshCliLaunch,
  parseDshCliInvocation,
  type DshCliLaunchOptions
} from '../../src/main/cli/dsh-cli'

describe('EzDSH CLI bridge', () => {
  it('extracts DSH arguments after the --cli dsh marker', () => {
    expect(parseDshCliInvocation([
      '/path/EzDSH',
      '--cli',
      'dsh',
      '--profile',
      'web',
      '--dump-config'
    ])).toEqual({ args: ['--profile', 'web', '--dump-config'] })
  })

  it('does not treat ordinary Electron arguments as a DSH invocation', () => {
    expect(parseDshCliInvocation(['/path/EzDSH', '--some-electron-flag'])).toBeUndefined()
    expect(parseDshCliInvocation(['/path/EzDSH', '--cli', 'other'])).toBeUndefined()
  })

  it('builds a bundled Runtime command with the EzDSH environment', () => {
    const options: DshCliLaunchOptions = {
      command: '/app/out/node-runtime/bin/node',
      runtimeEntryPath: '/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
      pnpmPath: '/app/out/pnpm/pnpm',
      dshHome: '/data/EzDSH/harness',
      dshArgs: ['--profile', 'web', '--dump-config'],
      environment: { PATH: '/usr/bin', LANG: 'en_US.UTF-8' }
    }

    expect(buildDshCliLaunch(options)).toEqual({
      command: '/app/out/node-runtime/bin/node',
      args: [
        '/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
        '--profile',
        'web',
        '--dump-config'
      ],
      environment: {
        PATH: '/app/out/pnpm:/app/out/node-runtime/bin:/usr/bin',
        LANG: 'en_US.UTF-8',
        DSH_HOME: '/data/EzDSH/harness'
      }
    })
  })

  it('uses Electron as plain Node only when no standalone Runtime command is available', () => {
    const options: DshCliLaunchOptions = {
      command: process.execPath,
      runtimeEntryPath: '/repo/node_modules/@deepseek-ai/dsh/lib/bin.js',
      pnpmPath: '/repo/node_modules/.bin/pnpm',
      dshHome: '/tmp/ezdsh/harness',
      dshArgs: ['--version'],
      environment: { PATH: '/usr/bin' }
    }

    expect(buildDshCliLaunch(options)).toEqual({
      command: process.execPath,
      args: [
        '--expose-internals',
        '/repo/node_modules/@deepseek-ai/dsh/lib/bin.js',
        '--version'
      ],
      environment: {
        PATH: `/repo/node_modules/.bin:${dirname(process.execPath)}:/usr/bin`,
        DSH_HOME: '/tmp/ezdsh/harness',
        ELECTRON_RUN_AS_NODE: '1'
      }
    })
  })
})
