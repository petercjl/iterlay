import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { fail, ServiceError, type ServerConfig } from "./config.js";
import { Database } from "./database.js";
import { AuthService, type DingTalkIdentityProvider, type Principal } from "./auth.js";
import { BoardsService, BoardTransaction, assetUrl, type BoardEvent, boardChannels } from "./boards.js";
import { AssetsService } from "./assets.js";
import { ProvidersService } from "./providers.js";
import { JobsService } from "./jobs.js";
import { createAssetResponse } from "../../electron/asset-response.js";
import type { BoardDetail, AssetVersion, ReferenceImagePayload } from "../../shared/types.js";
import type { EnterprisePresence } from "../../shared/enterprise.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 48 * 1024 * 1024) fail(413, "BODY_TOO_LARGE", "请求内容超过大小限制。"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { fail(400, "INVALID_JSON", "请求格式无效。"); }
}
function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(data));
}
const bearer = (request: IncomingMessage) => /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";

export async function createEnterpriseServer(config: ServerConfig, identity?: DingTalkIdentityProvider) {
  const db = new Database(config.databaseUrl); try { await db.initialize(); } catch (error) { await db.close(); throw error; }
  const auth = new AuthService(db, config, identity), assets = new AssetsService(db, config), providers = new ProvidersService(db, config), jobs = new JobsService(db, config, assets, providers);
  interface Connection { user: Principal; token: string; clientId: string; presence: EnterprisePresence; ready: boolean; alive: boolean }
  const connections = new Map<WebSocket, Connection>();
  const send = (socket: WebSocket, data: unknown) => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 32 * 1024 * 1024) socket.send(JSON.stringify(data)); else socket.close(1013, "Slow connection"); };
  const broadcast = (orgId: string, events: BoardEvent[]) => { for (const [socket, connection] of connections) if (connection.user.orgId === orgId) for (const event of events) send(socket, event); };
  const boards = new BoardsService(db, broadcast);
  const presence = (orgId: string) => {
    const peers = [...connections.values()].filter(value => value.user.orgId === orgId).map(value => value.presence);
    for (const [socket, connection] of connections) if (connection.user.orgId === orgId) send(socket, { type: "presence", peers: peers.filter(peer => peer.boardId && peer.boardId === connection.presence.boardId) });
  };
  const limits = new Map<string, { count: number; until: number }>();
  const limit = (key: string, maximum: number) => {
    if (limits.size > 10_000) for (const [id, value] of limits) if (value.until < Date.now()) limits.delete(id);
    let entry = limits.get(key);
    if (!entry || entry.until < Date.now()) { entry = { count: 0, until: Date.now() + 60_000 }; limits.set(key, entry); }
    if (++entry.count > maximum) fail(429, "RATE_LIMIT", "操作过于频繁，请稍后重试。");
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", config.publicUrl);
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, version: "0.1.0", authConfigured: auth.configured, organizationName: config.organizationName });
      if (request.method === "POST" && url.pathname === "/api/auth/start") {
        limit("login:" + request.socket.remoteAddress, 20);
        const endpoint = new URL(config.publicUrl);
        if (auth.configured && !config.allowHttpLogin && endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) fail(503, "HTTPS_REQUIRED", "请先为企业登录配置 HTTPS 服务地址。");
        return json(response, 200, await auth.begin());
      }
      if (request.method === "POST" && url.pathname === "/api/auth/poll") {
        limit("poll:" + request.socket.remoteAddress, 120);
        const input = await body(request); return json(response, 200, await auth.poll(String(input.loginId ?? ""), String(input.verifier ?? "")));
      }
      if (request.method === "GET" && url.pathname === "/auth/dingtalk/callback") {
        await auth.callback(url.searchParams.get("state") ?? "", url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "");
        response.writeHead(200, { "content-type": "text/html;charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
        response.end("<!doctype html><meta charset=utf-8><title>Tuda 登录成功</title><style>body{font:20px system-ui;padding:80px;color:#0755f5}</style><h1>Tuda · 图塔</h1><p>企业身份验证成功，请返回 Tuda 桌面应用。</p>"); return;
      }
      const token = bearer(request), user = await auth.authenticate(token);
      limit(user.orgId + ":" + user.id, 1200);
      if (request.method === "GET" && url.pathname === "/api/me") return json(response, 200, { organizationId: user.orgId, organizationName: config.organizationName, user: { id: user.id, name: user.name, role: user.role }, providers: await providers.metadata(user.orgId, user.id) });
      if (url.pathname === "/api/provider-accounts") {
        if (request.method === "GET") return json(response, 200, await providers.read(user, url.searchParams.get("userId") ?? user.id));
        if (request.method === "PATCH") { const input = await body(request); await providers.assign(user, input as Parameters<ProvidersService["assign"]>[1]); for (const [socket, connection] of connections) if (connection.user.orgId === user.orgId && connection.user.id === input.userId) send(socket, { type: "configuration" }); return json(response, 200, { ok: true }); }
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") { await auth.logout(token); return json(response, 200, { ok: true }); }
      if (request.method === "GET" && url.pathname.startsWith("/api/assets/")) {
        const asset = await assets.locate(user.orgId, url.pathname.slice("/api/assets/".length));
        const headers = new Headers(); if (request.headers.range) headers.set("range", request.headers.range);
        const result = await createAssetResponse(new Request(url, { headers }), () => asset.absolutePath);
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) for await (const chunk of result.body as unknown as AsyncIterable<Uint8Array>) { if (!response.write(chunk)) await new Promise<void>(resolve => response.once("drain", resolve)); }
        response.end(); return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) return json(response, 200, await jobs.get(user, url.pathname.slice(10)));
      if (url.pathname === "/api/members" && user.role === "admin") {
        if (request.method === "GET") { const result = await db.pool.query("SELECT user_id AS id,name,role,active FROM tuda_members WHERE org_id=$1 ORDER BY name", [user.orgId]); return json(response, 200, result.rows); }
        if (request.method === "PATCH") {
          const input = await body(request);
          if (typeof input.id !== "string" || !["admin", "editor", "viewer"].includes(input.role) || typeof input.active !== "boolean") fail(400, "INVALID_MEMBER", "成员设置无效。");
          await db.transaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.orgId]);
            const target = await client.query("SELECT role FROM tuda_members WHERE org_id=$1 AND user_id=$2", [user.orgId, input.id]);
            const admins = await client.query("SELECT count(*) FROM tuda_members WHERE org_id=$1 AND role='admin' AND active=true", [user.orgId]);
            if (target.rows[0]?.role === "admin" && Number(admins.rows[0].count) <= 1 && (!input.active || input.role !== "admin")) fail(409, "ADMIN_REQUIRED", "企业必须保留一位有效管理员。");
            await client.query("UPDATE tuda_members SET role=$3,active=$4 WHERE org_id=$1 AND user_id=$2", [user.orgId, input.id, input.role, input.active]);
            await client.query("INSERT INTO tuda_audit(org_id,user_id,action,target) VALUES($1,$2,'member:update',$3)", [user.orgId, user.id, input.id]);
          });
          for (const [socket, connection] of connections) if (connection.user.orgId === user.orgId && connection.user.id === input.id) socket.close(4001, "Permissions changed");
          return json(response, 200, { ok: true });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/text/v1/chat/completions") {
        const account = await providers.resolve(user.orgId, user.id, "text");
        if (!account) fail(503, "TEXT_PROVIDER_NOT_CONFIGURED", "管理员尚未配置企业对话模型。");
        const input = await body(request);
        if (user.role === "viewer") fail(403, "READ_ONLY", "只读成员不能调用企业模型。 ");
        if (input.model && input.model !== account.model) fail(400, "MODEL_UNSUPPORTED", "请选择管理员配置的企业模型。");
        if (!Array.isArray(input.messages) || input.messages.length > 200) fail(400, "INVALID_MESSAGES", "对话内容无效。");
        const upstream = await fetch(account.baseUrl.replace(/\/$/, "") + "/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${account.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ ...input, model: account.model }), signal: AbortSignal.timeout(180_000) });
        if (!upstream.ok) { await upstream.body?.cancel(); fail(502, "TEXT_PROVIDER_FAILED", "企业对话服务请求失败。 "); }
        response.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
        if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) response.write(chunk);
        response.end(); return;
      }
      if (request.method === "POST" && url.pathname === "/api/command") {
        const input = await body(request);
        if (typeof input.channel !== "string" || !Array.isArray(input.args) || input.args.length > 16 || !/^[0-9a-f-]{36}$/i.test(input.requestId ?? "")) fail(400, "INVALID_COMMAND", "企业操作参数无效。");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
        const channel = input.channel as string, args = input.args as any[], origin = String(request.headers["x-tuda-client"] ?? "").slice(0, 100);
        if (channel === "assets:jobPrompt") {
          const job = await db.pool.query("SELECT input FROM tuda_jobs WHERE org_id=$1 AND id::text=$2", [user.orgId, String(args[0])]);
          const input = job.rows[0]?.input;
          return json(response, 200, { prompt: input?.prompt ?? "", promptSpec: input?.promptSpec, referenceImages: (input?.referenceImages ?? []).map((reference: ReferenceImagePayload) => `data:${reference.mimeType};base64,${reference.dataBase64}`) });
        }
        if (channel === "assets:detail" || channel === "assets:item") {
          const board = await boards.command(user, "boards:get", [args[0]], randomUUID(), origin) as BoardDetail | null;
          const node = board?.nodes.find(node => node.id === args[1]);
          if (!node || !("imagePath" in node)) return json(response, 200, channel === "assets:item" ? null : { versions: [], activeVersion: 0 });
          const sources = node.versions?.length ? node.versions : [{ imagePath: node.imagePath, jobId: node.jobId, width: node.width, height: node.height }];
          const versions: AssetVersion[] = [];
          for (const value of sources) {
            const job = await db.pool.query("SELECT input,created_at FROM tuda_jobs WHERE org_id=$1 AND id::text=$2", [user.orgId, value.jobId]);
            const input = job.rows[0]?.input;
            versions.push({ imagePath: value.imagePath, dataUrl: assetUrl(value.imagePath), jobId: value.jobId, prompt: input?.prompt ?? "", promptSpec: input?.promptSpec, useCase: input?.useCase, size: input?.size, model: input?.model, createdAt: job.rows[0]?.created_at?.toISOString() ?? board!.createdAt, references: [] });
          }
          if (channel === "assets:detail") return json(response, 200, { versions, activeVersion: node.activeVersion ?? versions.length - 1 });
          const active = versions[node.activeVersion ?? versions.length - 1];
          return json(response, 200, { ...active, thumbnailUrl: active.dataUrl, boardId: board!.id, boardName: board!.name, nodeId: node.id, width: node.width, height: node.height, source: node.source, favorite: false, tags: [] });
        }
        if (boardChannels.has(channel)) return json(response, 200, await boards.command(user, channel, args, input.requestId, origin));
        if (channel === "asset:importUpload") {
          if (user.role === "viewer") fail(403, "READ_ONLY", "只读成员不能上传素材。");
          return json(response, 200, await assets.upload(user.orgId, args[0]));
        }
        if (channel === "asset:readDataUrl") return json(response, 200, await assets.dataUrl(user.orgId, args[0]));
        if (channel === "asset:thumbnail") { await assets.locate(user.orgId, args[0]); return json(response, 200, assetUrl(args[0])); }
        if (channel === "image:generate") return json(response, 200, await jobs.submit(user, args[0], input.requestId));
        if (channel === "image:cancel") return json(response, 200, await jobs.cancel(user, args[0]));
        if (channel === "history:list") return json(response, 200, await jobs.list(user, args[0]));
        if (channel === "history:scenes") return json(response, 200, []);
        if (channel === "history:page") { const items = await jobs.list(user, args[0]); return json(response, 200, { items, nextCursor: undefined }); }
        if (channel === "assets:library") return json(response, 200, await assetLibrary(db, user.orgId, args[0], args[1]));
        fail(400, "UNSUPPORTED_ENTERPRISE_OPERATION", "此操作尚未接入企业空间，未写入个人空间。");
      }
      fail(404, "NOT_FOUND", "接口不存在。");
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const known = error instanceof ServiceError;
      const revisionConflict = error instanceof Error && error.message.startsWith("BOARD_REVISION_CONFLICT");
      json(response, known ? error.status : revisionConflict ? 409 : 500, { ok: false, error: { code: known ? error.code : revisionConflict ? "BOARD_REVISION_CONFLICT" : "SERVER_ERROR", message: known ? error.message : revisionConflict ? "画板版本已更新，请重新打开后重试。" : "企业服务操作失败，请检查服务日志。" } });
      if (!known) console.error("Enterprise request failed:", error instanceof Error ? error.name : "UnknownError");
    });
  });
  server.requestTimeout = 180_000; server.headersTimeout = 15_000;
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    if ((request.url ?? "").split("?")[0] !== "/api/collaboration") { socket.destroy(); return; }
    websocket.handleUpgrade(request, socket, head, ws => websocket.emit("connection", ws, request));
  });
  websocket.on("connection", socket => {
    const deadline = setTimeout(() => socket.close(4001, "Authentication required"), 8000);
    let chain = Promise.resolve();
    socket.on("message", data => {
      chain = chain.then(async () => {
        const message = JSON.parse(data.toString());
        const current = connections.get(socket);
        if (!current) {
          if (message.type !== "authenticate" || typeof message.token !== "string" || !/^[0-9a-f-]{36}$/i.test(message.clientId ?? "")) fail(401, "SESSION_REQUIRED", "需要登录。");
          const user = await auth.authenticate(message.token), connectionId = randomUUID();
          connections.set(socket, { user, token: message.token, clientId: message.clientId, ready: true, alive: true, presence: { id: user.id, name: user.name, role: user.role, connectionId } });
          clearTimeout(deadline); send(socket, { type: "ready", connectionId }); presence(user.orgId); return;
        }
        const user = await auth.authenticate(current.token);
        limit("ws:" + current.clientId, 600);
        current.user = user;
        if (message.type === "presence") {
          const boardId = typeof message.boardId === "string" ? message.boardId : undefined;
          if (boardId) {
            const row = await db.pool.query("SELECT id FROM tuda_boards WHERE org_id=$1 AND id=$2", [user.orgId, boardId]);
            if (!row.rowCount) fail(403, "BOARD_DENIED", "无权进入此画板。");
          }
          const cursor = message.cursor && Number.isFinite(message.cursor.x) && Number.isFinite(message.cursor.y) ? { x: Number(message.cursor.x), y: Number(message.cursor.y) } : undefined;
          current.presence = { id: user.id, name: user.name, role: user.role, connectionId: current.presence.connectionId, boardId, cursor,
            selectedNodeIds: Array.isArray(message.selectedNodeIds) ? message.selectedNodeIds.filter((id: unknown) => typeof id === "string").slice(0, 100) : [] };
          presence(user.orgId);
        }
      }).catch(() => socket.close(4001, "Invalid or unauthorized message"));
    });
    socket.on("close", () => { clearTimeout(deadline); const current = connections.get(socket); connections.delete(socket); if (current) presence(current.user.orgId); });
    socket.on("pong", () => { const connection = connections.get(socket); if (connection) connection.alive = true; });
    socket.on("error", () => socket.close());
  });
  const heartbeat = setInterval(() => {
    for (const [socket, current] of connections) void auth.authenticate(current.token).then(user => { if (!current.alive) { socket.terminate(); return; } current.alive = false; current.user = user; socket.ping(); }).catch(() => socket.close(4001, "Session expired"));
  }, 30_000); heartbeat.unref();
  let closing = false;
  let listener: import("pg").PoolClient | undefined;
  let listenerRetry: ReturnType<typeof setTimeout> | undefined;
  const subscribe = async () => {
    if (closing) return;
    try {
      const connection = await db.pool.connect();
      if (closing) { connection.release(); return; }
      listener = connection;
      connection.on("notification", notification => {
        if (!notification.payload || closing) return;
        void (async () => {
          const input = JSON.parse(notification.payload!);
          if (input.orgId !== config.organizationId || !Array.isArray(input.boardIds)) return;
          const reader = await db.pool.connect();
          try {
            for (const id of new Set<string>(input.boardIds)) {
              const envelope = await new BoardTransaction(reader, input.orgId).envelope(id);
              if (envelope) broadcast(input.orgId, [{ type: "board", boardId: id, revision: envelope.board.revision, state: envelope.state, epoch: envelope.epoch }]);
            }
          } finally { reader.release(); }
        })().catch(() => console.error("Enterprise worker notification failed"));
      });
      connection.on("error", () => {
        if (listener !== connection) return;
        listener = undefined; connection.release(true);
        if (!closing) { for (const socket of connections.keys()) socket.close(1012, "Service reconnect required"); listenerRetry = setTimeout(() => void subscribe(), 2000); }
      });
      await connection.query("LISTEN tuda_changes");
    } catch {
      if (listener) { listener.release(true); listener = undefined; }
      if (!closing) listenerRetry = setTimeout(() => void subscribe(), 2000);
    }
  };
  await subscribe();
  return { server, db, auth, boards, jobs, config,
    async listen() { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); }); return server.address(); },
    async close() { closing = true; clearTimeout(listenerRetry); clearInterval(heartbeat); for (const socket of connections.keys()) socket.terminate(); websocket.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (listener) { const connection = listener; listener = undefined; await connection.query("UNLISTEN *").catch(() => undefined); connection.release(); } await db.close(); } };
}

async function assetLibrary(db: Database, orgId: string, cursor?: string, limit = 50) {
  const count = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = await db.pool.query("SELECT * FROM tuda_assets WHERE org_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3", [orgId, cursor && /^[0-9a-f-]{36}$/i.test(cursor) ? cursor : null, count + 1]);
  const items = rows.rows.slice(0, count).map(row => ({ id: row.id, path: "tuda-enterprise:" + row.id, imagePath: "tuda-enterprise:" + row.id, dataUrl: assetUrl("tuda-enterprise:" + row.id), thumbnailUrl: assetUrl("tuda-enterprise:" + row.id), boardId: "", boardName: "企业素材", nodeId: "", jobId: "", prompt: "", createdAt: new Date(row.created_at).toISOString(), mimeType: row.mime, size: Number(row.size), source: "upload", favorite: false, tags: [], boardIds: [] }));
  const total = await db.pool.query("SELECT count(*) FROM tuda_assets WHERE org_id=$1", [orgId]);
  return { items, total: Number(total.rows[0].count), nextCursor: rows.rowCount! > count ? items.at(-1)?.id : undefined };
}
