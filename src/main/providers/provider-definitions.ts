import type { ProviderDefinition } from '../../shared/providers.js'

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'deepseek-official',
    displayName: 'DeepSeek',
    category: 'vendor',
    credentialKey: 'DEEPSEEK_API_KEY',
    defaultBaseUrl: 'https://api.deepseek.com',
    supportsConnectionTest: true,
    modelCatalogSource: 'builtin'
  },
  ...[
    ['openai', 'OpenAI', 'OPENAI_API_KEY', 'https://api.openai.com/v1'],
    ['anthropic', 'Anthropic', 'ANTHROPIC_API_KEY', 'https://api.anthropic.com'],
    ['google', 'Google Gemini', 'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta'],
    ['moonshotai', 'Moonshot / Kimi', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai/v1'],
    ['minimax', 'MiniMax', 'MINIMAX_API_KEY', 'https://api.minimax.io/anthropic'],
    ['zai', 'Z.AI / GLM', 'ZAI_API_KEY', 'https://api.z.ai/api/coding/paas/v4'],
    ['mistral', 'Mistral AI', 'MISTRAL_API_KEY', 'https://api.mistral.ai'],
    ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1'],
    ['groq', 'Groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1'],
    ['together', 'Together AI', 'TOGETHER_API_KEY', 'https://api.together.ai/v1']
  ].map(([id, displayName, credentialKey, defaultBaseUrl]) => ({
    id,
    displayName,
    category: 'aggregator' as const,
    credentialKey,
    defaultBaseUrl,
    supportsConnectionTest: true,
    modelCatalogSource: 'builtin' as const
  }))
]

export function findProviderDefinition(providerId: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === providerId)
  if (definition === undefined) throw new Error(`Unknown provider: ${providerId}`)
  return definition
}
