// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { defaultTudaTextProvider, toapisAgentProvider } from "../shared/tuda-models";
import { TextModelPicker } from "../src/components/workbench/TextModelPicker";
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
  it("requires a user-selected authorized ToAPIs image model", () => {
    expect(() => toapisAgentProvider(images, undefined)).toThrow("询问用户");
    expect(() => toapisAgentProvider(images, "other")).toThrow("授权目录");
    expect(toapisAgentProvider(images, "doubao-seedream-5-5").id).toBe(images[0].id);
  });
  it("routes image calls by conversational model choice and keeps video tools", async () => {
    const execute = vi.fn(async (...args: unknown[]) => { void args; return { content: [{ type: "text", text: "submitted" }], details: {} }; });
    const original = { name: "generate_image", label: "Generate", description: "Generate", parameters: { type: "object", properties: {} }, execute } as unknown as ToolDefinition;
    const video = { ...original, name: "generate_video" };
    const [imageTool, videoTool] = bindTudaAgentMediaTools([original, video], images);
    expect((imageTool.parameters as { required: string[] }).required).toContain("model");
    await imageTool.execute("call", { model: "doubao-seedream-5-5", prompt: "用户描述", providerId: "old-ui-choice" }, undefined, undefined, {} as never);
    expect(execute.mock.calls[0]?.[1]).toEqual({ model: "doubao-seedream-5-5", prompt: "用户描述", providerId: images[0].id });
    expect(videoTool).toBe(video);
    await expect(imageTool.execute("bad", { prompt: "missing model" }, undefined, undefined, {} as never)).rejects.toThrow("询问用户");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
