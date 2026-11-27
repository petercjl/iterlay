import { randomUUID } from "node:crypto";
import { COMMUNITY_IMAGE_PROVIDER, COMMUNITY_TEXT_PROVIDER } from "../shared/community-providers.js";
import type { AudioProviderConfig, ProviderConfig, TextProviderConfig, VideoProviderConfig } from "../shared/types.js";
import type { SettingsStore } from "./storage/settings-store.js";
import type { AppSettings, AppSettingsPatch, NewModelChannel, SaveModelRoutingInput } from "../shared/contracts/settings.js";
import { isCompanyModelChannel, isSeedanceGateway } from "../shared/contracts/providers.js";
import { getProviderModels } from "../shared/provider-models.js";
import { isImageTaskEndpoint, isImageTaskProtocol } from "../shared/image-task-protocol.js";
import { normalizeImageRouting, normalizeOtherModelRouting, findTextModelRoute, textModelRouteId, type ImageModelRouting } from "../shared/image-routing.js";

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error(`${label} 必须是非空字符串（最多 4096 字符）。`);
  return value.trim();
}

type ModelChannelProvider = ProviderConfig | TextProviderConfig | AudioProviderConfig | VideoProviderConfig;
function isLocalKeyChannel(provider: ModelChannelProvider | undefined): provider is ModelChannelProvider {
  return Boolean(provider && !isCompanyModelChannel(provider.id) && provider.type !== "official" && provider.type !== "codex-oauth"
    && !("managed" in provider && provider.managed) && !("transport" in provider && provider.transport));
}

export function revealLocalModelChannelKey(store: SettingsStore, kind: NewModelChannel["kind"], providerId: string): string {
  const settings = store.getSettings();
  const providers = { text: settings.textProviders, image: settings.providers, video: settings.videoProviders, audio: settings.audioProviders ?? [] };
  if (!Object.hasOwn(providers, kind) || typeof providerId !== "string" || isCompanyModelChannel(providerId))
    throw new Error("只能查看本机渠道的 API Key。");
  const provider = providers[kind].find(candidate => candidate.id === providerId);
  if (!isLocalKeyChannel(provider)) throw new Error("只能查看本机渠道的 API Key。");
  const owner = "connectionProviderId" in provider && provider.connectionProviderId
    ? settings.providers.find(candidate => candidate.id === provider.connectionProviderId) : provider;
  if (!isLocalKeyChannel(owner)) throw new Error("只能查看本机渠道的 API Key。");
  return store.getApiKey(owner.id);
}

function managedRoutes(routing: ImageModelRouting | undefined) {
  return (routing?.models ?? []).flatMap(model => {
    const channels = model.channels.filter(channel => isCompanyModelChannel(channel.providerId));
    return channels.length ? [[model.name, channels]] : [];
  });
}

export function assertManagedModelRouting(current: AppSettings, patch: AppSettingsPatch): void {
  const routes = { ...normalizeOtherModelRouting(patch.otherModelRouting), image: normalizeImageRouting(patch.imageRouting) };
  const before = current.personalModelRouting
    ? { ...current.personalModelRouting.other, image: current.personalModelRouting.image }
    : { ...current.otherModelRouting, image: current.imageRouting };
  for (const kind of ["text", "image", "video", "audio"] as const) {
    if (routes[kind] && JSON.stringify(managedRoutes(routes[kind])) !== JSON.stringify(managedRoutes(before[kind])))
      throw new Error("山海管理的渠道由企业管理员配置。");
  }
}

