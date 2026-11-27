import { describe, expect, it, vi } from "vitest";
import { agentImageChannels, generateWithImageRouting } from "../electron/application/agent-image-routing.js";
import { mergeManagedRouting } from "../electron/company/managed-models.js";
import { ImageSubmissionError } from "../electron/providers/errors.js";
import { Sub2ApiImageProvider } from "../electron/providers/sub2api.js";
import { resolveImageRouting } from "../shared/image-routing.js";
import type { GenerateImageInput, GenerateResponse, ProviderConfig, ProviderGenerateInput } from "../shared/types.js";

const model = "gpt-image-2.5-sunburst";
const providers: ProviderConfig[] = [
  { id: "aipai", name: "AI派", model, type: "openai-compatible", baseUrl: "https://aipaiai.cn/v1",
    generationEndpoint: "/v1/images/generations", supportsReferenceImages: false },
  { id: "toapis", name: "ToAPIs", model, type: "openai-compatible", baseUrl: "https://toapis.cn/v1",
    generationEndpoint: "/v1/images/generations", supportsReferenceImages: false }
];
const input: GenerateImageInput = {
  prompt: "a blue circle", boardId: "board", clientTaskId: "request-image",
  model: "", workflowMode: "generate", size: "auto", n: 1, referenceImages: []
};
const image = { b64_json: Buffer.from("image-test").toString("base64") };
const settings = { providers, activeProviderId: "aipai", providerKeyStatus: { aipai: true, toapis: true } };
const channels = () => agentImageChannels(settings, { model: "", count: 1, references: 0, transparent: false });
function tracedAdapter(fetcher: typeof fetch) {
  const adapter = new Sub2ApiImageProvider(fetcher, 40);
  return async (request: GenerateImageInput): Promise<GenerateResponse> => {
    const provider = providers.find(item => item.id === request.providerId)!;
    const generated = await adapter.generate({
      ...request, clientRequestId: request.clientTaskId, referenceImages: []
    }, provider, `test-${provider.id}-key`);
    return { job: { providerId: provider.id } as GenerateResponse["job"],
      images: generated.images.map(item => ({ path: "image", dataUrl: item.bytes.toString() })) };
  };
}

