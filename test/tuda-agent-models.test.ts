// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { defaultTudaTextProvider, resolveAgentImageProvider } from "../shared/tuda-models";
import { TextModelPicker } from "../src/components/workbench/TextModelPicker";
import { assistantTextModelOptions } from "../src/lib/text-provider-readiness";
import { COMMUNITY_TEXT_PROVIDER } from "../shared/community-providers";
import { bindTudaAgentMediaTools } from "../electron/agents/media-tools";
import type { TextProviderConfig, ProviderConfig } from "../shared/types";
import type { ToolDefinition } from "../electron/agents/coding-runtime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const providers: TextProviderConfig[] = [
  { id: "company-text/openai/gpt", name: "GPT", model: "gpt", type: "openai-compatible", baseUrl: "" },
  { id: "company-text/dashscope/deepseek", name: "DeepSeek", model: "deepseek", type: "openai-compatible", baseUrl: "" },
  { id: "company-text/anthropic/claude", name: "Claude", model: "claude", type: "openai-compatible", baseUrl: "" }
];
const images: ProviderConfig[] = [
  { id: "company-image/seedream", name: "ToAPIs", model: "doubao-seedream-5-5", transport: "toapiscli", type: "openai-compatible", baseUrl: "", generationEndpoint: "", supportsReferenceImages: true },
  { id: "other-image", name: "Other", model: "other", type: "openai-compatible", baseUrl: "", generationEndpoint: "", supportsReferenceImages: true }
];

describe("Tuda Agent model selection", () => {
  it("defaults to DashScope DeepSeek and preserves explicit text-model choices", () => {
    expect(defaultTudaTextProvider(providers)).toBe(providers[1].id);
    expect(defaultTudaTextProvider(providers, providers[2].id)).toBe(providers[2].id);
    expect(defaultTudaTextProvider(providers, "removed-model")).toBe(providers[1].id);
  });
  it("renders a text-only selector using the shared default", async () => {
    const container = document.createElement("div"), root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TextModelPicker, { providers, onManage: vi.fn() })));
      expect(container.querySelector('[aria-label="选择文本模型"]')?.textContent).toContain("DeepSeek");
      expect(container.querySelector('[aria-label="选择图片模型"]')).toBeNull();
      await act(async () => root.render(createElement(TextModelPicker, { providers, activeProviderId: providers[2].id, onManage: vi.fn() })));
      expect(container.textContent).toContain("Claude");
    } finally { await act(async () => root.unmount()); }
  });
  it("lists a managed model once under Shanhai and omits the unconfigured built-in provider", async () => {
    const primary = { ...providers[0], id: "company-text/sync/primary", managed: true };
    const backup = { ...primary, id: "company-text/sync/backup", model: "backup-upstream" };
    const personal = { ...providers[2], id: "personal", baseUrl: "https://local.example.com" };
    const routing = { text: { defaultModel: "公司写作", models: [
      { name: "公司写作", channels: [primary, backup].map(({ id: providerId, model }) => ({ providerId, model })) }
    ] } };
    const keys = { [backup.id]: true, [personal.id]: true };
    const options = assistantTextModelOptions(routing, [primary, backup, COMMUNITY_TEXT_PROVIDER], keys, backup.id);
    expect(options.map(({ id }) => id)).toEqual(["text-route/" + encodeURIComponent("公司写作")]);
    expect(assistantTextModelOptions(routing, [primary, backup, personal], keys, backup.id).map(({ id }) => id))
      .toEqual([options[0].id, personal.id]);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const select = vi.fn();
    try {
      await act(async () => root.render(createElement(TextModelPicker, {
        providers: options, activeProviderId: options[0].id, onManage: vi.fn(), onSelect: select
      })));
      const button = container.querySelector('button')!;
      expect(button.textContent).toBe("公司写作");
      await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
      const group = document.querySelector('[role="group"][aria-label="山海管理"]');
      const items = [...group!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items.map(item => item.textContent)).toEqual(["公司写作"]);
      await act(async () => items[0].click());
      expect(select).toHaveBeenCalledWith(options[0].id);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
  it("requires a selected image model and disambiguates models available from multiple services", () => {
    expect(() => resolveAgentImageProvider(images, undefined)).toThrow("询问用户");
    expect(() => resolveAgentImageProvider(images, "missing")).toThrow("授权目录");
    expect(resolveAgentImageProvider(images, "other").id).toBe(images[1].id);
    expect(resolveAgentImageProvider(images, "doubao-seedream-5-5").id).toBe(images[0].id);
    const secondService = { ...images[1], model: images[0].model };
    const sharedModel = [images[0], secondService];
    expect(() => resolveAgentImageProvider(sharedModel, secondService.model)).toThrow();
    expect(resolveAgentImageProvider(sharedModel, secondService.model, secondService.id)).toBe(secondService);
  });
  it("lets both Agent entry points use configured image and video routing", async () => {
    const execute = vi.fn(async (...args: unknown[]) => { void args; return { content: [{ type: "text", text: "submitted" }], details: {} }; });
    const original = { name: "generate_image", label: "Generate", description: "Generate", parameters: { type: "object", properties: {} }, execute } as unknown as ToolDefinition;
    const video = { ...original, name: "generate_video" };
    const [imageTool, videoTool] = bindTudaAgentMediaTools([original, video], images);
    expect((imageTool.parameters as { required: string[] }).required).not.toContain("model");
    await imageTool.execute("call", { prompt: "用户描述", providerId: images[0].id }, undefined, undefined, {} as never);
    expect(execute.mock.calls[0]?.[1]).toEqual({ prompt: "用户描述", useImageRouting: true });
    await videoTool.execute("video-call", { prompt: "视频描述", model: "Seedance 2.5", providerId: "ignored" }, undefined, undefined, {} as never);
    expect(execute.mock.calls[1]?.[1]).toEqual({ prompt: "视频描述", model: "Seedance 2.5", useVideoRouting: true });
  });
});
