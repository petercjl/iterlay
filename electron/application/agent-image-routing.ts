import { createHash } from "node:crypto";
import { resolveImageRouting } from "../../shared/image-routing.js";
import { imageProviderCapabilities } from "../../shared/provider-capabilities.js";
import { getProviderModels } from "../../shared/provider-models.js";
import type { AppSettings, GenerateImageInput, GenerateResponse, ProviderConfig } from "../../shared/types.js";
import { ImageSubmissionError } from "../providers/errors.js";

type Channel = { provider: ProviderConfig; model: string };
type RoutingSettings = Pick<AppSettings, "providers" | "activeProviderId" | "imageRouting"> & { providerKeyStatus?: Record<string, boolean> };

export function agentImageChannels(settings: RoutingSettings, request: { model: string; count: number; references: number; transparent: boolean }): Channel[] {
  const routing = resolveImageRouting(settings.imageRouting, settings.providers, settings.activeProviderId);
  const name = request.model || routing.defaultModel;
  const route = routing.models.find(model => model.name === name);
  if (!route) throw new Error(name ? `生图模型「${name}」没有配置渠道。` : "请在模型设置中配置默认生图模型。");
  const channels = route.channels.flatMap(({ providerId, model }) => {
    const provider = settings.providers.find(item => item.id === providerId);
    if (!provider || provider.type === "official" || !settings.providerKeyStatus?.[providerId] || !getProviderModels(provider).includes(model)) return [];
    const capabilities = imageProviderCapabilities(provider);
    if (request.count > capabilities.maxImageCount ||
      (request.references && !capabilities.generationReferences) ||
      (request.transparent && !capabilities.transparentBackground)) return [];
    return [{ provider, model }];
  });
  if (!channels.length) throw new Error(`「${name}」没有可用于本次参数的已配置生图渠道。`);
  return channels;
}

export async function generateWithImageRouting(
  channels: Channel[],
  input: GenerateImageInput,
  submit: (input: GenerateImageInput) => Promise<GenerateResponse>
): Promise<GenerateResponse> {
  const warnings: string[] = [];
  const taskPrefix = createHash("sha256").update(input.clientTaskId!).digest("hex").slice(0, 32);
  for (const [index, channel] of channels.entries()) {
    const label = `${channel.provider.name} · ${channel.model}`;
    try {
      const result = await submit({
        ...input, providerId: channel.provider.id, model: channel.model,
        clientTaskId: `${taskPrefix}-${index + 1}`, recoverImageSubmission: true
      });
      return warnings.length ? { ...result, warnings: [...warnings, `最终使用 ${label}。`, ...result.warnings ?? []] } : result;
    } catch (error) {
      if (!(error instanceof ImageSubmissionError) || (error.outcome !== "rejected" && error.outcome !== "failed")) {
        if (error instanceof ImageSubmissionError && error.outcome === "unknown") {
          throw new ImageSubmissionError("unknown", error.code, `${label}：${error.message}`);
        }
        throw error;
      }
      warnings.push(`${label}：${error.message}`);
    }
  }
  throw new ImageSubmissionError("failed", "IMAGE_CHANNELS_FAILED", warnings.join("；"));
}