/** Save local connections and their routing references as one settings transaction. */
export async function saveLocalModelRouting(store: SettingsStore, input: SaveModelRoutingInput): Promise<void> {
  if (!input || !Array.isArray(input.channels) || input.channels.length > 100)
    throw new Error("模型渠道配置无效。");
  if (input.applyDefaults !== undefined && (!Array.isArray(input.applyDefaults) || input.applyDefaults.length > 3 ||
    input.applyDefaults.some(kind => kind !== "text" && kind !== "video" && kind !== "audio"))) throw new Error("默认模型配置无效。");
  const imageRouting = normalizeImageRouting(input.imageRouting);
  const otherModelRouting = normalizeOtherModelRouting(input.otherModelRouting);
  await store.transaction(async () => {
    const current = store.getSettings();
    const providers = { image: new Map(current.providers.map(p => [p.id, p])), text: new Map(current.textProviders.map(p => [p.id, p])),
      video: new Map(current.videoProviders.map(p => [p.id, p])), audio: new Map((current.audioProviders ?? []).map(p => [p.id, p])) };
    const providerIds = new Set(Object.values(providers).flatMap(list => [...list.keys()]));
    const changes = new Set<string>();
    const keys = new Map<string, string>();
    const routes = { ...otherModelRouting, image: imageRouting };
    const before = current.personalModelRouting
      ? { ...current.personalModelRouting.other, image: current.personalModelRouting.image }
      : { ...current.otherModelRouting, image: current.imageRouting };
    assertManagedModelRouting(current, input);
    for (const channel of input.channels) {
      const { providerId, kind, protocol, sourceProviderId } = channel ?? {};
      if (!/^local-channel-[a-f0-9-]{36}$/u.test(providerId ?? "") || changes.has(providerId)) throw new Error("模型渠道标识无效或已存在。");
      if (kind !== "image" && kind !== "text" && kind !== "video" && kind !== "audio") throw new Error("模型渠道类型无效。");
      const source = sourceProviderId ? providers[kind].get(sourceProviderId) : undefined;
      if (sourceProviderId && !isLocalKeyChannel(source))
        throw new Error("此模型渠道无法在本机编辑。");
      if (providerIds.has(providerId) && (sourceProviderId !== providerId ||
        (before[kind]?.models.flatMap(model => model.channels).filter(ref => ref.providerId === providerId).length ?? 0) > 1))
        throw new Error("模型渠道标识无效或已存在。");
      const name = text(channel.name, "渠道名称");
      const model = text(channel.model, "模型 ID");
      let base: URL;
      try { base = new URL(channel.baseUrl); } catch { throw new Error("Base URL 必须是有效的 HTTP(S) 地址。"); }
      if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
        throw new Error("Base URL 必须是无凭证、查询参数和片段的 HTTP(S) 地址。");
      const owners = routes[kind]?.models.filter(item => item.channels.some(ref => ref.providerId === providerId));
      const owner = owners?.[0];
      if (owners?.length !== 1 || owner?.channels.filter(ref => ref.providerId === providerId).length !== 1
        || !owner.channels.some(ref => ref.providerId === providerId && ref.model === model)) throw new Error("每条渠道只属于一个模型。");
      if (source && !(before[kind]
        ? before[kind].models.some(item => item.name === owner.name && item.channels.some(ref => ref.providerId === source.id))
        : getProviderModels(source).includes(owner.name))) throw new Error("只能编辑当前模型已有的渠道。");
      const sourceOwner = source && "connectionProviderId" in source && source.connectionProviderId
        ? providers.image.get(source.connectionProviderId) : source;
      if (sourceOwner && !isLocalKeyChannel(sourceOwner)) throw new Error("山海管理的渠道由企业管理员配置。");
      const apiKey = channel.apiKey === undefined ? undefined : text(channel.apiKey, "API Key");
      if (!apiKey && (!sourceOwner || new URL(sourceOwner.baseUrl).origin !== base.origin))
        throw new Error("新增渠道或更换服务地址域名时请填写 API Key。");
      const savedKey = apiKey ?? (providerId !== sourceOwner?.id ? store.getApiKey(sourceOwner?.id) : undefined);
      const connection = { id: providerId, name, baseUrl: base.href.replace(/\/$/, ""), model };
      if (kind === "image") {
        if (protocol !== "images" && protocol !== "responses") throw new Error("图片服务协议无效。");
        const old = sourceProviderId ? providers.image.get(sourceProviderId) : undefined;
        providers.image.set(providerId, { ...old, ...connection, type: old?.type ?? "openai-compatible", apiMode: protocol, models: [model],
          generationEndpoint: old && (old.apiMode ?? "images") === protocol ? old.generationEndpoint : protocol === "responses" ? "/v1/responses" : "/v1/images/generations",
          referenceEndpoint: old?.referenceEndpoint ?? "/v1/images/edits", supportsReferenceImages: channel.supportsReferenceImages === true });
      } else if (kind === "text") {
        if (protocol !== "openai-chat-completions" && protocol !== "openai-responses" && protocol !== "anthropic-messages")
          throw new Error("文本服务协议无效。");
        providers.text.set(providerId, { ...connection, type: "openai-compatible", protocol });
      } else if (kind === "video") {
        if (protocol !== "ark" && protocol !== "fal" && protocol !== "openrouter" && protocol !== "minimax" && !isSeedanceGateway(protocol)) throw new Error("视频服务协议无效。");
        if (source && source.type !== protocol && !apiKey) throw new Error("更换视频协议时请填写 API Key。");
        const old = sourceProviderId ? providers.video.get(sourceProviderId) : undefined;
        providers.video.set(providerId, { ...connection, type: protocol, models: [model],
          modelOptions: old?.type === protocol ? old.modelOptions?.filter(option => option.id === model) : undefined });
      } else {
        if (protocol !== "openai-speech") throw new Error("音频服务协议无效。");
        const old = sourceProviderId ? providers.audio.get(sourceProviderId) : undefined;
        providers.audio.set(providerId, { ...connection, type: "openai-compatible", models: [model],
          speechEndpoint: old?.speechEndpoint ?? "/v1/audio/speech", voice: text(channel.voice ?? old?.voice ?? "alloy", "音色") });
      }
      if (savedKey) keys.set(providerId, savedKey);
      changes.add(providerId);
      providerIds.add(providerId);
    }
    const keyStatus = store.getKeyStatus();
    const texts = [...providers.text.values()];
    const textRouting = otherModelRouting?.text;
    const usableRoutes = textRouting?.models.filter(model => model.channels.some(channel => {
      const provider = providers.text.get(channel.providerId);
      return provider?.model === channel.model && (keys.has(provider.id) || keyStatus[provider.id] || provider.type === "codex-oauth");
    }));
    const preferred = usableRoutes?.find(model => model.name === textRouting?.defaultModel) ?? usableRoutes?.[0];
    const shouldApplyDefault = (kind: "text" | "video" | "audio") => input.applyDefaults?.includes(kind);
    const selectedText = shouldApplyDefault("text") ? usableRoutes?.find(model => model.name === textRouting?.defaultModel) : undefined;
    if (shouldApplyDefault("text") && !selectedText) throw new Error("请为默认文本模型配置可用渠道。");
    function selectMediaDefault(kind: "video" | "audio") {
      if (!shouldApplyDefault(kind)) return;
      const route = routes[kind]?.models.find(model => model.name === routes[kind]?.defaultModel);
      const selected = route?.channels.find(channel => {
        const provider = providers[kind].get(channel.providerId);
        return provider && getProviderModels(provider).includes(channel.model) && (keys.has(provider.id) || keyStatus[provider.id]);
      });
      if (!selected) throw new Error(kind === "video" ? "请为默认视频模型配置可用渠道。" : "请为默认音频模型配置可用渠道。");
      return selected;
    }
    const video = selectMediaDefault("video");
    const audio = selectMediaDefault("audio");
    if (video) providers.video.set(video.providerId, { ...providers.video.get(video.providerId)!, model: video.model });
    if (audio) providers.audio.set(audio.providerId, { ...providers.audio.get(audio.providerId)!, model: audio.model });
    const editedActive = usableRoutes?.find(model => model.channels.some(ref => input.channels.some(channel =>
      channel.kind === "text" && channel.sourceProviderId === current.activeTextProviderId && channel.providerId === ref.providerId)));
    const selectText = preferred && !findTextModelRoute(otherModelRouting, current.activeTextProviderId)
      && !texts.some(provider => provider.id === current.activeTextProviderId && (keyStatus[provider.id] || provider.type === "codex-oauth"));
    const activeTextRoute = selectedText ?? editedActive ?? (selectText ? preferred : undefined);
    await store.updateSettings({
      ...(input.channels.some(channel => channel.kind === "image") ? { providers: [...providers.image.values()] } : {}),
      ...(input.channels.some(channel => channel.kind === "text") ? { textProviders: texts } : {}),
      ...(video || input.channels.some(channel => channel.kind === "video") ? { videoProviders: [...providers.video.values()] } : {}),
      ...(audio || input.channels.some(channel => channel.kind === "audio") ? { audioProviders: [...providers.audio.values()] } : {}),
      ...(imageRouting ? { imageRouting } : {}),
      ...(otherModelRouting ? { otherModelRouting: {
        ...(current.personalModelRouting ? current.personalModelRouting.other : current.otherModelRouting), ...otherModelRouting
      } } : {}),
      ...(activeTextRoute ? { activeTextProviderId: textModelRouteId(activeTextRoute.name) } : {}),
      ...(video ? { activeVideoProviderId: video.providerId } : {}),
      ...(audio ? { activeAudioProviderId: audio.providerId } : {})
    });
    for (const [id, key] of keys) store.setApiKey(id, key);
  });
}

