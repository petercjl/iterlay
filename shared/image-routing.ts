import { getProviderModels } from "./provider-models.js";
import type { ProviderConfig, TextProviderConfig } from "./contracts/providers.js";

export interface ImageChannel {
  providerId: string;
  model: string;
}

export interface ImageModelRouting {
  defaultModel: string;
  models: Array<{ name: string; channels: ImageChannel[] }>;
}

export type OtherModelKind = "text" | "video" | "audio";
export type OtherModelRouting = Partial<Record<OtherModelKind, ImageModelRouting>>;
export const textModelRouteId = (name: string): string => `text-route/${encodeURIComponent(name)}`;

export function findTextModelRoute(routing: OtherModelRouting | undefined, id: string | undefined) {
  return id?.startsWith("text-route/")
    ? routing?.text?.models.find(model => textModelRouteId(model.name) === id)
    : undefined;
}

export function resolveTextModelChannels(
  route: NonNullable<ReturnType<typeof findTextModelRoute>>,
  providers: readonly TextProviderConfig[],
  ready: (provider: TextProviderConfig) => boolean
): TextProviderConfig[] {
  return route.channels.flatMap(channel => {
    const provider = providers.find(item => item.id === channel.providerId && item.model === channel.model);
    return provider && ready(provider) ? [provider] : [];
  });
}
export function normalizeOtherModelRouting(value: unknown): OtherModelRouting | undefined {
  if (!value || typeof value !== "object") return;
  const routing: OtherModelRouting = {};
  for (const kind of ["text", "video", "audio"] as const) {
    const entry = normalizeImageRouting((value as Record<string, unknown>)[kind]);
    if (entry) routing[kind] = entry;
  }
  return routing;
}

/** Resolve nodes saved before model-based routing, using their old pair only as an alias. */
export function canvasImageModel(routing: ImageModelRouting, model?: string, providerId?: string): string {
  const name = model?.trim() ?? "";
  if (!name) return routing.defaultModel;
  return routing.models.find(item => item.name === name)?.name
    ?? routing.models.find(item => item.channels.some(channel => channel.providerId === providerId && channel.model === name))?.name
    ?? name;
}

export function normalizeImageRouting(value: unknown): ImageModelRouting | undefined {
  if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) return;
  const clean = (input: unknown) => typeof input === "string" ? input.trim().slice(0, 300) : "";
  const models: ImageModelRouting["models"] = [];
  for (const item of value.models.slice(0, 50)) {
    const name = clean(item?.name);
    if (!name || models.some(model => model.name === name) || !Array.isArray(item.channels)) continue;
    const channels: ImageChannel[] = [];
    for (const raw of item.channels.slice(0, 30)) {
      const providerId = clean(raw?.providerId);
      const model = clean(raw?.model);
      if (providerId && model && !channels.some(channel => channel.providerId === providerId && channel.model === model))
        channels.push({ providerId, model });
    }
    models.push({ name, channels });
  }
  const preferred = "defaultModel" in value ? clean(value.defaultModel) : "";
  return { models, defaultModel: models.find(model => model.name === preferred)?.name ?? models[0]?.name ?? "" };
}

export function imageChannelOptions(providers: readonly ProviderConfig[]): ImageChannel[] {
  return providers.filter(provider => provider.type !== "official").flatMap(provider => (
    getProviderModels(provider).map(model => ({ providerId: provider.id, model }))
  ));
}

export function resolveImageRouting(saved: ImageModelRouting | undefined, providers: readonly ProviderConfig[], activeProviderId: string): ImageModelRouting {
  if (saved) return saved;
  const primary = providers.find(provider => provider.id === activeProviderId);
  const channels = imageChannelOptions(primary ? [primary, ...providers.filter(provider => provider !== primary)] : providers);
  return groupModelChannels(channels, primary?.model);
}

export function groupModelChannels(channels: ImageChannel[], preferredModel?: string): ImageModelRouting {
  const models: ImageModelRouting["models"] = [];
  for (const channel of channels) {
    const existing = models.find(model => model.name === channel.model);
    if (existing) existing.channels.push(channel);
    else models.push({ name: channel.model, channels: [channel] });
  }
  return { models, defaultModel: preferredModel && models.some(model => model.name === preferredModel)
    ? preferredModel : models[0]?.name ?? "" };
}
