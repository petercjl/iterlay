import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { BoardSaveCausality } from "../../shared/enterprise-causality.js";
import { encodeBoardChange } from "../../shared/enterprise-board.js";
import { type EnterpriseSession, type EnterpriseStatus, type SpaceKind } from "../../shared/enterprise.js";
import type { BoardSavePayload } from "../../shared/types.js";
import { createAssetResponse } from "../asset-response.js";

interface Configuration { version: 1; serverUrl: string; activeSpace: SpaceKind; encryptedSession?: string }
interface PendingWrite { requestId: string; channel: string; args: unknown[]; serverUrl: string; organizationId: string; userId: string }
const uuid = /^[0-9a-f-]{36}$/i;

/** Owns the authenticated enterprise session. Tokens never enter renderer state or asset URLs. */
export class EnterpriseClient extends EventEmitter {
  readonly clientId = randomUUID();
  private config: Configuration = { version: 1, serverUrl: "", activeSpace: "personal" };
  private session?: EnterpriseSession;
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private error?: string;
  private connected = false;
  private stopped = false;
  private peers: EnterpriseStatus["peers"] = [];
  private connectionId = "";
  private login?: { loginId: string; verifier: string; expiresAt: string };
  private pendingCount = 0;
  private saveCausality = new BoardSaveCausality();
  private acceptedWrites = new Map<string, unknown>();
  private replaying?: Promise<void>;
  private eventQueue = Promise.resolve();
  private documents = new Map<string, { state: string; epoch: string; revision: number }>();
  private versions = new Map<string, string>();
  private boardIds = new Set<string>();
  private lastBoardId?: string;
  private histories = new Map<string, { doc: Y.Doc; undo: Y.UndoManager }>();
  private metadata?: { providers: { image: boolean; imageModel: string; text: boolean; textModel: string } };
  private storageRefresh?: () => Promise<EnterpriseSession>;
  private renewingStorage?: Promise<void>;
  constructor(readonly userData: string, private flush: () => Promise<void>, private notifyBoard: (boardId: string) => void) { super(); }
  get activeSpace() { return this.config.activeSpace; }
  get authenticated() { return Boolean(this.session && Date.parse(this.session.expiresAt) > Date.now()); }
  get status(): EnterpriseStatus { return { configured: Boolean(this.config.serverUrl), serverUrl: this.config.serverUrl, activeSpace: this.config.activeSpace,
    authenticated: this.authenticated, organizationName: this.session?.organizationName, user: this.session?.user, connected: this.connected,
    pendingWrites: this.pendingCount, peers: this.peers.filter(peer => peer.connectionId !== this.connectionId), error: this.error, history: this.historyStatus() }; }
  private historyStatus() {
    const value = this.lastBoardId ? this.histories.get(this.lastBoardId) : undefined;
    return value && this.lastBoardId ? { boardId: this.lastBoardId, canUndo: value.undo.canUndo(), canRedo: value.undo.canRedo() } : undefined;
  }
  private history(id: string, state?: string) {
    let value = this.histories.get(id);
    if (!value && state) {
      const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(state, "base64"), "server");
      const undo = new Y.UndoManager([doc.getMap("nodes"), doc.getMap("connections"), doc.getMap("groups"), doc.getMap("metadata")], { trackedOrigins: new Set(["local-board-edit"]), captureTimeout: 600 });
      value = { doc, undo }; this.histories.set(id, value);
    }
    return value;
  }
  private applyMutation(value: { boardId: string; state?: string; update?: string }, local = true) {
    const history = this.history(value.boardId, value.state);
    if (history && value.update) Y.applyUpdate(history.doc, Buffer.from(value.update, "base64"), local ? "local-board-edit" : "server");
    if (history && value.state) Y.applyUpdate(history.doc, Buffer.from(value.state, "base64"), "server");
  }
  async undo(boardId: string, direction: "undo" | "redo") {
    await this.flush();
    const value = this.histories.get(boardId), stored = this.documents.get(boardId);
    if (!value || !stored) throw new Error("请先打开企业画板。");
    value.undo.stopCapturing();
    const vector = Y.encodeStateVector(value.doc);
    if (direction === "undo") value.undo.undo(); else if (direction === "redo") value.undo.redo(); else throw new Error("无效历史操作。");
    const update = Y.encodeStateAsUpdate(value.doc, vector);
    await this.durableCommand("boards:save", [{ id: boardId, enterpriseEpoch: stored.epoch, enterpriseUpdate: Buffer.from(update).toString("base64") }], randomUUID());
    this.changed(); this.notifyBoard(boardId);
  }
  private clearHistory() { this.saveCausality.clear(); this.acceptedWrites.clear(); for (const value of this.histories.values()) { value.undo.destroy(); value.doc.destroy(); } this.histories.clear(); this.lastBoardId = undefined; }
  private changed() { this.emit("state", this.status); }
  private get configFile() { return path.join(this.userData, "enterprise.json"); }
  private get namespace() {
    const identity = [this.config.serverUrl, this.session?.organizationId, this.session?.user.id].join(":");
    return path.join(this.userData, "enterprise-cache", createHash("sha256").update(identity).digest("hex"));
  }
  private async save() {
    await mkdir(this.userData, { recursive: true });
    const temporary = this.configFile + "." + randomUUID();
    await writeFile(temporary, JSON.stringify(this.config, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, this.configFile);
  }
  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.configFile, "utf8"));
      if (saved.version !== 1) throw new Error("企业空间配置版本不兼容。");
      this.config = saved;
      if (saved.encryptedSession && safeStorage.isEncryptionAvailable()) {
        const session = JSON.parse(safeStorage.decryptString(Buffer.from(saved.encryptedSession, "base64")));
        if (session.serverUrl === saved.serverUrl && Date.parse(session.value.expiresAt) > Date.now()) this.session = session.value;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = "无法恢复企业登录，请重新登录。"; }
    if (!this.config.serverUrl && process.env.TUDA_ENTERPRISE_URL) this.config.serverUrl = this.validateUrl(process.env.TUDA_ENTERPRISE_URL);
    if (this.session) {
      try { await this.refreshIdentity(); await this.replayPending(); }
      catch (error) { this.error = error instanceof Error ? error.message : "企业服务连接失败。"; }
      if (this.session) this.connect();
    }
    this.changed();
  }
  private validateUrl(input: string) {
    const url = new URL(input);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("请输入企业服务的完整地址，例如 https://tuda.example.com。");
    return url.origin;
  }
  async configure(input: string) {
    const serverUrl = this.validateUrl(input);
    const response = await fetch(serverUrl + "/health", { signal: AbortSignal.timeout(10_000) });
    const health = await response.json() as { ok?: boolean; version?: string };
    if (!response.ok || !health.ok || typeof health.version !== "string") throw new Error("此地址不是可用的 Tuda 企业服务。");
    if (this.config.serverUrl !== serverUrl) {
      await this.flush(); this.disconnect(); this.session = undefined; this.documents.clear(); this.versions.clear(); this.boardIds.clear(); this.clearHistory();
      this.config = { version: 1, serverUrl, activeSpace: this.config.activeSpace };
    }
    await this.save(); this.error = undefined; this.changed(); return this.status;
  }
  private async fetchJson<T>(route: string, options: { method?: string; body?: unknown; authenticated?: boolean } = {}): Promise<T> {
    if(options.authenticated !== false && this.storageRefresh && (!this.session || Date.parse(this.session.expiresAt)<Date.now()+30_000)) {
      this.renewingStorage ??= this.storageRefresh().then(session=>{this.session=session;}).finally(()=>{this.renewingStorage=undefined;});
      await this.renewingStorage;
    }
    if (!this.config.serverUrl) throw new Error("请先配置企业服务地址。");
    if (options.authenticated !== false && !this.authenticated) throw new Error("SESSION_REQUIRED: 请先登录企业空间。");
    const response = await fetch(this.config.serverUrl + route, { method: options.method ?? "GET", headers: { "content-type": "application/json", "x-tuda-client": this.clientId,
      ...(options.authenticated !== false ? { authorization: `Bearer ${this.session!.token}` } : {}) }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(30_000) });
    const value = await response.json() as T & { error?: { code?: string; message?: string } };
    if (!response.ok) {
      if (response.status === 401) { this.session = undefined; this.disconnect(); this.error = "企业登录已失效，请重新登录。"; this.changed(); }
      throw new Error(`${value.error?.code ?? "ENTERPRISE_ERROR"}: ${value.error?.message ?? "企业服务请求失败。"}`);
    }
    return value;
  }
  async beginLogin() {
    const result = await this.fetchJson<{ loginId: string; verifier: string; authorizeUrl: string; expiresAt: string }>("/api/auth/start", { method: "POST", body: {}, authenticated: false });
    const url = new URL(result.authorizeUrl);
    if (url.origin !== "https://login.dingtalk.com") throw new Error("企业服务返回了无效的钉钉登录地址。");
    this.login = result; return { authorizeUrl: result.authorizeUrl, expiresAt: result.expiresAt };
  }
  async pollLogin() {
    if (!this.login || Date.parse(this.login.expiresAt) < Date.now()) throw new Error("登录请求已过期，请重新登录。");
    const result = await this.fetchJson<{ status: "pending" | "authorized"; session?: EnterpriseSession }>("/api/auth/poll", { method: "POST", body: this.login, authenticated: false });
    if (result.session) {
      await this.flush(); this.disconnect(); this.session = result.session; this.login = undefined;
      await this.refreshIdentity();
      if (safeStorage.isEncryptionAvailable()) this.config.encryptedSession = safeStorage.encryptString(JSON.stringify({ serverUrl: this.config.serverUrl, value: this.session })).toString("base64");
      this.config.activeSpace = "enterprise"; await this.save(); this.error = undefined; this.connect(); this.changed();
      this.emit("space-changed");
    }
    return { status: result.status };
  }
  async selectSpace(space: SpaceKind) {
    if (space !== "personal" && space !== "enterprise") throw new Error("无效空间。");
    if (space === this.config.activeSpace) return this.status;
    if (space === "enterprise") { await this.refreshIdentity(); }
    await this.flush();
    if (this.pendingCount) throw new Error("企业修改尚未确认保存，请先恢复同步或导出本地恢复材料。");
    this.config.activeSpace = space; this.lastBoardId = undefined; await this.save(); this.changed(); this.emit("space-changed"); return this.status;
  }
  async logout() {
    await this.flush();
    if (this.pendingCount) throw new Error("仍有未同步的企业修改，请先完成同步。");
    if (this.session) await this.fetchJson("/api/auth/logout", { method: "POST", body: {} });
    this.disconnect(); this.session = undefined; this.config.encryptedSession = undefined; this.documents.clear(); this.versions.clear(); this.boardIds.clear(); this.clearHistory();
    await this.save(); this.changed(); this.emit("space-changed"); return this.status;
  }
  async refreshIdentity() { this.metadata = await this.fetchJson("/api/me"); return this.metadata; }
  providerAccounts(userId: string) { return this.fetchJson("/api/provider-accounts?userId=" + encodeURIComponent(userId)); }
  async assignProvider(value: unknown) { const result = await this.fetchJson("/api/provider-accounts", { method: "PATCH", body: value }); await this.refreshIdentity(); this.changed(); return result; }
  members() { return this.fetchJson("/api/members"); }
  updateMember(value: unknown) { return this.fetchJson("/api/members", { method: "PATCH", body: value }); }
  providerToken(id?: string) { return id === "enterprise-text" && this.authenticated ? this.session!.token : ""; }
  providerKeyStatus() { return { "enterprise-image": Boolean(this.metadata?.providers.image), "enterprise-text": Boolean(this.metadata?.providers.text) }; }
  ownsBoard(id: unknown) { return typeof id === "string" && this.boardIds.has(id); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  private remember(value: any) {
    if (value && typeof value.id === "string") this.boardIds.add(value.id);
    if (value?.enterpriseState && value?.enterpriseEpoch) {
      const previous = this.documents.get(value.id);
      if (previous && previous.epoch !== value.enterpriseEpoch) {
        this.saveCausality.forget(value.id);
        const history = this.histories.get(value.id); history?.undo.destroy(); history?.doc.destroy(); this.histories.delete(value.id);
        for (const key of this.versions.keys()) if (key.startsWith(value.id + ":")) this.versions.delete(key);
      }
      const revision = Number(value.revision ?? 0);
      this.documents.set(value.id, { state: value.enterpriseState, epoch: value.enterpriseEpoch, revision });
      this.versions.set(value.id + ":" + revision, value.enterpriseState);
      const history = this.history(value.id, value.enterpriseState);
      if (history) Y.applyUpdate(history.doc, Buffer.from(value.enterpriseState, "base64"), "server");
      if (this.versions.size > 200) this.versions.delete(this.versions.keys().next().value!);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  async command(channel: string, args: unknown[], requestId = randomUUID()): Promise<any> {
    if (channel === "boards:save") {
      const payload = args[0] as BoardSavePayload;
      let document = this.documents.get(payload.id);
      if (!document) { await this.command("boards:get", [payload.id]); document = this.documents.get(payload.id); }
      if (!document) throw new Error("企业画板不存在，请重新打开。");
      const observed = this.versions.get(payload.id + ":" + payload.expectedRevision) ?? (payload.expectedRevision === undefined ? document.state : undefined);
      if (!observed) throw new Error("BOARD_REVISION_CONFLICT: 画板观察版本已过期，请保留修改后重新打开。");
      const digest = createHash("sha256").update(observed).update(JSON.stringify(payload)).digest("hex").slice(0, 32);
      requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
      if (this.acceptedWrites.has(requestId)) return this.acceptedWrites.get(requestId);
      const existing = await readFile(path.join(this.namespace, "outbox", requestId + ".json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (existing) return this.sendPending(JSON.parse(existing), path.join(this.namespace, "outbox", requestId + ".json"));
      const prior = this.saveCausality.prior(payload.id, document.epoch, payload.expectedRevision).map(update => Buffer.from(update, "base64"));
      const update = encodeBoardChange(Buffer.from(observed, "base64"), payload, prior);
      args = [{ id: payload.id, viewport: payload.viewport, enterpriseEpoch: document.epoch, enterpriseUpdate: Buffer.from(update).toString("base64") }];
      return this.durableCommand(channel, args, requestId);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
    const result = await this.fetchJson<any>("/api/command", { method: "POST", body: { channel, args, requestId } });
    if (Array.isArray(result)) for (const value of result) this.remember(value); else this.remember(result);
    for (const mutation of result?.enterpriseMutations ?? []) this.applyMutation(mutation);
    if (channel === "boards:setLastOpened") { this.lastBoardId = String(args[0]); this.updatePresence({}); this.changed(); }
    if (channel === "image:generate") {
      const id = result.taskId;
      for (;;) {
        const task = await this.fetchJson<{ status: string; result?: unknown; error?: string }>("/api/jobs/" + id);
        if (task.status === "succeeded") return task.result;
        if (["failed", "unknown", "cancelled"].includes(task.status)) throw new Error(task.error || "企业任务已停止，未重新提交。");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    return result;
  }
  private async durableCommand(channel: string, args: unknown[], requestId: string) {
    if (!this.session) throw new Error("请先登录企业空间。");
    const directory = path.join(this.namespace, "outbox"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, requestId + ".json");
    const write: PendingWrite = { requestId, channel, args, serverUrl: this.config.serverUrl, organizationId: this.session.organizationId, userId: this.session.user.id };
    await writeFile(file, JSON.stringify(write), { flag: "wx", mode: 0o600 });
    this.pendingCount++; this.changed();
    return this.sendPending(write, file);
  }
  private trackPending(write: PendingWrite, revision?: number) {
    if (write.channel !== "boards:save") return;
    const value = write.args[0] as { id: string; enterpriseEpoch: string; enterpriseUpdate: string };
    if (this.saveCausality.record(value.id, value.enterpriseEpoch, value.enterpriseUpdate, revision)) {
      const history = this.history(value.id, this.documents.get(value.id)?.state);
      if (history) Y.applyUpdate(history.doc, Buffer.from(value.enterpriseUpdate, "base64"), "local-board-edit");
    }
    this.changed();
  }
  private async sendPending(write: PendingWrite, file: string) {
    this.trackPending(write);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
      const result = await this.fetchJson<any>("/api/command", { method: "POST", body: write });
      for (const mutation of result?.enterpriseMutations ?? []) this.applyMutation(mutation, false);
      this.trackPending(write, typeof result?.revision === "number" ? result.revision : undefined);
      this.acceptedWrites.set(write.requestId, result);
      if (this.acceptedWrites.size > 1000) this.acceptedWrites.delete(this.acceptedWrites.keys().next().value!);
      this.remember(result); await rm(file, { force: true }); this.pendingCount = (await readdir(path.join(this.namespace, "outbox"))).length; this.error = undefined; this.changed(); return result;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "企业修改等待同步。"; this.changed(); throw error;
    }
  }
  async replayPending() {
    if (this.replaying) return this.replaying;
    this.replaying = this.replay().finally(() => { this.replaying = undefined; });
    return this.replaying;
  }
  private async replay() {
    if (!this.session) return;
    const directory = path.join(this.namespace, "outbox");
    const listed = await readdir(directory).catch(() => []);
    const ordered = await Promise.all(listed.map(async file => ({ file, time: (await stat(path.join(directory, file)).catch(() => null))?.mtimeMs ?? 0 })));
    const files = ordered.sort((a, b) => a.time - b.time || a.file.localeCompare(b.file)).map(value => value.file); this.pendingCount = files.length; this.changed();
    for (const file of files) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(file)) continue;
      const bytes = await readFile(path.join(directory, file), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (!bytes) continue;
      const value = JSON.parse(bytes) as PendingWrite;
      if (value.serverUrl !== this.config.serverUrl || value.organizationId !== this.session.organizationId || value.userId !== this.session.user.id) throw new Error("恢复数据与当前企业账号不匹配。");
      await this.sendPending(value, path.join(directory, file));
      const payload = value.args[0] as { id?: string } | undefined;
      if (payload?.id) this.notifyBoard(payload.id);
    }
  }
  updatePresence(value: { boardId?: string; cursor?: { x: number; y: number }; selectedNodeIds?: string[] }) {
    if (this.socket?.readyState === WebSocket.OPEN && this.connected) this.socket.send(JSON.stringify({ type: "presence", ...value, boardId: value.boardId ?? this.lastBoardId }));
  }
  private connect() {
    if (!this.session || this.stopped) return;
    const endpoint = new URL(this.config.serverUrl + "/api/collaboration"); endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(endpoint); this.socket = socket;
    socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token: this.session?.token, clientId: this.clientId })));
    socket.on("message", bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === "ready") { this.connectionId = message.connectionId; this.connected = true; this.error = undefined; this.changed(); void this.replayPending().catch(error => { this.error = error.message; this.changed(); }); this.updatePresence({}); }
        if (message.type === "configuration") { this.eventQueue = this.eventQueue.then(async () => { await this.flush(); await this.refreshIdentity(); this.changed(); if (this.activeSpace === "enterprise") this.emit("space-changed"); }).catch(error => { this.error = error.message; this.changed(); }); }
        if (message.type === "presence") { this.peers = message.peers; this.changed(); }
        if (message.type === "board") {
          this.applyMutation(message, message.origin === this.clientId); this.changed();
        }
        if (message.type === "board" && message.origin !== this.clientId) {
          this.eventQueue = this.eventQueue.then(async () => {
            if (this.config.activeSpace === "enterprise") await this.flush();
            this.boardIds.add(message.boardId);
            this.notifyBoard(message.boardId);
          }).catch(error => { this.error = error instanceof Error ? error.message : "远端变更等待本地保存。"; this.changed(); });
        }
      } catch { this.error = "企业同步消息无效。"; this.changed(); }
    });
    socket.on("error", () => { this.error = "企业服务连接中断，正在重连。"; this.changed(); });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.connected = false; this.peers = []; this.changed();
      if (!this.stopped && this.session) this.reconnect = setTimeout(() => { void this.refreshIdentity().then(() => this.connect()).catch(error => { this.error = error.message; this.changed(); this.reconnect = setTimeout(() => this.connect(), 5000); }); }, 2500);
    });
  }
  private disconnect() { clearTimeout(this.reconnect); const socket = this.socket; this.socket = undefined; socket?.close(); this.connected = false; this.peers = []; }
  stop() { this.stopped = true; this.disconnect(); }
  /** Storage-only grant: held in memory and never serialized as a legacy login. */
  async useStorageSession(serverUrl:string, refresh:()=>Promise<EnterpriseSession>) {
    const session=await refresh();
    if(this.pendingCount && (this.config.serverUrl!==serverUrl || this.session?.organizationId!==session.organizationId || this.session?.user.id!==session.user.id)) throw new Error("请先完成当前 NAS 空间的待同步修改。");
    this.disconnect();this.documents.clear();this.versions.clear();this.boardIds.clear();this.clearHistory();
    this.config={version:1,serverUrl:this.validateUrl(serverUrl),activeSpace:"enterprise"};this.session=session;this.storageRefresh=refresh;this.stopped=false;
    await this.refreshIdentity();await this.replayPending();this.connect();this.changed();
  }
  async assetResponse(request: Request): Promise<Response> {
    const id = new URL(request.url).pathname.slice(1);
    if (!uuid.test(id) || !this.authenticated) return new Response("Not found", { status: 404 });
    const directory = path.join(this.namespace, "assets"); await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = path.join(directory, id + ".json");
    let file: string | undefined;
    try { const cached = JSON.parse(await readFile(metadata, "utf8")); if (/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(cached.file)) file = path.join(directory, cached.file); } catch { /* First fetch. */ }
    if (!file || !await stat(file).catch(() => null)) {
      const response = await fetch(this.config.serverUrl + "/api/assets/" + id, { headers: { authorization: `Bearer ${this.session!.token}` }, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) return new Response("Asset unavailable", { status: response.status });
      const mime = response.headers.get("content-type")?.split(";")[0] ?? "";
      const extension: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
      if (!extension[mime] || Number(response.headers.get("content-length")) > 512 * 1024 * 1024) return new Response("Invalid media", { status: 400 });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 512 * 1024 * 1024) return new Response("Media too large", { status: 413 });
      file = path.join(directory, id + "." + extension[mime]);
      // This is an immutable, authenticated cache; concurrent fetches may safely share verified bytes.
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      await writeFile(metadata, JSON.stringify({ file: path.basename(file) }), { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    }
    return createAssetResponse(request, () => file!);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  overlaySettings(settings: any) {
    const image = this.metadata?.providers.image;
    return { ...settings, defaultCliBoardId: undefined, providers: image ? [{ id: "enterprise-image", name: "企业图片服务", type: "openai-compatible", model: this.metadata!.providers.imageModel, apiMode: "images", baseUrl: "", supportsReferenceImages: true }] : [],
      activeProviderId: image ? "enterprise-image" : "", apiKeyByProviderId: {}, providerKeyStatus: this.providerKeyStatus(),
      textProviders: this.metadata?.providers.text ? [{ id: "enterprise-text", name: "企业对话服务", type: "openai-compatible", model: this.metadata.providers.textModel, baseUrl: this.config.serverUrl + "/api/text" }] : [],
      activeTextProviderId: this.metadata?.providers.text ? "enterprise-text" : "", videoProviders: [], audioProviders: [], memoryEnabled: false,
      license: settings.license };
  }
}
