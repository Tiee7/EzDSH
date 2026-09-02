import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('workflow node icon styles', () => {
  it('keeps the inspector icon on its node accent color', () => {
    const css = readFileSync(new URL('../../src/renderer/workflow/workflow.css', import.meta.url), 'utf8')

    expect(css).toContain('.workflow-node-inspector-header .workflow-node-type-icon { color: var(--workflow-node-accent); }')
  })

  it('uses a blue background and accent for employee nodes', () => {
    const css = readFileSync(new URL('../../src/renderer/workflow/workflow.css', import.meta.url), 'utf8')

    expect(css).toContain('.workflow-flow-node-employee { border-color: color-mix(in srgb, var(--workflow-node-accent) 42%, var(--ezdsh-panel-border-strong)); background: color-mix(in srgb, var(--workflow-node-accent) 18%, var(--ezdsh-panel-background)); }')
    expect(css).toContain('.workflow-node-type-employee { --workflow-node-accent: #2563eb; }')
  })
})
