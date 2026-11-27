import type { AppSettings } from "../../shared/contracts/settings.js";
import type { CompanySession } from "../../shared/company-account.js";
import { isSeedanceGateway } from "../../shared/contracts/providers.js";
import channelProtocols from "../../shared/contracts/tuda-managed-channel-protocols.json" with { type: "json" };
import { isImageTaskEndpoint, isImageTaskProtocol } from "../../shared/image-task-protocol.js";
import type { ImageModelRouting } from "../../shared/image-routing.js";
import { normalizeVideoProviderModelOption, seedanceGatewayModelOption } from "../../shared/video-provider-models.js";

const kinds = ["text", "image", "video", "audio"] as const;
type Kind = typeof kinds[number];
type ProviderLists = Pick<AppSettings, "textProviders" | "providers" | "videoProviders"> &
  { audioProviders: NonNullable<AppSettings["audioProviders"]> };
export type ManagedModels = ProviderLists & {
  version: string;
  routing: Record<Kind, ImageModelRouting>;
  keys: Record<string, string>;
};

const { adapters } = channelProtocols;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const invalid = () => new Error("山海模型配置无效。");
function text(value: unknown, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n]/u.test(value)) throw invalid();
  return value.trim();
}
function id(value: unknown): string {
  const clean = text(value, 96);
  if (!/^[A-Za-z0-9_-]+$/u.test(clean)) throw invalid();
  return clean;
}
function endpoint(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  const clean = text(value);
  if (!/^\/(?!\/)[^?#\\\s]*$/u.test(clean) || clean.includes("..")) throw invalid();
  return clean;
}

export function validateManagedModels(value: unknown, session: CompanySession, version: string): ManagedModels {
  if (!isRecord(value) || value.contract !== 1 || value.appId !== "tuda" || value.sessionId !== session.sessionId ||
      value.organizationId !== session.organization.id || value.memberId !== session.member.id ||
      text(value.configVersion) !== version || !isRecord(value.models)) throw invalid();
  const providers: ProviderLists = { textProviders: [], providers: [], videoProviders: [], audioProviders: [] };
  const routing = {} as ManagedModels["routing"];
  const keys = Object.create(null) as Record<string, string>;
  const rawIds = new Set<string>();
  for (const kind of kinds) {
    const dir = value.models[kind];
    if (!isRecord(dir) || !Array.isArray(dir.items) || dir.items.length > 50) throw invalid();
    const models: Array<{ id: string; name: string }> = [];
    const defaultModelId = dir.defaultModelId === null ? null : id(dir.defaultModelId);
    const routes: ImageModelRouting["models"] = [];
    for (const item of dir.items) {
      if (!isRecord(item) || !Array.isArray(item.channels) || item.channels.length < 1 || item.channels.length > 30) throw invalid();
      const modelId = id(item.id), name = text(item.name);
      if (models.some(model => model.id === modelId || model.name.toLowerCase() === name.toLowerCase())) throw invalid();
      const refs: ImageModelRouting["models"][number]["channels"] = [];
      for (const channel of item.channels) {
        if (!isRecord(channel)) throw invalid();
        const channelId = id(channel.id);
        if (rawIds.has(channelId)) throw invalid();
        rawIds.add(channelId);
        const adapter = text(channel.adapter);
        if (!Object.hasOwn(adapters[kind], adapter) && !(kind === "image" && adapter === "openai-compatible")) throw invalid();
        const taskProtocol = channel.imageTaskProtocol;
        if (taskProtocol !== undefined && (kind !== "image" || adapter === "responses" ||
            !isImageTaskProtocol(taskProtocol))) throw invalid();
        const taskEndpoint = channel.imageTaskEndpoint === undefined ? undefined : text(channel.imageTaskEndpoint);
        if (taskEndpoint !== undefined && (kind !== "image" || (taskProtocol !== "task-id" && taskProtocol !== "business-id") ||
            !isImageTaskEndpoint(taskEndpoint))) throw invalid();
        let url: URL;
        try { url = new URL(text(channel.baseUrl)); } catch { throw invalid(); }
        const allowsHttp = kind === "image" || kind === "video";
        if ((url.protocol !== "https:" && !(allowsHttp && url.protocol === "http:")) ||
            url.username || url.password || /[?#]/u.test(url.href)) throw invalid();
        const apiKey = text(channel.apiKey, 8192);
        const provider = { id: `company-${kind}/sync/${channelId}`, name: text(channel.name),
          model: text(channel.model), baseUrl: url.href.replace(/\/$/u, "") };
        keys[provider.id] = apiKey;
        refs.push({ providerId: provider.id, model: provider.model });
        if (kind === "text") providers.textProviders.push({ ...provider, type: "openai-compatible",
          protocol: adapter as keyof typeof adapters.text, transport: "company-direct", managed: true });
        if (kind === "image") providers.providers.push({ ...provider, type: "openai-compatible",
          apiMode: adapter === "responses" ? "responses" : "images",
          ...(taskProtocol === undefined ? {} : { imageTaskProtocol: taskProtocol }),
          ...(taskEndpoint === undefined ? {} : { imageTaskEndpoint: taskEndpoint }),
          generationEndpoint: endpoint(channel.generationEndpoint, adapter === "responses" ? "/v1/responses" : "/v1/images/generations"),
          referenceEndpoint: endpoint(channel.referenceEndpoint, "/v1/images/edits"),
          supportsReferenceImages: channel.supportsReferenceImages === true });
        if (kind === "video") {
          const type = adapter as keyof typeof adapters.video;
          const option = channel.modelOption === undefined ? undefined : normalizeVideoProviderModelOption(channel.modelOption);
          if (option === null || (option && option.id !== provider.model)) throw invalid();
          const effective = option ?? (isSeedanceGateway(type) ? seedanceGatewayModelOption(type, provider.model) : undefined);
          providers.videoProviders.push({ ...provider, type, ...(effective ? { modelOptions: [effective] } : {}) });
        }
        if (kind === "audio") providers.audioProviders.push({ ...provider, type: "openai-compatible",
          voice: channel.voice === undefined ? "alloy" : text(channel.voice),
          speechEndpoint: endpoint(channel.speechEndpoint, "/v1/audio/speech") });
      }
      models.push({ id: modelId, name });
      routes.push({ name, channels: refs });
    }
    const preferred = models.find(model => model.id === defaultModelId);
    if (models.length ? !preferred : defaultModelId !== null) throw invalid();
    routing[kind] = { models: routes, defaultModel: preferred?.name ?? "" };
  }
  return { version, routing, keys, ...providers };
}

export function mergeManagedRouting(managed: ImageModelRouting, personal: ImageModelRouting | undefined, preferPersonal = false): ImageModelRouting {
  const names = new Set(managed.models.map(model => model.name.toLowerCase()));
  const mapped = personal?.models.map(model => {
    let name = model.name;
    if (names.has(name.toLowerCase())) {
      name += " · 个人";
      while (names.has(name.toLowerCase())) name += " · 个人";
    }
    names.add(name.toLowerCase());
    return { ...model, name };
  }) ?? [];
  const personalDefault = mapped[personal?.models.findIndex(model => model.name === personal.defaultModel) ?? -1]?.name ?? "";
  return { models: [...managed.models, ...mapped],
    defaultModel: (preferPersonal && personalDefault) || managed.defaultModel || personalDefault };
}