/** 在同一事务内读取最新设置并修改，避免 CLI 并发更新覆盖其它 Provider。 */
export async function configureProvider(store: SettingsStore, input: Record<string, unknown>) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("配置参数必须是对象。");
  if (input.kind === "text" || input.kind === "image") return configureOpenAIProvider(store, input, input.kind);
  const allowed = new Set(["kind", "action", "providerId", "name", "type", "baseUrl", "model", "models", "voice", "speechEndpoint", "connectionProviderId", "apiKey", "setDefault"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("未知 Provider 配置字段。");
  if (input.kind !== "video" && input.kind !== "audio") throw new Error("配置 kind 必须为 video 或 audio。");
  const kind = input.kind;
  const action = input.action ?? "upsert";
  if (typeof action !== "string" || !["upsert", "default", "remove"].includes(action)) throw new Error("未知 Provider 配置操作。");
  if (input.setDefault !== undefined && typeof input.setDefault !== "boolean") throw new Error("setDefault 必须为布尔值。");
  if (input.apiKey !== undefined && (typeof input.apiKey !== "string" || input.apiKey.length > 100_000)) throw new Error("API Key 格式无效。");
  return store.transaction(() => {
    const settings = store.getSettings();
    const list = kind === "video" ? settings.videoProviders : settings.audioProviders ?? [];
    const id = input.providerId === undefined ? `${kind}-${randomUUID()}` : text(input.providerId, "Provider ID");
    if (!/^[\w.-]+$/u.test(id)) throw new Error("Provider ID 只能包含字母、数字、下划线、点和连字符。");
    const previous = list.find((p) => p.id === id);
    const all = [...settings.providers, ...settings.textProviders, ...settings.videoProviders, ...(settings.audioProviders ?? [])];
    if (!previous && all.some((p) => p.id === id)) throw new Error("Provider ID 已用于其它类型。");
    if (previous?.type === "official") throw new Error("不能修改内置官方 Provider。");
    if (action !== "upsert" && !previous) throw new Error("Provider 不存在。");
    let config: VideoProviderConfig | AudioProviderConfig | undefined = previous;
    if (action === "upsert") {
      const type = input.type ?? previous?.type ?? (kind === "audio" ? "openai-compatible" : undefined);
      if (!(kind === "audio" ? ["openai-compatible"] : ["ark", "fal", "openrouter", "minimax"]).includes(String(type)) && !(kind === "video" && isSeedanceGateway(type))) throw new Error("Provider 类型无效。");
      if (previous && type !== previous.type) throw new Error("不能更改已有 Provider 的协议类型，请新增 Provider。");
      const baseUrl = text(input.baseUrl ?? previous?.baseUrl, "baseUrl");
      let url: URL;
      try { url = new URL(baseUrl); } catch { throw new Error("baseUrl 必须是 HTTP(S) 地址。"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("baseUrl 必须是无凭证、查询参数和片段的 HTTP(S) 地址。");
      const model = text(input.model ?? previous?.model, "model");
      const models = input.models ?? previous?.models ?? [];
      if (!Array.isArray(models) || models.length > 1000) throw new Error("models 必须是最多 1000 项的数组。");
      config = { ...previous, id, name: text(input.name ?? previous?.name ?? id, "name"), type, baseUrl, model,
        models: [...new Set([model, ...models.map((m) => text(m, "model"))])] } as VideoProviderConfig | AudioProviderConfig;
      if (kind === "audio") {
        if (input.connectionProviderId !== undefined) throw new Error("音频 Provider 不支持复用图片连接。");
        const old = previous as AudioProviderConfig | undefined;
        if (old && url.origin !== new URL(old.baseUrl).origin && input.apiKey === undefined)
          throw new Error("更换服务地址域名时请同时提供 API Key。");
        const endpoint = text(input.speechEndpoint ?? old?.speechEndpoint ?? "/v1/audio/speech", "speechEndpoint");
        if (!/^\/(?!\/)[^?#\\\s]*$/u.test(endpoint) || endpoint.includes("..")) throw new Error("speechEndpoint 必须是接口相对路径。");
        config = { ...config, type: "openai-compatible", voice: text(input.voice ?? old?.voice ?? "alloy", "voice"), speechEndpoint: endpoint };
      } else {
        if (input.voice !== undefined || input.speechEndpoint !== undefined) throw new Error("voice 和 speechEndpoint 仅用于 audio。");
        if (input.connectionProviderId !== undefined) (config as VideoProviderConfig).connectionProviderId = typeof input.connectionProviderId === "string" ? input.connectionProviderId.trim() : text(input.connectionProviderId, "connectionProviderId");
        const ownerId = (config as VideoProviderConfig).connectionProviderId;
        if (ownerId && (!["fal", "openrouter"].includes(String(type)) || !settings.providers.some((p) => p.id === ownerId && p.type === type))) throw new Error("关联图片 Provider 不存在或类型不匹配。");
        if (ownerId && input.apiKey !== undefined) throw new Error("此视频 Provider 复用图片凭证；请先清空 connectionProviderId 再设置独立密钥。");
      }
    } else if (Object.keys(input).some((key) => !["kind", "action", "providerId"].includes(key))) throw new Error("默认/删除操作不接受其它配置字段。");
    const next: Array<VideoProviderConfig | AudioProviderConfig> = action === "remove"
      ? list.filter((p) => p.id !== id)
      : previous ? list.map((p) => p.id === id ? config! : p) : [...list, config!];
    const active = kind === "video" ? settings.activeVideoProviderId : settings.activeAudioProviderId;
    const activeId = action === "default" || input.setDefault === true || !active ? id : active;
    store.updateSettings(kind === "video"
      ? { videoProviders: next as VideoProviderConfig[], activeVideoProviderId: activeId }
      : { audioProviders: next as AudioProviderConfig[], activeAudioProviderId: activeId });
    if (action === "upsert" && typeof input.apiKey === "string") store.setApiKey(id, input.apiKey);
    return { providerId: id, kind, removed: action === "remove", authConfigured: Boolean(store.getKeyStatus()[id]) };
  });
}

function configureOpenAIProvider(store: SettingsStore, input: Record<string, unknown>, kind: "image" | "text") {
  const isImage = kind === "image";
  const allowed = new Set(["kind", "action", "providerId", "name", "baseUrl", "model", "apiKey", "setDefault",
    ...(isImage ? ["apiMode", "generationEndpoint", "referenceEndpoint", "supportsReferenceImages", "imageTaskProtocol", "imageTaskEndpoint"] : ["protocol"])]);
  if (Object.keys(input).some(key => !allowed.has(key)) || (input.action !== undefined && input.action !== "upsert"))
    throw new Error("模型服务配置参数无效。");
  const id = text(input.providerId, "Provider ID");
  if (!/^[\w.-]+$/u.test(id)) throw new Error("Provider ID 格式无效。");
  const protocol = input.protocol ?? "openai-chat-completions";
  if (protocol !== "openai-chat-completions" && protocol !== "openai-responses" && protocol !== "anthropic-messages")
    throw new Error("文本服务协议无效。");
  const apiKey = input.apiKey;
  if (input.setDefault !== undefined && typeof input.setDefault !== "boolean")
    throw new Error("setDefault 必须为布尔值。");
  if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 100_000))
    throw new Error("API Key 格式无效。");
  if (input.supportsReferenceImages !== undefined && typeof input.supportsReferenceImages !== "boolean")
    throw new Error("supportsReferenceImages 必须为布尔值。");
  return store.transaction(async () => {
    const current = store.getSettings();
    const list = isImage ? current.providers : current.textProviders;
    const others = isImage ? current.textProviders : current.providers;
    if ([...others, ...current.audioProviders ?? [], ...current.videoProviders].some(provider => provider.id === id))
      throw new Error("Provider ID 已用于其他类型。");
    const previous = list.find(provider => provider.id === id);
    if (previous && (("managed" in previous && previous.managed) || previous.transport || previous.type !== "openai-compatible"))
      throw new Error("该服务由其他来源管理。");
    if (isImage && !previous && input.baseUrl === undefined) throw new Error("新增图片渠道时请提供 Base URL。");
    let base: URL;
    try { base = new URL(text(input.baseUrl ?? (isImage ? previous?.baseUrl : undefined), "Base URL")); }
    catch { throw new Error("Base URL 必须是有效的 HTTP(S) 地址。"); }
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new Error("Base URL 必须是无凭证、查询参数和片段的 HTTP(S) 地址。");
    const connection = {
      id, type: "openai-compatible" as const,
      name: text(input.name ?? (isImage ? previous?.name ?? id : undefined), "服务名称"),
      baseUrl: base.href.replace(/\/$/, ""), model: text(input.model ?? (isImage ? previous?.model : undefined), "模型 ID")
    };
    if (previous && new URL(previous.baseUrl).origin !== base.origin && apiKey === undefined)
      throw new Error("更换服务地址域名时请同时提供 API Key。");
    const preset = isImage ? COMMUNITY_IMAGE_PROVIDER : COMMUNITY_TEXT_PROVIDER;
    const providers = list.filter(provider => !(provider.id === preset.id &&
      provider.name === preset.name && provider.baseUrl === preset.baseUrl && provider.model === preset.model &&
      !store.getApiKey(provider.id))).filter(provider => provider.id !== id);
    const setDefault = input.setDefault === true;
    if (isImage) {
      const old = previous as ProviderConfig | undefined;
      const apiMode = input.apiMode ?? old?.apiMode ?? "images";
      if (apiMode !== "images" && apiMode !== "responses") throw new Error("图片服务协议必须为 images 或 responses。");
      const sameMode = old?.apiMode === apiMode;
      const taskProtocol = input.imageTaskProtocol ?? (sameMode ? old.imageTaskProtocol : undefined);
      if (taskProtocol !== undefined && (apiMode !== "images" || !isImageTaskProtocol(taskProtocol)))
        throw new Error("图片任务协议仅用于 OpenAI Images，须为 sync、task-id 或 business-id。");
      const asyncTask = taskProtocol === "task-id" || taskProtocol === "business-id";
      const taskEndpoint = input.imageTaskEndpoint === null ? undefined : input.imageTaskEndpoint ??
        (asyncTask && sameMode ? old.imageTaskEndpoint : undefined);
      if (taskEndpoint !== undefined && (!asyncTask || typeof taskEndpoint !== "string" ||
          taskEndpoint.length > 300 || !isImageTaskEndpoint(taskEndpoint)))
        throw new Error("异步任务查询路径必须为包含 {id} 的同源路径。");
      const image: ProviderConfig = {
        ...old, ...connection, apiMode, imageTaskProtocol: taskProtocol, imageTaskEndpoint: taskEndpoint,
        generationEndpoint: relativeImageEndpoint(input.generationEndpoint ?? (sameMode ? old.generationEndpoint : undefined),
          apiMode === "responses" ? "/v1/responses" : "/v1/images/generations"),
        referenceEndpoint: input.referenceEndpoint === undefined
          ? old?.referenceEndpoint ?? "/v1/images/edits" : relativeImageEndpoint(input.referenceEndpoint, "/v1/images/edits"),
        supportsReferenceImages: (input.supportsReferenceImages as boolean | undefined) ?? old?.supportsReferenceImages ?? false
      };
      const routing = current.personalModelRouting ? current.personalModelRouting.image : current.imageRouting;
      const models = routing?.models.map(route => ({
        ...route, channels: route.channels.map(channel => channel.providerId === id && channel.model === old?.model
          ? { providerId: id, model: image.model } : channel)
      }));
      let defaultModel = routing?.defaultModel ?? "";
      if (models && setDefault) {
        const selected = models.find(route => route.channels.some(channel => channel.providerId === id && channel.model === image.model));
        if (selected) {
          selected.channels.sort((left, right) =>
            Number(right.providerId === id && right.model === image.model) - Number(left.providerId === id && left.model === image.model));
          defaultModel = selected.name;
        } else {
          if (models.length >= 50 || image.model.length > 300 || id.length > 300) throw new Error("无法新增默认图片模型路由。");
          const sameName = models.find(route => route.name === image.model);
          const channel = { providerId: id, model: image.model };
          if (sameName) {
            if (sameName.channels.length >= 30) throw new Error("默认图片模型的渠道已满。");
            sameName.channels.unshift(channel);
          } else models.push({ name: image.model, channels: [channel] });
          defaultModel = image.model;
        }
      }
      await store.updateSettings({ providers: [...providers as ProviderConfig[], image],
        ...(models ? { imageRouting: { models, defaultModel } } : {}), ...(setDefault ? { activeProviderId: id } : {}) });
    } else {
      const config: TextProviderConfig = { ...connection, protocol };
      await store.updateSettings({ textProviders: [...providers as TextProviderConfig[], config], ...(setDefault ? { activeTextProviderId: id } : {}) });
    }
    if (typeof apiKey === "string") store.setApiKey(id, apiKey);
    return { providerId: id, kind, authConfigured: Boolean(store.getKeyStatus()[id]) };
  });
}

function relativeImageEndpoint(value: unknown, fallback: string): string {
  const endpoint = value === undefined ? fallback : text(value, "图片接口路径");
  if (endpoint.length > 300 || !/^\/(?!\/)[^?#\\\s]*$/u.test(endpoint) || endpoint.includes(".."))
    throw new Error("图片接口路径必须是同源路径，例如 /v1/images/generations。");
  return endpoint;
}
