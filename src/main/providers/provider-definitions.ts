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
    ['openai', 'OpenAI', 'OPENAI_API_KEY'],
    ['anthropic', 'Anthropic', 'ANTHROPIC_API_KEY'],
    ['google', 'Google Gemini', 'GOOGLE_API_KEY'],
    ['moonshotai', 'Moonshot / Kimi', 'MOONSHOT_API_KEY'],
    ['minimax', 'MiniMax', 'MINIMAX_API_KEY'],
    ['zhipuai', '智谱 GLM', 'ZHIPU_API_KEY'],
    ['mistral', 'Mistral AI', 'MISTRAL_API_KEY'],
    ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY'],
    ['groq', 'Groq', 'GROQ_API_KEY'],
    ['togetherai', 'Together AI', 'TOGETHERAI_API_KEY']
  ].map(([id, displayName, credentialKey]) => ({
    id,
    displayName,
    category: 'aggregator' as const,
    credentialKey,
    supportsConnectionTest: true,
    modelCatalogSource: 'builtin' as const
  }))
]

export function findProviderDefinition(providerId: string): ProviderDefinition {
  const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === providerId)
  if (definition === undefined) throw new Error(`Unknown provider: ${providerId}`)
  return definition
}
