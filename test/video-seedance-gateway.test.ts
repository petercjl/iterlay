import { describe, expect, it, vi } from "vitest";
import { SeedanceGatewayVideoProvider } from "../electron/providers/video-seedance-gateway.js";

describe("Seedance gateway video adapters", () => {
  it("uploads a local reference to ToAPIs before submitting the video", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { url: "https://assets.example/frame.png" } }))
      .mockResolvedValueOnce(Response.json({ id: "video-task", status: "queued" }));
    const adapter = new SeedanceGatewayVideoProvider("seedance-toapis", fetcher);
    await adapter.submit({
      prompt: "Animate this", inputs: [{ kind: "image", role: "first-frame", id: "frame", name: "frame.png",
        mimeType: "image/png", bytes: Buffer.from([1, 2]) }]
    }, { model: "seedance-2-5", provider: "seedance-toapis", baseUrl: "https://gateway.example", apiKey: "fixture-key" });
    expect(fetcher.mock.calls[0][0]).toBe("https://gateway.example/v1/uploads/images");
    expect(fetcher.mock.calls[0][1]?.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({
      aspect_ratio: "adaptive", image_with_roles: [{ url: "https://assets.example/frame.png", role: "first_frame" }]
    });
  });
  it("checks the original ToAPIs task by business ID when the submission response is lost", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection closed"))
      .mockResolvedValueOnce(Response.json({ id: "existing-video", status: "in_progress" }));
    const adapter = new SeedanceGatewayVideoProvider("seedance-toapis", fetcher);
    const task = await adapter.submit({ prompt: "A shot", clientRequestId: "original-request" },
      { provider: "seedance-toapis", model: "seedance-2", apiKey: "fixture-key", baseUrl: "https://gateway.example" });
    expect(task).toMatchObject({ id: "existing-video", status: "running" });
    expect(fetcher.mock.calls.map(([url, request]) => [url, request?.method])).toEqual([
      ["https://gateway.example/v1/videos/generations", "POST"],
      ["https://gateway.example/v1/videos/generations/original-request", "GET"]
    ]);
  });

  it("identifies a documented AI派 channel rejection from the submit response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      error: { message: "No available channel" }
    }, { status: 503 }));
    const adapter = new SeedanceGatewayVideoProvider("seedance-aipai", fetcher);
    await expect(adapter.submit({ prompt: "A shot" },
      { provider: "seedance-aipai", model: "sd-2-5", apiKey: "fixture-key", baseUrl: "https://gateway.example" }
    )).rejects.toMatchObject({ code: "CHANNEL_UNAVAILABLE", status: 503 });
  });

  it.each([
    { provider: "seedance-aipai", model: "sd-2-5", path: "/v1/videos" },
    { provider: "seedance-toapis", model: "seedance-2-5", path: "/v1/videos/generations" }
  ] as const)("submits, polls and downloads through $provider", async ({ provider, model, path }) => {
    const aiPai = provider === "seedance-aipai";
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "test-task", status: "queued" }))
      .mockResolvedValueOnce(Response.json({ status: "completed", result: { data: [{ url: "https://assets.example/video.mp4" }] } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } }));
    const adapter = new SeedanceGatewayVideoProvider(provider, fetcher);
    const config = { provider, model, apiKey: "fixture-key", baseUrl: "https://gateway.example/v1" };
    const task = await adapter.submit({ prompt: "Test prompt", durationSeconds: 22, ratio: "16:9", resolution: "720p", clientRequestId: "test-order",
      inputs: [{ id: "i1", kind: "image", role: "reference-image", mimeType: "image/png", url: "https://assets.example/ref.png" }] }, config);
    expect(fetcher.mock.calls[0][0]).toBe("https://gateway.example" + path);
    const submitted = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(submitted).toMatchObject({ model, duration: 22, ...(aiPai
      ? { ratio: "16:9", mode: "reference_material", function_mode: "omni_reference", content: [
          { type: "text", text: "Test prompt" }, { type: "image_url", role: "reference_image" }
        ] }
      : { aspect_ratio: "16:9", client_business_id: "test-order", image_with_roles: [{ role: "reference_image" }] }) });
    const completed = await adapter.poll(task, config);
    expect(fetcher.mock.calls[1][0]).toBe("https://gateway.example" + path + "/test-task");
    expect(completed.status).toBe("succeeded");
    expect((await adapter.download(completed.outputs![0], config)).mimeType).toBe("video/mp4");
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).has("authorization")).toBe(aiPai);
  });
});
