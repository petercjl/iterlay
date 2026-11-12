import type { TextProviderConfig, ProviderConfig } from "./types.js";

export function defaultTudaTextProvider(providers: readonly TextProviderConfig[], selected?: string, defaultModel?: string): string {
  return providers.find((provider) => provider.id === selected)?.id
    ?? providers.find((provider) => /deepseek/i.test(provider.model) && /dashscope/i.test(`${provider.id} ${provider.name} ${provider.baseUrl}`))?.id
    ?? providers.find((provider) => provider.model === defaultModel || provider.id.endsWith(`/${defaultModel}`))?.id
    ?? providers[0]?.id ?? "";
}

/** Image model choice belongs to the user's request, never the composer's selected image provider. */
export function toapisAgentProvider(providers: readonly ProviderConfig[], model: unknown): ProviderConfig {
  if (typeof model !== "string" || !model.trim()) throw new Error("请先询问用户希望使用哪个 ToAPIs 生图模型，再调用工具。");
  const provider = providers.find((item) => item.transport === "toapiscli" && (item.model === model || item.models?.includes(model)));
  if (!provider) throw new Error("该模型不在当前员工的 ToAPIs 授权目录中，请查询可用模型并让用户选择。");
  return provider;
}
