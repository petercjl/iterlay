import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
import { executionContext } from "./execution-space.js";

type Context = { conversationId?: string; requestId?: string; providerId?: string; model?: boolean };
export interface ModelNetworkEvidence {
  id: string; at: string; conversationId?: string; requestId?: string; providerId?: string;
  method: string; origin: string; path: string; status?: number; durationMs?: number;
  remoteAddress?: string; remotePort?: number; errorCode?: string;
  state: "request" | "headers" | "completed" | "failed";
}
const context = new AsyncLocalStorage<Context>();
const records: Array<{ scope: string; evidence: ModelNetworkEvidence }> = [];
const pending = new WeakMap<object, { evidence: ModelNetworkEvidence; started: number }>();
let subscribed = false;
const scope = () => JSON.stringify([executionContext().account, executionContext().space]);
export function withModelTrace<T>(value: Context, work: () => T): T {
  return context.run({ ...context.getStore(), ...value }, work);
}
/** Only allowlisted metadata is retained; headers, query strings and bodies are never read. */
export function installModelNetworkAudit() {
  if (subscribed) return;
  subscribed = true;
  channel("undici:request:create").subscribe((message) => {
    const { request } = message as { request: { origin: string; path: string; method: string } };
    const active = context.getStore();
    if (!active?.model) return;
    const url = new URL(request.path, String(request.origin));
    const evidence: ModelNetworkEvidence = { id: randomUUID(), at: new Date().toISOString(),
      conversationId: active.conversationId, requestId: active.requestId, providerId: active.providerId,
      method: request.method, origin: url.origin, path: url.pathname, state: "request" };
    records.push({ scope: scope(), evidence });
    if (records.length > 500) records.shift();
    pending.set(request, { evidence, started: performance.now() });
  });
  channel("undici:client:sendHeaders").subscribe((message) => {
    const { request, socket } = message as { request: object; socket: { remoteAddress?: string; remotePort?: number } };
    const item = pending.get(request);
    if (item) Object.assign(item.evidence, { remoteAddress: socket.remoteAddress, remotePort: socket.remotePort });
  });
  channel("undici:request:headers").subscribe((message) => {
    const { request, response } = message as { request: object; response: { statusCode: number } };
    const item = pending.get(request);
    if (item) Object.assign(item.evidence, { status: response.statusCode, state: "headers", durationMs: Math.round(performance.now() - item.started) });
  });
  channel("undici:request:trailers").subscribe((message) => {
    const item = pending.get((message as { request: object }).request);
    if (item) Object.assign(item.evidence, { state: "completed", durationMs: Math.round(performance.now() - item.started) });
  });
  channel("undici:request:error").subscribe((message) => {
    const { request, error } = message as { request: object; error: { code?: string } };
    const item = pending.get(request);
    if (item) Object.assign(item.evidence, { state: "failed", errorCode: /^[A-Z_0-9]{1,80}$/.test(error.code ?? "") ? error.code : "REQUEST_FAILED", durationMs: Math.round(performance.now() - item.started) });
  });
}
export function readModelNetworkEvidence(conversationId?: string) {
  return records.filter((item) => item.scope === scope() && (!conversationId || item.evidence.conversationId === conversationId)).map((item) => ({ ...item.evidence }));
}
