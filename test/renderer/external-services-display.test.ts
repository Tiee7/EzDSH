import { describe, expect, it } from 'vitest'
import { getAppCopy } from '../../src/shared/locale.js'
import { describeExternalServiceStartupIssue, normalizeExternalServiceCommand } from '../../src/renderer/settings/external-services-display.js'

describe('normalizeExternalServiceCommand', () => {
  it('accepts a common one-line npm command', () => {
    expect(normalizeExternalServiceCommand('npm run dev', [])).toEqual({
      command: 'npm',
      args: ['run', 'dev'],
    })
  })

  it('keeps explicit arguments as separate argv values', () => {
    expect(normalizeExternalServiceCommand('pnpm', ['run', 'dev', '--port', '3690'])).toEqual({
      command: 'pnpm',
      args: ['run', 'dev', '--port', '3690'],
    })
  })

  it('preserves quoted executable paths and explicit arguments', () => {
    expect(normalizeExternalServiceCommand('"/Applications/My App/bin/tool"', ['--watch'])).toEqual({
      command: '/Applications/My App/bin/tool',
      args: ['--watch'],
    })
  })
})


describe('describeExternalServiceStartupIssue', () => {
  it.each([
    ['cwd-missing', 'cwd', '工作目录不存在。', 'The working directory does not exist.'],
    ['cwd-not-directory', 'cwd', '工作目录指向了文件，请选择文件夹。', 'The working directory points to a file. Choose a folder.'],
    ['cwd-inaccessible', 'cwd', '无法访问工作目录，请选择可访问的文件夹。', 'The working directory cannot be accessed. Choose an accessible folder.'],
    ['command-not-found', 'command', '找不到启动命令，请检查命令或填写可执行文件的完整路径。', 'The start command was not found. Check the command or enter the full path to the executable.'],
    ['command-not-executable', 'command', '启动命令没有执行权限，请检查可执行文件。', 'The start command does not have execute permission. Check the executable.'],
    ['command-unavailable', 'command', '启动命令无法运行，请检查可执行文件及其运行环境。', 'The start command could not run. Check the executable and its runtime environment.'],
    ['unknown', undefined, '服务未能启动，请查看失败详情。', 'The service could not start. Review the failure details.'],
  ] as const)('localizes %s without replacing evidence with an installation assumption', (code, field, zh, en) => {
    expect(describeExternalServiceStartupIssue(getAppCopy('zh'), { code })).toEqual({ summary: zh, field })
    expect(describeExternalServiceStartupIssue(getAppCopy('en'), { code })).toEqual({ summary: en, field })
  })
})
