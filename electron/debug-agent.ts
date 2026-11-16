import { randomUUID, createHash } from "node:crypto";
import type { CreationSession, CreationSessionMessage } from "../shared/creation-session.js";
import type { CollaborateSceneRequest, CollaborateSceneStreamEvent } from "../shared/types.js";
import { mergeAssistantToolCall } from "../shared/assistant-display.js";
import { executionContext } from "./execution-space.js";
import { readModelNetworkEvidence } from "./debug-network.js";

type Args = Record<string, unknown>;
interface Dependencies {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  start(requestId: string, request: CollaborateSceneRequest, receive: (event: CollaborateSceneStreamEvent) => void): void;
  cancel(requestId: string): void;
  respond(payload: unknown): void;
}
interface Run {
  id: string; session: CreationSession; fingerprint: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  events: CollaborateSceneStreamEvent[]; pendingSave: Promise<unknown>;
}
const text = (value: unknown, label: string, max = 128) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`无效的${label}。`);
  return value.trim();
};
/** An authenticated local adapter to the existing UI harness and conversation store. */
export class TudaDebugAgent {
  private runs = new Map<string, Run>();
  private requests = new Map<string, Run>();
  constructor(private deps: Dependencies) {}
  private scope() { const c = executionContext(); return JSON.stringify([c.account, c.space]); }
  private async sessions() { return await this.deps.invoke("creation:sessions:list", []) as CreationSession[]; }
  private async session(id: string) {
    const run = this.runs.get(this.scope() + id);
    if (run) { await run.pendingSave; if (["running", "waiting"].includes(run.status)) return run.session; }
    const session = (await this.sessions()).find((item) => item.id === id);
    if (!session) throw new Error("当前账号与空间中没有这个对话。");
    return session;
  }
  private save(run: Run) {
    const snapshot = structuredClone(run.session);
    run.pendingSave = run.pendingSave.then(() => this.deps.invoke("creation:sessions:save", [snapshot]));
    // A caller observes storage failures through get/result; avoid detached rejection.
    void run.pendingSave.catch(() => undefined);
  }
  private mutation: Promise<unknown> = Promise.resolve();
  call(method: string, args: Args): Promise<unknown> {
    if (!["debug_chats_create", "debug_chats_send", "debug_chats_cancel", "debug_chats_respond"].includes(method)) return this.execute(method,args);
    const result = this.mutation.then(() => this.execute(method,args));
    this.mutation = result.catch(() => undefined);
    return result;
  }
  private async execute(method: string, args: Args): Promise<unknown> {
    if (method === "debug_network") return { source: "node-undici-wire", retention: "latest 500 requests in this desktop process", requests: readModelNetworkEvidence(typeof args.conversationId === "string" ? args.conversationId : undefined) };
    if (method === "debug_chats_list") return (await this.sessions()).map(({ id, title, updatedAt, boardId, messages }) => ({ id, title, updatedAt, boardId, messageCount: messages.length }));
    if (method === "debug_chats_create") {
      const now = new Date().toISOString();
      const session: CreationSession = { id: randomUUID(), title: text(args.name ?? "CLI 调试对话", "名称", 100), titleSource: "manual", createdAt: now, updatedAt: now,
        ...(args.boardId ? { boardId: text(args.boardId, "画板 ID") } : {}), draft: "", queued: [], references: [], messages: [], events: [], artifacts: [] };
      await this.deps.invoke("creation:sessions:save", [session]); return session;
    }
    const id = text(args.conversationId, "对话 ID");
    const session = await this.session(id), key = this.scope() + id;
    const run = this.runs.get(key);
    if (method === "debug_chats_get") return session;
    if (method === "debug_chats_events") return { conversationId: id, status: run?.status ?? (session.activeRunId ? "interrupted" : "idle"), events: session.events, streamEvents: run?.events ?? [],
      history: await this.deps.invoke("assistant:history:list", [{ conversationId: id }]), network: readModelNetworkEvidence(id) };
    if (method === "debug_chats_result") return { conversationId: id, requestId: run?.id, status: run?.status ?? (session.activeRunId ? "interrupted" : "idle"), message: [...session.messages].reverse().find((m) => m.role === "assistant" || m.role === "error"),
      interaction: run?.status === "waiting" ? [...run.events].reverse().find((e) => e.type === "interaction") : undefined };
    if (method === "debug_chats_cancel") {
      if (!run || !["running", "waiting"].includes(run.status)) throw new Error("这个对话没有运行中的请求。");
      this.deps.cancel(run.id); return { conversationId: id, requestId: run.id, cancellationRequested: true };
    }
    if (method === "debug_chats_respond") {
      if (!run || run.status !== "waiting") throw new Error("这个对话没有待确认的问题。");
      const interactionId = text(args.interactionId, "交互 ID");
      const pending = [...run.events].reverse().find((e) => e.type === "interaction");
      if (pending?.type !== "interaction" || pending.interactionId !== interactionId || !["submit", "dismiss"].includes(String(args.action))) throw new Error("交互 ID 或 action 无效。");
      this.deps.respond({ requestId: run.id, interactionId, action: args.action, values: args.values }); run.status = "running";
      return { conversationId: id, accepted: true };
    }
    if (method !== "debug_chats_send") throw new Error("不支持的调试操作。");
    const prompt = text(args.prompt, "消息", 100_000), requestId = text(args.requestId ?? randomUUID(), "请求 ID");
    const fingerprint = createHash("sha256").update(JSON.stringify([id,prompt,args.providerId])).digest("hex");
    const duplicate = this.requests.get(this.scope() + requestId);
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint) throw new Error("请求 ID 已用于不同内容。");
      return { conversationId: id, requestId, status: duplicate.status, reused: true };
    }
    if (run && ["running", "waiting"].includes(run.status)) throw new Error("此对话正在执行，请读取结果或取消后再发送。");
    if (session.activeRunId && !run) throw new Error("此对话可能由界面执行中，请新建调试对话。");
    const conversation = session.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    const assistant: CreationSessionMessage = { id: randomUUID(), role: "assistant", content: "", toolCalls: [], activitySteps: [] };
    session.messages.push({ id: randomUUID(), role: "user", content: prompt }, assistant);
    session.activeRunId = requestId; session.updatedAt = new Date().toISOString();
    session.events.push({ id: randomUUID(), kind: "run", runId: requestId, status: "running", label: "CLI 调试", at: session.updatedAt });
    const next: Run = { id: requestId, fingerprint, session, status: "running", events: [], pendingSave: Promise.resolve() };
    this.runs.set(key,next); this.requests.set(this.scope() + requestId,next);
    // Bound completed request receipts; active requests remain addressable.
    if (this.requests.size > 200) for (const [receipt, item] of this.requests) { if (!["running", "waiting"].includes(item.status)) { this.requests.delete(receipt); for (const [runKey, cached] of this.runs) if (cached === item) this.runs.delete(runKey); break; } }
    this.save(next); await next.pendingSave;
    const receive = (event: CollaborateSceneStreamEvent) => {
      if (!["running", "waiting"].includes(next.status)) return;
      // Delta strings already live in messages; retain bounded semantic execution events.
      if (event.type !== "delta" && event.type !== "reasoning-summary") { next.events.push(event); if (next.events.length > 1000) next.events.shift(); }
      if (event.type === "delta") assistant.content += event.delta;
      if (event.type === "reasoning-summary") assistant.reasoningSummary = (assistant.reasoningSummary ?? "") + event.delta;
      if (event.type === "activity") assistant.activitySteps = [...(assistant.activitySteps ?? []), event.label].slice(-100);
      if (event.type === "tool") { assistant.toolCalls = mergeAssistantToolCall(assistant.toolCalls ?? [], event.tool); session.events.push({ id: randomUUID(), kind: "tool", runId: requestId, call: event.tool, at: new Date().toISOString() }); }
      if (event.type === "interaction") { next.status = "waiting"; session.events.push({ id: randomUUID(), kind: "interaction", runId: requestId, status: "requested", label: event.interaction.title, at: new Date().toISOString() }); this.save(next); }
      if (["result", "error", "cancelled"].includes(event.type)) {
        next.status = event.type === "result" ? "completed" : event.type === "error" ? "failed" : "cancelled";
        if (event.type === "result") assistant.content = event.result.message || assistant.content;
        if (event.type === "error") { assistant.role = "error"; assistant.content = event.message; }
        session.activeRunId = undefined; session.updatedAt = new Date().toISOString();
        const status = next.status;
        session.events = session.events.map((e) => e.kind === "run" && e.runId === requestId ? { ...e, status, label: status } : e);
        this.save(next);
      }
    };
    try {
      this.deps.start(requestId, { instruction: prompt, referenceImages: [], currentFields: [], workflowMode: "generate", creationWorkflow: true, agentMode: true,
        conversationId: id, conversation, assistantSurface: "canvas-prompt", ...(session.boardId ? { memoryQuery: { boardId: session.boardId } } : {}),
        ...(args.providerId ? { textProviderId: text(args.providerId, "文本模型 ID", 512) } : {}) }, receive);
    } catch (error) { receive({ requestId, type: "error", message: error instanceof Error ? error.message : "无法启动 Agent。" }); }
    return { conversationId: id, requestId, status: next.status };
  }
}
