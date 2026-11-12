import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createTudaAgentTools } from "../electron/pi-agent-tools.js";
import { CodexOAuthTextTransport } from "../electron/providers/codex-oauth.js";
import { TudaAgentService, tudaSessionDirectory } from "../electron/agents/tuda-agent.js";
import { OpenAICompatibleTextTransport } from "../electron/providers/text-assistant.js";
import type { PiAgentResourceOptions } from "../electron/providers/text-assistant.js";
import type { CollaborateSceneRequest } from "../shared/types.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(replies: Array<string | { name: string; args: unknown }>, protocol: "openai-chat-completions" | "openai-responses" | "anthropic-messages" = "openai-chat-completions", holdRequests = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tuda-native-agent-")); directories.push(root);
  const cwd = path.join(root, "workspace"); await mkdir(cwd);
  const requests: Array<{ body: Record<string, unknown> & { tools: Array<{ type: string }> }; headers: import("node:http").IncomingHttpHeaders }> = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push({ body: JSON.parse(body), headers: request.headers });
    const reply = replies.shift();
    if (reply === undefined) { if (!holdRequests) response.writeHead(400).end("Unexpected extra model request"); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    if (protocol === "anthropic-messages") {
      emit("message_start", { message: { id: "msg-test", type: "message", role: "assistant", model: "test-vision", content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 0 } } });
      emit("content_block_start", { index: 0, content_block: typeof reply === "string" ? { type: "text", text: "" } : { type: "tool_use", id: `call-${requests.length}`, name: reply.name, input: {} } });
      emit("content_block_delta", { index: 0, delta: typeof reply === "string" ? { type: "text_delta", text: reply } : { type: "input_json_delta", partial_json: JSON.stringify(reply.args) } });
      emit("content_block_stop", { index: 0 });
      emit("message_delta", { delta: { stop_reason: typeof reply === "string" ? "end_turn" : "tool_use" }, usage: { output_tokens: 8 } });
      emit("message_stop", {}); response.end(); return;
    }
    if (protocol === "openai-responses") {
      const item = typeof reply === "string" ? { id: "msg-test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] }
        : { id: `fc-${requests.length}`, type: "function_call", call_id: `call-${requests.length}`, name: reply.name, arguments: JSON.stringify(reply.args), status: "completed" };
      emit("response.created", { response: { id: "resp-test", object: "response", model: "test-vision", status: "in_progress", output: [] } });
      emit("response.output_item.added", { output_index: 0, item: typeof reply === "string" ? { ...item, content: [] } : { ...item, arguments: "" } });
      if (typeof reply === "string") {
        emit("response.content_part.added", { item_id: "msg-test", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        emit("response.output_text.delta", { item_id: "msg-test", output_index: 0, content_index: 0, delta: reply });
      } else emit("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: JSON.stringify(reply.args) });
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id: "resp-test", status: "completed", output: [item], usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      response.end(); return;
    }
    const delta = typeof reply === "string" ? { content: reply } : {
      tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } }]
    };
    response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: typeof reply === "string" ? "stop" : "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const transport = new OpenAICompatibleTextTransport({ id: "managed", name: "Company model", type: "openai-compatible",
    model: "test-vision", baseUrl: `http://127.0.0.1:${port}`, managed: true, protocol }, "test-secret-key");
  const resources = { cwd, agentDir: path.join(root, "agent"), settings: {
    piAgentBuiltinTools: [], piAgentMaxTurns: 6
  } } as unknown as PiAgentResourceOptions;
  const request: CollaborateSceneRequest = { instruction: "查看当前画板，只讨论方案。", referenceImages: [],
    conversationId: "shared-conversation", assistantSurface: "canvas-prompt", creationWorkflow: true, agentMode: true,
    memoryQuery: { boardId: "board-3" }, currentFields: [], workflowMode: "generate" };
  return { root, cwd, transport, resources, request, requests };
}

