import type { TextProviderConfig, ProviderConfig } from "./types.js";
import { getProviderModels } from "./provider-models.js";

export function defaultTudaTextProvider(providers: readonly TextProviderConfig[], selected?: string, defaultModel?: string): string {
  return providers.find((provider) => provider.id === selected)?.id
    ?? providers.find((provider) => /deepseek/i.test(provider.model) && /dashscope/i.test(`${provider.id} ${provider.name} ${provider.baseUrl}`))?.id
    ?? providers.find((provider) => provider.model === defaultModel || provider.id.endsWith(`/${defaultModel}`))?.id
    ?? providers[0]?.id ?? "";
}

/** Image model choice belongs to the user's request, never the composer's selected image provider. */
export function resolveAgentImageProvider(providers: readonly ProviderConfig[], model: unknown, providerId?: unknown): ProviderConfig {
  if (typeof model !== "string" || !model.trim()) throw new Error("请先询问用户希望使用哪个生图模型，再调用工具。");
  const matches = providers.filter(provider => getProviderModels(provider).includes(model)
    && (providerId === undefined || provider.id === providerId));
  if (matches.length === 0) throw new Error("该连接与模型组合不在当前的生图授权目录中。");
  if (matches.length > 1) throw new Error("多个服务提供同名生图模型，请先询问用户要使用哪个服务。");
  return matches[0];
}
