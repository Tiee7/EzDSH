import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderService } from '../../src/main/providers/provider-service.js'
import { ensureUserDataLayout, getUserDataLayout } from '../../src/main/state/user-data.js'

describe('workflow Runtime model directory', () => {
  it('exposes plugin-owned Codex models without a static provider credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ezdsh-provider-runtime-'))
    try {
      const layout = getUserDataLayout(root)
      await ensureUserDataLayout(layout)
      const service = new ProviderService(layout, {
        listRuntimeModels: async () => [{
          providerId: 'openai-codex',
          providerName: 'OpenAI Codex',
          modelId: 'gpt-5.6-luna',
          modelName: 'GPT-5.6 Luna',
        }],
      })

      await expect(service.listWorkflowModels()).resolves.toEqual([{
        providerId: 'openai-codex',
        providerName: 'OpenAI Codex',
        modelId: 'gpt-5.6-luna',
        modelName: 'GPT-5.6 Luna',
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