describe("Agent image model channel order", () => {
  it("uses the configured model name and channel order regardless of the manual default", () => {
    const initial = resolveImageRouting(undefined, providers, "aipai");
    const route = { defaultModel: "模型别名", models: [{ name: "模型别名", channels: initial.models[0].channels.toReversed() }] };
    const chosen = agentImageChannels({ ...settings, imageRouting: route }, { model: "", count: 1, references: 0, transparent: false });
    expect(chosen.map(item => [item.provider.id, item.model])).toEqual([["toapis", model], ["aipai", model]]);
  });

  it("resolves the exact provider model ID to a renamed personal route without changing the upstream ID", async () => {
    const id = "GPT-Image-2.6-Sunburst";
    const managedId = id.toLowerCase();
    const local = { ...providers[0], model: id };
    const managed = { ...providers[1], model: managedId };
    const imageRouting = mergeManagedRouting(
      { defaultModel: managedId, models: [{ name: managedId, channels: [{ providerId: managed.id, model: managedId }] }] },
      { defaultModel: id, models: [{ name: id, channels: [{ providerId: local.id, model: id }] }] },
      true,
    );
    expect(imageRouting.defaultModel).toBe(`${id} · 个人`);
    const configured = { ...settings, providers: [local, managed], imageRouting };
    const request = { count: 1, references: 0, transparent: false };
    for (const selection of ["", id, imageRouting.defaultModel]) {
      expect(agentImageChannels(configured, { ...request, model: selection })).toEqual([{ provider: local, model: id }]);
    }
    expect(agentImageChannels(configured, { ...request, model: managedId })).toEqual([{ provider: managed, model: managedId }]);
    const submit = vi.fn(async () => ({ job: { providerId: local.id } as GenerateResponse["job"], images: [] }));
    await generateWithImageRouting(agentImageChannels(configured, { ...request, model: id }), input, submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ providerId: local.id, model: id }));
  });

  it("requires a route name when a provider model ID matches multiple routes", () => {
    const imageRouting = { defaultModel: "首选", models: [
      { name: "首选", channels: [{ providerId: "aipai", model }] },
      { name: "备用", channels: [{ providerId: "toapis", model }] }
    ] };
    const request = { count: 1, references: 0, transparent: false };
    expect(() => agentImageChannels({ ...settings, imageRouting }, { ...request, model })).toThrow(/对应多个模型.*首选、备用/);
    expect(agentImageChannels({ ...settings, imageRouting }, { ...request, model: "备用" })[0].provider.id).toBe("toapis");
  });

  it("switches from a definite AI派 rejection to ToAPIs for the same model and keeps separate credentials", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "invalid_api_key" } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ object: "generation.task", id: "done", status: "completed", result: { data: [image] } }));
    const result = await generateWithImageRouting(channels(), input, tracedAdapter(fetcher));
    expect(result.job.providerId).toBe("toapis");
    expect(result.warnings?.join(" ")).toMatch(/AI派.*401.*ToAPIs/);
    expect(fetcher.mock.calls.map(([url, req]) => [
      url, JSON.parse(String(req?.body)).model, new Headers(req?.headers).get("Authorization")
    ])).toEqual([
      ["https://aipaiai.cn/v1/images/generations/tasks", model, "Bearer test-aipai-key"],
      ["https://toapis.cn/v1/images/generations", model, "Bearer test-toapis-key"]
    ]);
  });

  it("switches when an already accepted task reaches definite failure", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ task_id: "failed-task", status: "failed" }))
      .mockResolvedValueOnce(Response.json({ data: [image] }));
    expect((await generateWithImageRouting(channels(), input, tracedAdapter(fetcher))).job.providerId).toBe("toapis");
  });

  it("rediscovers the original AI派 task using the same key after losing the submit response", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(Response.json({ task_id: "original", status: "completed", response: { data: [image] } }));
    expect((await generateWithImageRouting(channels(), input, tracedAdapter(fetcher))).job.providerId).toBe("aipai");
    const [, first] = fetcher.mock.calls[0];
    const [, retry] = fetcher.mock.calls[1];
    expect(retry?.body).toBe(first?.body);
    expect(new Headers(first?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(new Headers(first?.headers).get("Idempotency-Key")).toBe(new Headers(retry?.headers).get("Idempotency-Key"));
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://aipaiai.cn/"))).toBe(true);
  });

  it("queries the ToAPIs business ID after a lost submission response and avoids resubmitting", async () => {
    const adapter = new Sub2ApiImageProvider(vi.fn<typeof fetch>(async (url, req) => {
      if (req?.method === "POST") {
        expect(JSON.parse(String(req.body)).client_business_id).toBe("original-id");
        throw new TypeError("lost response");
      }
      expect(url).toBe("https://toapis.cn/v1/images/generations/original-id");
      return Response.json({ status: "completed", result: { data: [image] } });
    }));
    const req: ProviderGenerateInput = { ...input, recoverImageSubmission: true, clientRequestId: "original-id", referenceImages: [] };
    await expect(adapter.generate(req, providers[1], "test-key")).resolves.toMatchObject({ images: [{ mimeType: "image/png" }] });
  });

  const nasProvider: ProviderConfig = {
    ...providers[1], id: "nas", name: "公司NAS生图", baseUrl: "http://192.0.2.10:18743/omni/v1"
  };
  const nasInput: ProviderGenerateInput = {
    ...input, recoverImageSubmission: true, clientRequestId: "nas-original-id", referenceImages: []
  };

  it("polls the NAS task returned by a 202 response", async () => {
    const endpoint = nasProvider.baseUrl + "/images/generations";
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ object: "generation.task", id: "nas-task", status: "queued" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ object: "generation.task", id: "nas-task", status: "completed", result: { data: [image] } }));
    const adapter = new Sub2ApiImageProvider(fetcher);
    await expect(adapter.generate(nasInput, nasProvider, "test-key")).resolves.toMatchObject({ images: [{ mimeType: "image/png" }] });
    expect(fetcher.mock.calls.map(([url, req]) => [url, req?.method ?? "GET"])).toEqual([
      [endpoint, "POST"], [endpoint + "/nas-task", "GET"]
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).client_business_id).toBe("nas-original-id");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe("nas-original-id");
  }, 8_000);

  it("recovers a NAS task by business ID using a read-only request after the submit response is lost", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(Response.json({ object: "generation.task", id: "nas-task", status: "completed", result: { data: [image] } }));
    const adapter = new Sub2ApiImageProvider(fetcher);
    await expect(adapter.generate(nasInput, nasProvider, "test-key")).resolves.toMatchObject({ images: [{ mimeType: "image/png" }] });
    expect(fetcher.mock.calls.map(([url, req]) => [url, req?.method ?? "GET"])).toEqual([
      [nasProvider.baseUrl + "/images/generations", "POST"],
      [nasProvider.baseUrl + "/images/generations/nas-original-id", "GET"]
    ]);
  });

  it("retains the submission and lookup HTTP statuses when NAS recovery is inconclusive", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 502 }))
      .mockResolvedValueOnce(Response.json({}, { status: 401 }));
    const adapter = new Sub2ApiImageProvider(fetcher);
    await expect(adapter.generate(nasInput, nasProvider, "test-key")).rejects.toMatchObject({
      outcome: "unknown", message: expect.stringMatching(/HTTP 502.*HTTP 401/u)
    });
    expect(fetcher.mock.calls.filter(([, req]) => req?.method === "POST")).toHaveLength(1);
  });

  it("uses the declared business-ID protocol with an arbitrary host and submit endpoint", async () => {
    const endpoint = "https://relay.example.invalid/custom/create";
    const provider: ProviderConfig = {
      ...nasProvider, baseUrl: "https://relay.example.invalid", generationEndpoint: "/custom/create",
      imageTaskProtocol: "business-id", imageTaskEndpoint: "/custom/tasks/{id}"
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(Response.json({ status: "completed", result: { data: [image] } }));
    await expect(new Sub2ApiImageProvider(fetcher).generate(nasInput, provider, "test-key"))
      .resolves.toMatchObject({ images: [{ mimeType: "image/png" }] });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([endpoint, "https://relay.example.invalid/custom/tasks/nas-original-id"]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).client_business_id).toBe("nas-original-id");
  });

  it("uses a declared task-ID protocol without sending business-ID fields", async () => {
    const provider: ProviderConfig = { ...nasProvider, imageTaskProtocol: "task-id" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({ object: "generation.task", id: "provider-task", status: "completed", result: { data: [image] } }, { status: 202 })
    );
    await expect(new Sub2ApiImageProvider(fetcher).generate(nasInput, provider, "test-key"))
      .resolves.toMatchObject({ images: [{ mimeType: "image/png" }] });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).not.toHaveProperty("client_business_id");
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has("Idempotency-Key")).toBe(false);
  });

  it("stays on the original channel when recovery cannot determine its status", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("response lost"));
    await expect(generateWithImageRouting(channels(), input, tracedAdapter(fetcher))).rejects.toMatchObject({
      outcome: "unknown", message: expect.stringContaining("AI派")
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("https://aipaiai.cn/"))).toBe(true);
  });

  it("does not switch after a content rejection", async () => {
    const submit = vi.fn().mockRejectedValue(new ImageSubmissionError("blocked", "IMAGE_CONTENT_BLOCKED", "blocked"));
    await expect(generateWithImageRouting(channels(), input, submit)).rejects.toMatchObject({ outcome: "blocked" });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
