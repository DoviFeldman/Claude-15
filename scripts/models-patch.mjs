// data/models.json -> dsh profile patch (model routes + default model).
// Run by run.sh at startup, so models added by chat (add_model / /model add) load on /restart.
//   node scripts/models-patch.mjs <models.json> <out.yml>
// "roles" (e.g. {"self": "grok"}) is read by the chat bridge, not here.
import { readFileSync, writeFileSync } from 'node:fs'

// Known providers; anything else needs baseURL + apiKeyEnv in its entry.
export const PROVIDERS = {
  groq: { baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    // Free tier = ~7k input tokens/min: wait out the window instead of failing.
    retryPolicy: { mode: 'normal', maxRetries: 6, backoff: { initialDelayMs: 2000, maxDelayMs: 65000 } } },
  xai: { baseURL: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY' },
  vercel: { baseURL: 'https://ai-gateway.vercel.sh/v1', apiKeyEnv: 'AI_GATEWAY_API_KEY', compat: { supportsDeveloperRole: false } },
  openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', compat: { supportsDeveloperRole: false } },
}

export function buildPatch(reg) {
  const providers = {}
  for (const [name, m] of Object.entries(reg.models)) {
    const base = PROVIDERS[m.provider] ?? {}
    const id = m.provider
    providers[id] ??= {
      api: m.api ?? 'openai-completions',
      baseURL: m.baseURL ?? base.baseURL,
      apiKeyEnv: m.apiKeyEnv ?? base.apiKeyEnv,
      ...(base.compat ? { compat: base.compat } : {}),
      ...(base.retryPolicy ? { retryPolicy: base.retryPolicy } : {}),
      models: [],
    }
    if (!providers[id].baseURL || !providers[id].apiKeyEnv) throw new Error(`model "${name}": unknown provider "${id}" needs baseURL and apiKeyEnv`)
    providers[id].models.push({ id: m.model, contextWindow: m.contextWindow ?? 131072, maxTokens: m.maxTokens ?? 2000 })
  }
  const def = reg.models[reg.default] ?? Object.values(reg.models)[0]
  return [
    { id: 'llm-pi-ai', config: { providers } },
    { id: 'agent-default-model', config: { provider: def.provider, model: def.model } },
  ]
}

if (process.argv[2]) {
  const reg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  // JSON is valid YAML, so the patch can be written as JSON.
  writeFileSync(process.argv[3], JSON.stringify(buildPatch(reg), null, 1))
}
