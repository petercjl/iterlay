import { assertBoardPluginMethod } from "./board-plugin-tools.js";
import { createMainWorkbenchApi } from "./application/workbench-api.js";
import { WorkspaceCommands } from "./application/workspace-commands.js";
import { flushWindow } from "./window-lifecycle.js";
import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { executionContext } from "./execution-space.js";
import { createHash } from "node:crypto";

const BRIDGE_FILE = "local-api.json";

export async function startLocalApi(window: BrowserWindow | (() => BrowserWindow | null), userDataPath: string, showWindow?: () => void, acceptHostHandoff?: (value: unknown) => Promise<unknown>, authorizeHostOperation?: () => Promise<void>, quitHost?: () => Promise<void>): Promise<() => void> {
  const token = randomBytes(32).toString("base64url");
  const bridgePath = path.join(userDataPath, BRIDGE_FILE);
  const getWindow = typeof window === "function" ? window : () => window;
  const initialWindow = getWindow();
  if (!initialWindow || initialWindow.isDestroyed()) throw new Error("没有可用的 Tuda 窗口。");
  const runtimes=new Map<string,WorkspaceCommands>();
  const runtime = (space?:unknown) => {
    const context={...executionContext(),...(space===undefined?{}:{space})}, key=JSON.stringify(context);
    let current=runtimes.get(key);if(current)return current;
    current=new WorkspaceCommands({
    api: createMainWorkbenchApi(initialWindow),
    flush: async () => { const active = getWindow(); if (active) await flushWindow(active); },
    emit: (event) => { const active = getWindow(); if (active && !active.isDestroyed()) active.webContents.send("workbench:event", event); },
    taskDirectory: context.account ? path.join(userDataPath,"company-cli",context.account,createHash("sha256").update(key).digest("hex")) : path.join(userDataPath, "workspace", "cli-tasks")
  });runtimes.set(key,current);return current;
  };
  const server = createServer((request, response) => {
    void handleRequest(runtime, token, request, response, showWindow ?? (() => { const active = getWindow(); if (active && !active.isDestroyed()) { active.show(); active.focus(); } }), acceptHostHandoff, authorizeHostOperation, quitHost);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动本地 CLI 桥接服务。");
  await writeFile(bridgePath, JSON.stringify({ port: address.port, token }), { encoding: "utf8", mode: 0o600 });
  return () => {
    server.closeAllConnections();
    server.close();
    void unlink(bridgePath).catch(() => undefined);
  };
}

export { callLocalApi } from "./local-api-client.js";

async function handleRequest(
  runtime: (space?:unknown) => WorkspaceCommands,
  token: string,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  showWindow: () => void,
  acceptHostHandoff?: (value: unknown) => Promise<unknown>,
  authorizeHostOperation?: () => Promise<void>,
  quitHost?: () => Promise<void>
): Promise<void> {
  if (request.method !== "POST" || !["/call", "/board-plugin/call", "/board-plugin/auth", "/board-plugin/host/quit"].includes(request.url ?? "") || request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 32 * 1024 * 1024) throw new Error("CLI 请求超过 32 MB 限制。");
      chunks.push(buffer);
    }
    const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: string; args?: Record<string, unknown> };
    if (request.url === "/board-plugin/host/quit") {
      if (process.env.TUDA_EMBEDDED_HOST !== "codex-own" || !quitHost) throw new Error("HOST_QUIT_DENIED");
      await quitHost();
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: { quitting: true } }));
      return;
    }
    if (request.url === "/board-plugin/auth") {
      if (!acceptHostHandoff || bytes > 16384) throw new Error("AUTH_HANDOFF_UNAVAILABLE");
      const result = await acceptHostHandoff(requestBody);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
      return;
    }
    if (typeof requestBody.method !== "string" || !requestBody.args || typeof requestBody.args !== "object" || Array.isArray(requestBody.args)) throw new Error("CLI 请求参数无效。");
    if (request.url === "/board-plugin/call") {
      assertBoardPluginMethod(requestBody.method);
      const forcedSpace = process.env.TUDA_SPACE || process.env.TUDA_PLUGIN_SPACE;
      if (forcedSpace) {
        if (!["personal", "enterprise"].includes(forcedSpace) || (requestBody.args.space && requestBody.args.space !== forcedSpace)) throw new Error("SPACE_MISMATCH");
        requestBody.args.space = forcedSpace;
        if (forcedSpace === "enterprise") {
          if (!authorizeHostOperation) throw new Error("COMPANY_AUTH_REQUIRED");
          await authorizeHostOperation();
        }
      }
    }
    if (["open_tuda", "open_iterlay"].includes(requestBody.method)) showWindow();
    const result = await runtime(requestBody.args.space).call(requestBody.method, requestBody.args);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result }));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: request.url === "/board-plugin/auth" ? "AUTH_HANDOFF_FAILED" : error instanceof Error ? error.message : "请求失败。" }));
  }
}