describe("shared native Pi harness", () => {
  it("executes native tools once, retains receipts across entrances and restart, keeps credentials out of sessions", async () => {
    const f = await fixture([{ name: "get_active_board", args: {} }, "已读取画板，只给方案。", "继续上一轮方案。"]);
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "board-3 receipt-123" }], details: {} }));
    const tools = [{ name: "get_active_board", label: "画板", description: "Read board", parameters: Type.Object({}), execute }];
    const events: unknown[] = [];
    f.resources.presentTool = (event) => events.push(event);
    const first = await new TudaAgentService().run({ connection: f.transport.getAgentConnection(), request: f.request,
      resources: f.resources, systemPrompt: "Tuda Agent", tools, onDelta: vi.fn() });
    expect(first).toEqual({ message: "已读取画板，只给方案。", intent: "chat", fields: [] });
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ status: "running" }), expect.objectContaining({ status: "completed" })]));
    await new TudaAgentService().run({ connection: f.transport.getAgentConnection(),
      request: { ...f.request, instruction: "继续", assistantSurface: "canvas-edit" }, resources: f.resources,
      systemPrompt: "Tuda Agent", tools, onDelta: vi.fn() });
    expect(JSON.stringify(f.requests[2].body.messages)).toContain("receipt-123");
    expect(f.requests[0].body.tools[0].type).toBe("function");
    expect(JSON.stringify(f.requests[0].body.messages)).not.toContain("JSON 工具决策协议");
    expect(f.requests.every((r) => r.headers.authorization === "Bearer test-secret-key" && r.headers["x-company-app-id"] === "tuda")).toBe(true);
    const directory = tudaSessionDirectory(f.resources.agentDir, f.request.conversationId!);
    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith(".jsonl"))).toHaveLength(1);
    const saved = await readFile(path.join(directory, files.find((file) => file.endsWith(".jsonl"))!), "utf8");
    expect(saved).toContain("receipt-123"); expect(saved).not.toContain("test-secret-key");
    expect(tudaSessionDirectory(path.join(f.root, "other-account"), f.request.conversationId!)).not.toBe(directory);
  }, 30_000);

  it.each(["openai-responses", "anthropic-messages"] as const)("preserves employee authorization and native tools over %s", async (protocol) => {
    const f = await fixture([{ name: "get_active_board", args: {} }, "协议验证完成。"], protocol);
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "native receipt" }], details: {} }));
    const result = await new TudaAgentService().run({ connection: f.transport.getAgentConnection(), request: f.request, resources: f.resources,
      systemPrompt: "Tuda Agent", tools: [{ name: "get_active_board", label: "画板", description: "Read", parameters: Type.Object({}), execute }], onDelta: vi.fn() });
    expect(result.message).toBe("协议验证完成。");
    expect(execute).toHaveBeenCalledOnce();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0].headers.authorization).toBe("Bearer test-secret-key");
    expect(f.requests[0].headers["x-company-app-id"]).toBe("tuda");
    expect(JSON.stringify(f.requests[1].body)).toContain("native receipt");
  }, 30_000);

  it("preserves image/video tool arguments and task receipts through the existing Tuda adapter", async () => {
    const image = { boardId: "board-3", providerId: "toapis", model: "selected-image-model", prompt: "电商主图", referencePaths: ["managed/reference.png"], size: "9:16", n: 1 };
    const video = { boardId: "board-3", model: "selected-video-model", prompt: "镜头缓慢推进", referenceImagePaths: ["managed/reference.png"], durationSeconds: 5, aspectRatio: "9:16" };
    const f = await fixture([{ name: "generate_image", args: image }, { name: "generate_video", args: video }, "图片和视频任务已受理。"]);
    f.resources.settings.providers = [{ id: "toapis", name: "ToAPIs", type: "openai-compatible", transport: "toapiscli", baseUrl: "", generationEndpoint: "", model: "selected-image-model", supportsReferenceImages: true }];
    const bridge = vi.fn(async (_directory: string, method: string) => method === "generate_image" ? { generationId: "image-task" } : { videoGenerationId: "video-task" });
    const tools = createTudaAgentTools(f.root, { boardId: "board-3", preserveView: true }, bridge);
    await new TudaAgentService().run({ connection: f.transport.getAgentConnection(), request: { ...f.request, instruction: "按指定模型分别生成一张图片和一个视频" }, resources: f.resources,
      systemPrompt: "Tuda Agent", tools: tools as unknown as Parameters<TudaAgentService["run"]>[0]["tools"], onDelta: vi.fn() });
    expect(bridge).toHaveBeenNthCalledWith(1, f.root, "generate_image", { ...image, preserveView: true });
    expect(bridge).toHaveBeenNthCalledWith(2, f.root, "generate_video", { ...video, preserveView: true });
    expect(JSON.stringify(f.requests[2].body)).toContain("image-task");
    expect(JSON.stringify(f.requests[2].body)).toContain("video-task");
  }, 30_000);

  it("keeps Codex OAuth refresh in Tuda's authorization service", async () => {
    const auth = { getAccess: vi.fn(async (_id: string, refresh?: boolean) => ({ accessToken: refresh ? "fresh-token" : "old-token", accountId: "account" })), markReauthRequired: vi.fn() };
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(new Response("ok"));
    const transport = new CodexOAuthTextTransport(auth as never, "employee", "model", fetch);
    const connection = transport.getAgentConnection();
    expect((await connection.getAuth()).apiKey).toBe("old-token");
    const response = await connection.fetch!("https://chatgpt.com/backend-api/codex/responses", { headers: { Authorization: "Bearer old-token" } });
    expect(response.ok).toBe(true);
    expect(auth.getAccess).toHaveBeenLastCalledWith("employee", true);
    expect(new Headers(fetch.mock.calls[1][1].headers).get("Authorization")).toBe("Bearer fresh-token");
    expect(auth.markReauthRequired).not.toHaveBeenCalled();
  });

  it("creates a Skill with the enabled write tool and loads it on the next turn", async () => {
    const f = await fixture([]);
    const skill = path.join(f.resources.agentDir, "skills", "native-fixture", "SKILL.md");
    const replies = [{ name: "write", args: { path: skill,
      content: "---\nname: native-fixture\ndescription: Native harness fixture\n---\n\nUse fixture-marker-unique.\n" } }, "Skill 已创建。", "Skill 已加载。"];
    // This fixture's queue is shared with the HTTP server.
    const g = await fixture(replies);
    g.resources = { ...f.resources, settings: { ...f.resources.settings, piAgentBuiltinTools: ["read", "write"] } };
    const agent = new TudaAgentService();
    await agent.run({ connection: g.transport.getAgentConnection(), request: { ...g.request, instruction: "创建测试 Skill" },
      resources: g.resources, systemPrompt: "Tuda Agent", tools: [], onDelta: vi.fn() });
    expect(await readFile(skill, "utf8")).toContain("fixture-marker-unique");
    const reloaded = await agent.run({ connection: g.transport.getAgentConnection(), request: { ...g.request, instruction: "/reload" },
      resources: g.resources, systemPrompt: "Tuda Agent", tools: [], onDelta: vi.fn() });
    expect(reloaded.message).toContain("重新加载");
    expect(g.requests).toHaveLength(2);
    await agent.run({ connection: g.transport.getAgentConnection(), request: { ...g.request, instruction: "检查", selectedSkillPath: skill },
      resources: g.resources, systemPrompt: "Tuda Agent", tools: [], onDelta: vi.fn() });
    expect(JSON.stringify(g.requests[2].body.messages)).toContain("fixture-marker-unique");
  }, 30_000);

  it("persists native compaction and continues from the compacted conversation", async () => {
    const f = await fixture(["first-round background ".repeat(5000), "second-round background ".repeat(5000), "这是压缩后的对话摘要，保留画板和目标。", "压缩后的对话摘要：保留当前轮次的背景。", "继续压缩后的方案。"]);
    const run = (instruction: string) => new TudaAgentService().run({ connection: f.transport.getAgentConnection(),
      request: { ...f.request, instruction }, resources: f.resources, systemPrompt: "Tuda Agent", tools: [], onDelta: vi.fn() });
    await run("先讨论方案");
    await run("继续讨论方案");
    const result = await run("/compact");
    expect(result.message).toContain("已整理");
    const directory = tudaSessionDirectory(f.resources.agentDir, f.request.conversationId!);
    const files = await readdir(directory);
    const saved = await readFile(path.join(directory, files.find((file) => file.endsWith(".jsonl"))!), "utf8");
    expect(saved.split("\n").filter(Boolean).map((line) => JSON.parse(line).type)).toContain("compaction");
    await run("继续");
    expect(JSON.stringify(f.requests.at(-1)?.body)).toContain("压缩后的对话摘要");
  }, 30_000);

  it("rejects concurrent runs and aborts a pending native request", async () => {
    const f = await fixture([], "openai-chat-completions", true);
    const controller = new AbortController();
    const agent = new TudaAgentService();
    const ready = new Promise<void>((resolve) => { f.resources.onSessionReady = () => resolve(); });
    const pending = agent.run({ connection: f.transport.getAgentConnection(), request: f.request, resources: f.resources,
      systemPrompt: "Tuda Agent", tools: [], onDelta: vi.fn(), signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("已停止执行");
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("session-ready timeout")), 4000))]);
    await expect(agent.run({ connection: f.transport.getAgentConnection(), request: f.request, resources: f.resources,
      systemPrompt: "Tuda Agent", tools: [], onDelta: vi.fn() })).rejects.toThrow("该会话仍在执行");
    controller.abort(); await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error("abort timeout")), 4000))]);
  }, 30_000);
});
