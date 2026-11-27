import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/u, "")
} }));
import { safeStorage } from "electron";
import { SettingsStore } from "../electron/storage/settings-store.js";
import { configureProvider, revealLocalModelChannelKey, saveLocalModelRouting } from "../electron/provider-settings.js";
import { textModelRouteId } from "../shared/image-routing.js";
import { workspaceFixture } from "./helpers/workspace-fixture.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-provider-config-"));
  vi.restoreAllMocks();
  directories.push(directory);
  return { directory, store: new SettingsStore(directory) };
}
const audio = { kind: "audio", providerId: "tts", baseUrl: "https://example.com", model: "tts-model", voice: "nova" };
const video = { kind: "video", providerId: "video", type: "openrouter", baseUrl: "https://openrouter.ai/api", model: "vendor/video" };

describe("CLI Provider configuration", () => {
  it("saves and incrementally changes a local image task protocol without exposing or replacing its key", async () => {
    const { store, directory } = await fixture();
    const config = { kind: "image", providerId: "local-relay", baseUrl: "https://relay.example/v1",
      model: "upstream-image", apiMode: "images", generationEndpoint: "/v1/create",
      referenceEndpoint: "/v1/edit", imageTaskProtocol: "business-id", imageTaskEndpoint: "/v1/jobs/{id}",
      supportsReferenceImages: true, apiKey: "fixture-image-key", setDefault: true };
    await configureProvider(store, config);
    await configureProvider(store, { kind: "image", providerId: config.providerId, name: "Updated name" });
    const loaded = new SettingsStore(directory);
    const settings = loaded.getSettings();
    expect(settings.activeProviderId).toBe(config.providerId);
    expect(loaded.getApiKey(config.providerId)).toBe(config.apiKey);
    const { mocks, commands } = workspaceFixture();
    mocks.getSettings.mockResolvedValue({ ...settings, providerKeyStatus: loaded.getKeyStatus() });
    const readback = await commands.call("get_provider", { providerId: config.providerId });
    expect(readback).toMatchObject({ name: "Updated name", model: config.model, apiMode: "images",
      imageTaskProtocol: config.imageTaskProtocol, imageTaskEndpoint: config.imageTaskEndpoint,
      generationEndpoint: config.generationEndpoint, referenceEndpoint: config.referenceEndpoint,
      supportsReferenceImages: true, authConfigured: true });
    expect(JSON.stringify(readback)).not.toContain(config.apiKey);
    const patch = { kind: "image", providerId: config.providerId };
    await expect(configureProvider(loaded, { ...patch, imageTaskEndpoint: "//other.example/{id}" })).rejects.toThrow("同源");
    await expect(configureProvider(loaded, { ...patch, apiMode: "responses", imageTaskProtocol: "business-id" })).rejects.toThrow("OpenAI Images");
    await expect(configureProvider(loaded, { ...patch, baseUrl: "https://other.example/v1" })).rejects.toThrow("API Key");
    await configureProvider(loaded, { ...patch, imageTaskEndpoint: null });
    expect(loaded.getSettings().providers.find(provider => provider.id === config.providerId)?.imageTaskEndpoint).toBeUndefined();
    await configureProvider(loaded, { ...patch, apiMode: "responses" });
    expect(loaded.getSettings().providers.find(provider => provider.id === config.providerId)).toMatchObject({
      apiMode: "responses", generationEndpoint: "/v1/responses", imageTaskProtocol: undefined
    });
  });

  it("switches existing text, video and audio defaults to the chosen models", async () => {
    const { store, directory } = await fixture();
    await configureProvider(store, { ...audio, models: ["voice-upstream"], apiKey: "fixture-audio", setDefault: true });
    await configureProvider(store, { ...video, models: ["video-upstream"], apiKey: "fixture-video", setDefault: true });
    for (const model of ["primary-text", "chosen-text"]) {
      await configureProvider(store, { kind: "text", providerId: model, name: model, model,
        baseUrl: "https://text.example/v1", apiKey: "fixture-text", setDefault: model === "primary-text" });
    }
    const route = (name: string, providerId: string, model: string) => ({ defaultModel: name,
      models: [{ name, channels: [{ providerId, model }] }] });
    await saveLocalModelRouting(store, { channels: [], applyDefaults: ["text", "video", "audio"], otherModelRouting: {
      text: route("我的文本", "chosen-text", "chosen-text"), video: route("我的视频", video.providerId, "video-upstream"),
      audio: route("我的音频", audio.providerId, "voice-upstream")
    } });
    expect(new SettingsStore(directory).getSettings()).toMatchObject({ activeTextProviderId: textModelRouteId("我的文本"),
      activeVideoProviderId: video.providerId, activeAudioProviderId: audio.providerId,
      audioProviders: [expect.objectContaining({ model: "voice-upstream" })],
      videoProviders: expect.arrayContaining([expect.objectContaining({ id: video.providerId, model: "video-upstream" })]) });
  });

  it("edits a legacy image channel for one model without changing the other model or requiring its key again", async () => {
    const { store, directory } = await fixture();
    const old = { providerId: "existing-image", model: "vendor-old" };
    await configureProvider(store, { kind: "image", ...old, name: "Original", baseUrl: "https://images.example/v1", apiKey: "fixture-old-key" });
    store.updateSettings({ imageRouting: { defaultModel: "Custom A", models: [
      { name: "Custom A", channels: [old] }, { name: "Custom B", channels: [old] }
    ] } });
    const providerId = `local-channel-${randomUUID()}`;
    const updated = { providerId, model: "vendor-new" };
    const imageRouting = { defaultModel: "Custom A", models: [
      { name: "Custom A", channels: [updated] }, { name: "Custom B", channels: [old] }
    ] };
    const edit = { kind: "image" as const, ...updated, sourceProviderId: old.providerId, name: "Independent",
      protocol: "images" as const, baseUrl: "https://images.example/api" };
    await saveLocalModelRouting(store, { channels: [edit], imageRouting });
    const loaded = new SettingsStore(directory);
    expect(loaded.getSettings().imageRouting).toEqual(imageRouting);
    expect(loaded.getSettings().providers.find(item => item.id === old.providerId)?.baseUrl).toBe("https://images.example/v1");
    expect(loaded.getApiKey(providerId)).toBe("fixture-old-key");
    expect(revealLocalModelChannelKey(loaded, "image", providerId)).toBe("fixture-old-key");
    expect(() => revealLocalModelChannelKey(loaded, "text", providerId)).toThrow("只能查看本机");
    const moved = { ...edit, sourceProviderId: providerId, baseUrl: "https://second.example/v1" };
    await expect(saveLocalModelRouting(loaded, { channels: [moved], imageRouting })).rejects.toThrow("填写 API Key");
    await saveLocalModelRouting(loaded, { channels: [{ ...moved, apiKey: "fixture-new-key" }], imageRouting });
    expect(loaded.getApiKey(providerId)).toBe("fixture-new-key");
    expect(loaded.getApiKey(old.providerId)).toBe("fixture-old-key");
  });

  it("rejects copying credentials from a managed channel and modifying its saved routing", async () => {
    const { store } = await fixture();
    const company = { id: "company-text/tenant/model", name: "Corporate", model: "vendor-model",
      baseUrl: "https://private.example", type: "openai-compatible" as const };
    const modelRoute = { name: "Corporate", channels: [{ providerId: company.id, model: company.model }] };
    store.updateSettings({ textProviders: [company], otherModelRouting: { text: { defaultModel: modelRoute.name, models: [modelRoute] } } });
    expect(() => revealLocalModelChannelKey(store, "text", company.id)).toThrow("只能查看本机");
    await expect(saveLocalModelRouting(store, { channels: [], otherModelRouting: { text: { defaultModel: "", models: [] } } })).rejects.toThrow("企业管理员");
    const providerId = `local-channel-${randomUUID()}`;
    const personal = { name: "Personal", channels: [{ providerId, model: company.model }] };
    await expect(saveLocalModelRouting(store, { channels: [{ providerId, sourceProviderId: company.id, kind: "text", model: company.model,
      name: "New", baseUrl: company.baseUrl, protocol: "openai-responses" }], otherModelRouting: {
      text: { defaultModel: modelRoute.name, models: [modelRoute, personal] }
    } })).rejects.toThrow("无法在本机编辑");
  });

  it("creates ordered local channels under custom model names and reloads their separate credentials", async () => {
    const { store, directory } = await fixture();
    const textName = "东轩 · 文本";
    const imageName = "东轩 · 生图";
    const channels = [
      { name: "Primary", kind: "text", protocol: "openai-responses", model: "vendor-text-x" },
      { name: "Backup", kind: "text", protocol: "anthropic-messages", model: "vendor-text-y" },
      { name: "Illustration", kind: "image", protocol: "images", model: "vendor-image-z" }
    ] as const;
    const input = channels.map((channel, index) => ({ ...channel, providerId: `local-channel-${randomUUID()}`,
      baseUrl: `https://service${index}.example/v1`, apiKey: `fixture-secret-${index}` }));
    const refs = input.map(({ providerId, model }) => ({ providerId, model }));
    const text = { defaultModel: textName, models: [{ name: textName, channels: refs.slice(0, 2) }] };
    const image = { defaultModel: imageName, models: [{ name: imageName, channels: refs.slice(2) }] };
    await saveLocalModelRouting(store, { channels: input, imageRouting: image, otherModelRouting: { text } });
    const loaded = new SettingsStore(directory);
    expect(loaded.getSettings()).toMatchObject({ imageRouting: image, otherModelRouting: { text }, activeTextProviderId: textModelRouteId(textName) });
    for (const channel of input) expect(loaded.getApiKey(channel.providerId)).toBe(channel.apiKey);
    expect(await readFile(path.join(directory, "settings.json"), "utf8")).not.toContain("fixture-secret-");
  });
  it("saves distinct text models with their relay names, credentials and explicit default", async () => {
    const { store, directory } = await fixture();
    const entries = [
      { providerId: "relay-a-text", name: "Relay A", baseUrl: "https://a.example/v1", model: "model-a", apiKey: "fixture-key-a", setDefault: true },
      { providerId: "relay-b-text", name: "Relay B", baseUrl: "https://b.example/v1", model: "model-b", apiKey: "fixture-key-b" }
    ];
    for (const entry of entries) {
      await expect(configureProvider(store, { kind: "text", ...entry })).resolves.toMatchObject({ authConfigured: true });
    }
    const loaded = new SettingsStore(directory);
    expect(loaded.getSettings().activeTextProviderId).toBe(entries[0].providerId);
    expect(loaded.getSettings().textProviders.map(({ id, name, model }) => ({ providerId: id, name, model }))).toEqual(
      entries.map(({ providerId, name, model }) => ({ providerId, name, model }))
    );
    for (const { providerId, apiKey } of entries) expect(loaded.getApiKey(providerId)).toBe(apiKey);
  });

  it("stores the same image model on two relays with separate keys and preserves text settings", async () => {
    const { store, directory } = await fixture();
    await configureProvider(store, { kind: "text", providerId: "relay-a-text", name: "Relay A",
      baseUrl: "https://a.example/v1", model: "chat-model", apiKey: "text-key" });
    for (const relay of ["a", "b"]) {
      await configureProvider(store, { kind: "image", providerId: `relay-${relay}-image`, name: `Relay ${relay}`,
        baseUrl: `https://${relay}.example/v1`, model: "same-image-model", apiKey: `image-key-${relay}`, setDefault: relay === "a" });
    }
    const loaded = new SettingsStore(directory);
    const settings = loaded.getSettings();
    expect(settings.activeProviderId).toBe("relay-a-image");
    expect(settings.providers.map(({ id, model, generationEndpoint }) => [id, model, generationEndpoint])).toEqual([
      ["relay-a-image", "same-image-model", "/v1/images/generations"],
      ["relay-b-image", "same-image-model", "/v1/images/generations"]
    ]);
    expect(loaded.getApiKey("relay-a-image")).toBe("image-key-a");
    expect(loaded.getApiKey("relay-b-image")).toBe("image-key-b");
    expect(loaded.getApiKey("relay-a-text")).toBe("text-key");
  });

  it("persists TTS, voice and encrypted credentials across reload and legacy UI saves", async () => {
    const { store, directory } = await fixture();
    const result = await configureProvider(store, { ...audio, apiKey: "test-secret", setDefault: true });
    expect(result).toMatchObject({ authConfigured: true, kind: "audio" });
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(await readFile(path.join(directory, "settings.json"), "utf8")).not.toContain("test-secret");
    await configureProvider(store, { kind: "audio", providerId: "tts", model: "new-model", voice: "echo" });
    const legacy = store.getSettings();
    delete legacy.audioProviders;
    delete legacy.activeAudioProviderId;
    store.saveSettings({ ...legacy, theme: "dark" });
    const reloaded = new SettingsStore(directory);
    expect(reloaded.getSettings()).toMatchObject({ theme: "dark", activeAudioProviderId: "tts", audioProviders: [{ model: "new-model", voice: "echo", speechEndpoint: "/v1/audio/speech" }] });
    expect(reloaded.getApiKey("tts")).toBe("test-secret");
    await configureProvider(reloaded, { kind: "audio", providerId: "tts", apiKey: "" });
    expect(new SettingsStore(directory).getKeyStatus().tts).toBe(false);
  });

  it("rolls back configuration changes if credential encryption fails", async () => {
    const { store, directory } = await fixture();
    await configureProvider(store, audio);
    const before = await readFile(path.join(directory, "settings.json"), "utf8");
    vi.spyOn(safeStorage, "isEncryptionAvailable").mockReturnValueOnce(false);
    await expect(configureProvider(store, { ...audio, voice: "changed", apiKey: "new-key" })).rejects.toThrow("无法安全保存");
    expect(store.getSettings().audioProviders?.[0].voice).toBe("nova");
    expect(await readFile(path.join(directory, "settings.json"), "utf8")).toBe(before);
  });

  it("serializes simultaneous video and audio edits and selects defaults without losing other settings", async () => {
    const { store, directory } = await fixture();
    store.updateSettings({ language: "en-US", cliDefaultBoardId: "board" });
    await Promise.all([
      configureProvider(store, { ...audio, apiKey: "audio-key" }),
      configureProvider(store, { ...video, apiKey: "video-key", models: ["other", "vendor/video"] })
    ]);
    await configureProvider(store, { kind: "video", providerId: "video", action: "default" });
    await configureProvider(store, { kind: "video", providerId: "video", model: "other" });
    const reloaded = new SettingsStore(directory);
    expect(reloaded.getSettings()).toMatchObject({ language: "en-US", cliDefaultBoardId: "board", activeVideoProviderId: "video", activeAudioProviderId: "tts" });
    expect(reloaded.getSettings().videoProviders.find((p) => p.id === "video")).toMatchObject({ model: "other", models: ["other", "vendor/video"] });
    expect(reloaded.getApiKey("video")).toBe("video-key");
    await configureProvider(reloaded, { kind: "audio", providerId: "tts", action: "remove" });
    expect(new SettingsStore(directory).getSettings()).toMatchObject({ audioProviders: [], activeAudioProviderId: "" });
    expect(reloaded.getKeyStatus().tts).toBeUndefined();
  });

  it.each([
    { baseUrl: "https://user:password@example.com" }, { baseUrl: "file:///tmp/audio" },
    { model: "" }, { voice: 123 }, { type: "fal" }, { models: [42] },
    { speechEndpoint: "https://elsewhere.example/speech" }, { speechEndpoint: "//elsewhere.example" },
    { apiKey: 123 }, { setDefault: "yes" }, { unknown: true }
  ])("rejects invalid input atomically: %j", async (invalid) => {
    const { store, directory } = await fixture();
    await configureProvider(store, audio);
    const before = await readFile(path.join(directory, "settings.json"), "utf8");
    await expect(configureProvider(store, { ...audio, ...invalid })).rejects.toThrow();
    expect(await readFile(path.join(directory, "settings.json"), "utf8")).toBe(before);
  });

  it("rejects ID collisions, missing defaults, and mismatched shared video connections", async () => {
    const { store } = await fixture();
    await configureProvider(store, audio);
    await expect(configureProvider(store, { ...video, providerId: "tts" })).rejects.toThrow("其它类型");
    await expect(configureProvider(store, { kind: "audio", providerId: "missing", action: "default" })).rejects.toThrow("不存在");
    await expect(configureProvider(store, { ...video, connectionProviderId: "missing" })).rejects.toThrow("不匹配");
  });

  it("exposes audio metadata through workspace discovery and routes configuration to the service", async () => {
    const { store } = await fixture();
    await configureProvider(store, { ...audio, apiKey: "private-key" });
    const { mocks, commands } = workspaceFixture();
    mocks.getSettings.mockResolvedValue({ ...store.getSettings(), audioProviders: [{ ...store.getSettings().audioProviders![0], apiKey: "legacy-secret" }], providerKeyStatus: store.getKeyStatus() });
    expect(await commands.call("list_providers", { kind: "audio" })).toEqual([expect.objectContaining({ id: "tts", kind: "audio", isDefault: true, authConfigured: true })]);
    expect(await commands.call("list_models", { providerId: "tts" })).toMatchObject({ defaultModel: "tts-model", models: ["tts-model"] });
    expect(await commands.call("get_provider", { providerId: "tts" })).toMatchObject({ voice: "nova" });
    expect(JSON.stringify(await commands.call("get_provider", { providerId: "tts" }))).not.toMatch(/private-key|legacy-secret/u);
    await commands.call("configure_provider", audio);
    expect(mocks.configureProvider).toHaveBeenCalledWith(audio);
  });
});
