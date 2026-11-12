import { expect, it } from "vitest";
import {
  OpenAICompatibleTextTransport,
  collaborateSceneAgentWith,
} from "../electron/providers/text-assistant.js";
import {
  nativeTextRequest,
  readNativeTextStream,
} from "../electron/providers/native-text.js";
import type { TextProviderConfig } from "../shared/types.js";
const config = (
  protocol: TextProviderConfig["protocol"],
): TextProviderConfig => ({
  id: "managed",
  name: "共享文本",
  type: "openai-compatible",
  managed: true,
  protocol,
  baseUrl: "https://account.example/api/company/v1/proxy/tuda/provider/v1",
  model: "model",
});
it.each(["anthropic-messages", "openai-responses"] as const)(
  "preserves system instructions and reference bytes in %s",
  (protocol) => {
    const request = nativeTextRequest(
      config(protocol),
      [
        { role: "system", content: "tools schema" },
        {
          role: "user",
          content: [
            { type: "text", text: "编辑参考图" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,YQ==" },
            },
          ],
        },
      ],
      {},
      true,
    );
    const data = JSON.stringify(request.body);
    expect(data).toContain("tools schema");
    expect(data).toContain("YQ==");
    expect(data).toContain("编辑参考图");
    expect(
      request.url.endsWith(
        protocol === "anthropic-messages" ? "/messages" : "/responses",
      ),
    ).toBe(true);
  },
);
it.each(["anthropic-messages", "openai-responses"] as const)(
  "runs the existing typed Agent harness over %s",
  async (protocol) => {
    const decision = JSON.stringify({
      text: "完成",
      toolCalls: [
        {
          name: "finish_assistant_result",
          arguments: {
            result: {
              message: "已检查画板",
              intent: "chat",
              goal: "explain",
              commitment: "advise_only",
              fields: [],
            },
          },
        },
      ],
    });
    const transport = new OpenAICompatibleTextTransport(
      config(protocol),
      "device-grant",
      (async (url, init) => {
        expect(new Headers(init?.headers).get("X-Company-App-Id")).toBe("tuda");
        expect(String(url)).toContain(
          protocol === "anthropic-messages" ? "/messages" : "/responses",
        );
        return Response.json(
          protocol === "anthropic-messages"
            ? { content: [{ type: "text", text: decision }] }
            : {
                status: "completed",
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: decision }],
                  },
                ],
              },
        );
      }) as typeof fetch,
    );
    const result = await collaborateSceneAgentWith(transport, {
      instruction: "看看画板",
      referenceImages: [],
      currentFields: [],
      workflowMode: "generate",
      assistantSurface: "canvas-prompt",
      agentMode: true,
    });
    expect(result.message).toBe("已检查画板");
  },
);
it("requires native stream completion and forwards only user-visible reasoning summaries", async () => {
  const frames = [
    { type: "response.reasoning_summary_text.delta", delta: "摘要" },
    { type: "response.output_text.delta", delta: "你好" },
    { type: "response.completed", response: { status: "completed" } },
  ];
  const response = (items: unknown[]) =>
    new Response(
      items.map((v) => "data: " + JSON.stringify(v) + "\r\n\r\n").join(""),
    );
  const text: string[] = [],
    summary: string[] = [];
  expect(
    await readNativeTextStream(
      response(frames),
      false,
      (v) => text.push(v),
      (v) => summary.push(v),
    ),
  ).toBe("你好");
  expect(summary).toEqual(["摘要"]);
  await expect(
    readNativeTextStream(response(frames.slice(0, 2)), false, () => undefined),
  ).rejects.toThrow("完整");
});
