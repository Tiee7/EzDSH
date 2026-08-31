import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkflowPage } from '../../src/renderer/workflow/WorkflowPage.js'
import { getAppCopy } from '../../src/shared/locale.js'

describe('workflow generation entry point', () => {
  it('renders a distinct magic-wand button in the workflow list', () => {
    const markup = renderToStaticMarkup(<WorkflowPage copy={getAppCopy('zh')} locale="zh" />)

    expect(markup).toContain('workflow-generate-button')
    expect(markup).toContain('workflow-generate-icon')
    expect(markup).toContain('AI 生成工作流')
  })
})
