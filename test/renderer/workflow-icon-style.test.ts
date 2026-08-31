import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('workflow node icon styles', () => {
  it('keeps the inspector icon on its node accent color', () => {
    const css = readFileSync(new URL('../../src/renderer/workflow/workflow.css', import.meta.url), 'utf8')

    expect(css).toContain('.workflow-node-inspector-header .workflow-node-type-icon { color: var(--workflow-node-accent); }')
  })
})
