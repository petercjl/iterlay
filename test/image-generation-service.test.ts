import { describe, expect, it, vi } from "vitest";
import type { GenerateImageInput, GenerationJob, GenerationResult, ProviderConfig } from "../shared/types";
vi.mock("../electron/system-notification.js", () => ({ showGenerationCompletedNotification: vi.fn() }));
import { createImageGenerationCommand, type ImageGenerationDependencies } from "../electron/application/image-generation";
import { toapisDimensions } from "../electron/company/toapis";
import { ImageSubmissionError, ProviderError } from "../electron/providers/errors";
function fixture(routed = false) {
  const config: ProviderConfig = { id: "custom", type: "openai-compatible", name: "Fixture", baseUrl: "https://fixture.invalid", generationEndpoint: "/v1/images/generations", model: "gpt-image-1", supportsReferenceImages: true };
  const fallback = { ...config, id: "fallback", name: "Fallback", model: "fixture-image" };
  const finishGenerationNode = vi.fn(async () => undefined);
  let finish!: (value: GenerationResult) => void;
  const generate = vi.fn(() => new Promise<GenerationResult>((resolve) => { finish = resolve; }));
  const history = { findByIdempotencyKey: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null), addJob: vi.fn<(_job: GenerationJob) => Promise<void>>(async () => undefined), updateJob: vi.fn<(_job: GenerationJob) => Promise<void>>(async () => undefined) };
  const dependencies = {
    settings: {
      getSettings: () => ({ activeProviderId: "custom", providers: routed ? [config, fallback] : [config],
        imageRouting: routed ? { defaultModel: "Canvas model", models: [{ name: "Canvas model",
          channels: [{ providerId: config.id, model: config.model }, { providerId: fallback.id, model: fallback.model }] }] } : undefined }),
      getApiKey: () => "fixture-only", getKeyStatus: () => ({ custom: true, fallback: true })
    },
    history, assets: { saveReferenceImageBytes: async () => [], saveOutputs: async () => ["/managed/result.png"], toAssetUrl: () => "tuda-asset://result" },
    getProviderAdapter: () => ({ generate }), recordMemory: vi.fn(), sceneMedia: {}, backfillThumbHashes: vi.fn(),
    createGeneratedBoardNodes: async () => [], boards: { finishGenerationNode }, analytics: { track: async () => undefined }
  };
  const command = createImageGenerationCommand(dependencies as unknown as ImageGenerationDependencies);
  const input: GenerateImageInput = { workflowMode: "generate", prompt: "Fixture", model: "gpt-image-1", size: "auto", n: 1, referenceImages: [], boardId: "board", idempotencyKey: "request-1" };
  return { command, input, config, generate, history, finishGenerationNode, finish: () => finish({ images: [{ bytes: Buffer.from([1]), mimeType: "image/png" }] }) };
}
describe("shared UI and MCP image generation service", () => {
  it("routes a canvas node by model, records both attempts and commits only the winning result", async () => {
    const f = fixture(true);
    f.generate.mockRejectedValueOnce(new ProviderError("HTTP_ERROR", "HTTP 401", 401));
    const result = f.command({ ...f.input, idempotencyKey: undefined, providerId: "fallback",
      clientTaskId: "canvas-routed", model: "Canvas model", useImageRouting: true, generationNodeId: "node" });
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(2));
    expect(f.history.addJob.mock.calls.map(([job]) => [job.providerId, job.model])).toEqual([
      ["custom", "gpt-image-1"], ["fallback", "fixture-image"]
    ]);
    expect(f.finishGenerationNode).not.toHaveBeenCalled();
    f.finish();
    const completed = await result;
    expect(completed.job.providerId).toBe("fallback");
    expect(f.finishGenerationNode.mock.calls).toEqual([["board", "node", { jobId: completed.job.id, nodes: [] }]]);
  });

  it("leaves an uncertain canvas submission on its original channel", async () => {
    const f = fixture(true);
    f.generate.mockRejectedValueOnce(new ImageSubmissionError("unknown", "SUBMISSION_UNKNOWN", "受理状态待确认"));
    await expect(f.command({ ...f.input, idempotencyKey: undefined,
      model: "Canvas model", useImageRouting: true, generationNodeId: "node" })).rejects.toMatchObject({ outcome: "unknown" });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.history.updateJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: "unknown" }));
    expect(f.finishGenerationNode).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent identical submissions and reuses a committed result", async () => {
    const f = fixture();
    const first = f.command(f.input), second = f.command({ ...f.input });
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    f.finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a.job.id).toBe(b.job.id);
    expect(f.history.addJob).toHaveBeenCalledOnce();
    f.history.findByIdempotencyKey.mockResolvedValue(a.job);
    expect((await f.command(f.input)).job.id).toBe(a.job.id);
    expect(f.generate).toHaveBeenCalledOnce();
  });
  it("rejects reusing a request identity on another board", async () => {
    const f = fixture();
    const first = f.command(f.input);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    await expect(f.command({ ...f.input, boardId: "other" })).rejects.toThrow("其他生成参数");
    f.finish();
    await first;
  });
  it("validates request data and provider-specific limits before provider work", async () => {
    const f = fixture();
    await expect(f.command({ ...f.input, n: NaN })).rejects.toThrow("生成参数");
    f.config.type = "ark";
    await expect(f.command({ ...f.input, n: 5 })).rejects.toThrow("最多生成 4");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("persists the backend queue and cancels its fourth task without ever calling its provider", async () => {
    const f = fixture();
    const resolvers: Array<(result: GenerationResult) => void> = [];
    f.generate.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const running = ["a", "b", "c"].map((id) => f.command({ ...f.input, idempotencyKey: id, clientTaskId: id }));
    const fourth = f.command({ ...f.input, idempotencyKey: "fourth", clientTaskId: "fourth" });
    const rejection = expect(fourth).rejects.toThrow("已取消排队任务");
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(3));
    expect(f.history.addJob).toHaveBeenCalledTimes(4);
    expect(f.history.addJob.mock.calls.every(([job]) => job.status === "queued")).toBe(true);
    expect(await f.command.cancel("fourth")).toMatchObject({ status: "cancelled", remoteCancelled: false });
    await rejection;
    expect(f.history.updateJob).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    resolvers.forEach((resolve) => resolve({ images: [{ bytes: Buffer.from([1]), mimeType: "image/png" }] }));
    await Promise.all(running);
    expect(f.generate).toHaveBeenCalledTimes(3);
  });

  it("does not abort a submitted provider request or claim remote billing stopped, and still records its real late result", async () => {
    const f = fixture();
    const task = f.command({ ...f.input, clientTaskId: "running" });
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    expect(await f.command.cancel("running")).toMatchObject({ status: "running", remoteCancelled: false });
    f.finish();
    expect((await task).job.status).toBe("succeeded");
    expect(f.history.updateJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: "succeeded" }));
  });

  it("distinguishes an ambiguous transport failure from a definite provider rejection", async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(f.command(f.input)).rejects.toThrow("费用状态待确认");
    expect(f.history.updateJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: "unknown" }));
    f.generate.mockRejectedValueOnce(new ProviderError("HTTP_ERROR", "HTTP 401", 401));
    await expect(f.command({ ...f.input, idempotencyKey: "different" })).rejects.toThrow("HTTP 401");
    expect(f.history.updateJob).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

it("marks local ToAPIs dimension validation as failed rather than uncertain billing", async () => {
  const f = fixture();
  f.generate.mockImplementationOnce(async () => { toapisDimensions("bad-size", "gpt-image-2.6-sunburst"); return {images: []}; });
  await expect(f.command(f.input)).rejects.toMatchObject({code: "TOAPIS_INPUT_INVALID"});
  expect(f.history.updateJob).toHaveBeenLastCalledWith(expect.objectContaining({status: "failed", error: expect.not.stringContaining("费用状态待确认")}));
});
