import { describe, expect, it } from 'vitest'
import { getAppCopy } from '../../src/shared/locale'

describe('recovery copy evidence and scope', () => {
  it('does not diagnose a conflicting plugin from generic startup failure', () => {
    const copy = getAppCopy('zh')
    expect(copy.recoveryRemoveConflictingPlugins).toBe('查看已安装插件')
    expect(copy.recoveryRuntimeFailureDetail).toContain('尚未确定失败原因')
    expect(copy.recoveryRuntimeFailureDetail).not.toContain('卸载')
    expect(copy.recoveryDetail).not.toContain('上次升级后')
  })

  it('explains full backup scope before the user selects one', () => {
    const copy = getAppCopy('zh')
    expect(copy.recoverySelectSnapshotHint).toContain('会话、设置、插件和工作流数据')
    expect(copy.recoverySelectSnapshotHint).toContain('不回退应用版本')
    expect(copy.recoverySelectSnapshotHint).toContain('保留当前状态的备份')
  })

  it('keeps English equally explicit', () => {
    const copy = getAppCopy('en')
    expect(copy.recoveryRemoveConflictingPlugins).toBe('View installed plugins')
    expect(copy.recoveryRuntimeFailureDetail).toContain('cause has not been determined')
    expect(copy.recoverySelectSnapshotHint).toContain('sessions, settings, plugins, and workflow data')
    expect(copy.recoverySelectSnapshotHint).toContain('does not downgrade the app')
  })
})
