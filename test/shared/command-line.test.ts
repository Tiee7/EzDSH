import { describe, expect, it } from 'vitest'
import { normalizeCommandLine } from '../../src/shared/command-line.js'

describe('normalizeCommandLine', () => {
  it.each(['', '  ', '""', "''", '"" --version', "'' --version", '"   " --version', "'  ' --version"])(
    'rejects an empty executable in %j',
    (command) => expect(() => normalizeCommandLine(command, [])).toThrow('External service command is required'),
  )

  it('preserves quoted paths and empty arguments after a valid executable', () => {
    expect(normalizeCommandLine('"/Applications/My Tool/bin/run" ""', ['--flag'])).toEqual({
      command: '/Applications/My Tool/bin/run', args: ['', '--flag'],
    })
  })
})
