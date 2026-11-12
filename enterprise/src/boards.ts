import { randomUUID } from "node:crypto";
import path from "node:path";
import * as Y from "yjs";
import type { PoolClient } from "pg";
import { BoardStore, type BoardPersistenceAdapter } from "../../electron/storage/board-store.js";
import { boardStoragePaths, normalizeStoredBoard, toSummary } from "../../electron/domain/board-model.js";
import { createBoardDocument, patchBoardDocument, readBoardDocument } from "../../shared/enterprise-board.js";
import { ENTERPRISE_ASSET_PREFIX } from "../../shared/enterprise.js";
import type { BoardData, BoardDetail } from "../../shared/types.js";
import { fail } from "./config.js";
import { Database } from "./database.js";
import { hash, type Principal } from "./auth.js";

export interface BoardEvent { type: "board"; boardId: string; revision?: number; state?: string; epoch?: string; update?: string; removed?: boolean; origin?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const assetId = (value: string) => {
  const id = value.startsWith(ENTERPRISE_ASSET_PREFIX) ? value.slice(ENTERPRISE_ASSET_PREFIX.length) : "";
  if (!uuid.test(id)) fail(400, "INVALID_ASSET", "企业素材必须使用有效的素材 ID。");
  return id;
};
export const assetUrl = (value: string) => `tuda-asset://enterprise/${assetId(value)}`;
const absent = () => Object.assign(new Error("Not found"), { code: "ENOENT" });

export class BoardTransaction implements BoardPersistenceAdapter {
  readonly events: BoardEvent[] = [];
  constructor(readonly client: PoolClient, readonly orgId: string) {}
  private key(file: string) {
    const key = path.posix.relative("/enterprise", file);
    if (key.startsWith("..") || path.posix.isAbsolute(key)) fail(400, "INVALID_DOCUMENT", "无效文档标识。");
    return key;
  }
  private boardId(key: string): string | null {
    const match = /^boards\/([a-zA-Z0-9-]+)\.json$/.exec(key);
    return match && match[1] !== "state" ? match[1] : null;
  }
  async envelope(id: string) {
    const result = await this.client.query("SELECT * FROM tuda_boards WHERE org_id=$1 AND id=$2", [this.orgId, id]);
    const row = result.rows[0];
    if (!row) return null;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, row.state);
      return { board: readBoardDocument(doc, Number(row.revision), new Date(row.updated_at).toISOString()),
        state: Buffer.from(row.state).toString("base64"), epoch: row.epoch };
    } finally { doc.destroy(); }
  }
  async validate(board: BoardData) {
    if (!normalizeStoredBoard(board) || board.nodes.length > 10_000 || JSON.stringify(board).length > 16_000_000) fail(400, "INVALID_BOARD", "画板数据无效或超出限制。");
    const paths = [...new Set(boardStoragePaths(board))];
    const ids = paths.map(assetId);
    if (ids.length) {
      const result = await this.client.query("SELECT id FROM tuda_assets WHERE org_id=$1 AND id=ANY($2::uuid[])", [this.orgId, ids]);
      if (result.rowCount !== ids.length) fail(403, "ASSET_SCOPE_DENIED", "画板引用了不存在或无权访问的素材。");
    }
  }
  async persist(id: string, doc: Y.Doc, previous?: { epoch: string; state: Buffer; revision: string | number }) {
    const revision = Number(previous?.revision ?? -1) + 1;
    const updatedAt = new Date().toISOString();
    const board = readBoardDocument(doc, revision, updatedAt);
    if (board.id !== id) fail(400, "IDENTITY_CHANGED", "画板身份不能由客户端更改。");
    await this.validate(board);
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));
    const epoch = previous?.epoch ?? randomUUID();
    const delta = previous ? Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(previous.state)) : state;
    await this.client.query(`INSERT INTO tuda_boards(org_id,id,epoch,state,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(org_id,id) DO UPDATE SET state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at`,
      [this.orgId, id, epoch, state, revision, updatedAt]);
    await this.client.query("INSERT INTO tuda_board_updates(org_id,board_id,epoch,revision,update) VALUES($1,$2,$3,$4,$5)", [this.orgId, id, epoch, revision, Buffer.from(delta)]);
    // The row is a compact snapshot. Keep a bounded recent update journal per epoch.
    if (revision > 1024 && revision % 128 === 0) await this.client.query("DELETE FROM tuda_board_updates WHERE org_id=$1 AND board_id=$2 AND epoch=$3 AND revision<$4", [this.orgId, id, epoch, revision - 1024]);
    this.events.push({ type: "board", boardId: id, revision, state: state.toString("base64"), update: Buffer.from(delta).toString("base64"), epoch });
    return { board, state: state.toString("base64"), epoch };
  }
  async apply(id: string, epoch: string, update: string) {
    if (typeof update !== "string" || update.length > 24_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(update)) fail(400, "INVALID_UPDATE", "协同更新无效。");
    const result = await this.client.query("SELECT * FROM tuda_boards WHERE org_id=$1 AND id=$2", [this.orgId, id]);
    const row = result.rows[0];
    if (!row) fail(404, "BOARD_NOT_FOUND", "画板不存在或已删除。");
    if (row.epoch !== epoch) fail(409, "BOARD_EPOCH_CHANGED", "画板已恢复或重建，请保留本地修改并重新打开画板。");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, row.state);
      const identity = JSON.stringify(doc.getMap("identity").toJSON());
      Y.applyUpdate(doc, Buffer.from(update, "base64"));
      if (JSON.stringify(doc.getMap("identity").toJSON()) !== identity || [...doc.share.keys()].some(key => !["identity", "metadata", "nodes", "connections", "groups"].includes(key))) fail(400, "INVALID_DOCUMENT", "协同更新修改了受保护的结构。");
      if (Buffer.from(Y.encodeStateAsUpdate(doc)).equals(row.state)) return this.envelope(id);
      return await this.persist(id, doc, row);
    } finally { doc.destroy(); }
  }
  async read(file: string): Promise<string> {
    const key = this.key(file), id = this.boardId(key);
    if (id) { const value = await this.envelope(id); if (!value) throw absent(); return JSON.stringify(value.board); }
    const result = await this.client.query("SELECT value FROM tuda_documents WHERE org_id=$1 AND key=$2", [this.orgId, key]);
    if (!result.rowCount) throw absent();
    return JSON.stringify(result.rows[0].value);
  }
  async write(file: string, value: unknown) {
    const key = this.key(file), id = this.boardId(key);
    if (id) {
      const board = value as BoardData;
      const result = await this.client.query("SELECT * FROM tuda_boards WHERE org_id=$1 AND id=$2", [this.orgId, id]);
      const row = result.rows[0], doc = row ? new Y.Doc() : createBoardDocument(board);
      try { if (row) { Y.applyUpdate(doc, row.state); patchBoardDocument(doc, board); } await this.persist(id, doc, row); }
      finally { doc.destroy(); }
      return;
    }
    await this.client.query("INSERT INTO tuda_documents(org_id,key,value) VALUES($1,$2,$3) ON CONFLICT(org_id,key) DO UPDATE SET value=excluded.value", [this.orgId, key, JSON.stringify(value)]);
  }
  async list(directory: string): Promise<string[]> {
    const key = this.key(directory) + "/";
    const docs = await this.client.query("SELECT key FROM tuda_documents WHERE org_id=$1 AND starts_with(key,$2)", [this.orgId, key]);
    const files = docs.rows.map(row => String(row.key).slice(key.length)).filter(file => !file.includes("/"));
    if (key === "boards/") {
      const boards = await this.client.query("SELECT id FROM tuda_boards WHERE org_id=$1", [this.orgId]);
      files.push(...boards.rows.map(row => row.id + ".json"));
    }
    return files;
  }
  async remove(file: string) {
    const key = this.key(file), id = this.boardId(key);
    if (id) {
      await this.client.query("DELETE FROM tuda_boards WHERE org_id=$1 AND id=$2", [this.orgId, id]);
      this.events.push({ type: "board", boardId: id, removed: true });
    } else await this.client.query("DELETE FROM tuda_documents WHERE org_id=$1 AND key=$2", [this.orgId, key]);
  }
}

const reads = new Set(["boards:list", "boards:get", "boards:trash:list", "boards:images:trash:list", "boards:getState"]);
export const boardChannels = new Set([...reads, "boards:create", "boards:createComicDramaProject", "boards:save", "boards:rename", "boards:duplicate", "boards:delete",
  "boards:trash:restore", "boards:trash:delete", "boards:trash:empty", "boards:images:move", "boards:images:resize", "boards:images:arrange", "boards:images:duplicate", "boards:images:setVersion",
  "boards:images:trash:move", "boards:images:trash:restore", "boards:images:trash:delete", "boards:images:trash:empty", "boards:appendNodes", "boards:appendVersions", "boards:canvas:write", "boards:finishGeneration", "boards:setLastOpened"]);

export class BoardsService {
  constructor(readonly db: Database, readonly broadcast: (orgId: string, events: BoardEvent[]) => void) {}
  async command(user: Principal, channel: string, args: unknown[], requestId: string, origin: string): Promise<unknown> {
    if (!boardChannels.has(channel)) fail(400, "UNSUPPORTED_COMMAND", "不支持此企业画板操作。");
    if (!reads.has(channel) && channel !== "boards:setLastOpened" && user.role === "viewer") fail(403, "READ_ONLY", "你在企业空间中只有查看权限。");
    if (!uuid.test(requestId)) fail(400, "REQUEST_ID_REQUIRED", "缺少有效的请求标识。");
    const events: BoardEvent[] = [];
    const result = await this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.orgId]);
      const fingerprint = hash(JSON.stringify({ channel, args }));
      if (!reads.has(channel)) {
        const receipt = await client.query("SELECT * FROM tuda_receipts WHERE org_id=$1 AND user_id=$2 AND request_id=$3", [user.orgId, user.id, requestId]);
        if (receipt.rowCount) { if (receipt.rows[0].request_hash !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "同一请求标识对应了不同内容。"); return receipt.rows[0].result; }
      }
      const transaction = new BoardTransaction(client, user.orgId);
      const store = new BoardStore("/enterprise", undefined, transaction);
      let value = await this.execute(store, transaction, channel, args, user);
      if (!reads.has(channel) && value && typeof value === "object" && !Array.isArray(value)) value = { ...value, enterpriseMutations: transaction.events };
      if (!reads.has(channel)) {
        await client.query("INSERT INTO tuda_receipts(org_id,user_id,request_id,request_hash,result) VALUES($1,$2,$3,$4,$5)", [user.orgId, user.id, requestId, fingerprint, JSON.stringify(value ?? null)]);
        await client.query("INSERT INTO tuda_audit(org_id,user_id,action,target) VALUES($1,$2,$3,$4)", [user.orgId, user.id, channel, typeof args[0] === "string" ? args[0].slice(0, 200) : null]);
      }
      events.push(...transaction.events.map(event => ({ ...event, origin })));
      return value;
    });
    // Announce only after PostgreSQL commits. A lost response is recoverable with the same request ID.
    if (events.length) this.broadcast(user.orgId, events);
    return result;
  }
  private async execute(store: BoardStore, tx: BoardTransaction, channel: string, args: unknown[], user: Principal): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
    const [a, b, c, d] = args as any[];
    switch (channel) {
      case "boards:list": return store.listSummaries();
      case "boards:get": { const value = await tx.envelope(String(a)); let viewport; try { viewport = JSON.parse(await tx.read(`/enterprise/viewports/${user.id}/${String(a)}.json`)); } catch { /* Initial view. */ } return value ? { ...this.detail(value.board), viewport, enterpriseState: value.state, enterpriseEpoch: value.epoch } : null; }
      case "boards:create": return store.createBoard(typeof a === "string" ? a : undefined);
      case "boards:createComicDramaProject": return store.createComicDramaProject(a);
      case "boards:save": {
        if (!a || typeof a.id !== "string" || !a.enterpriseEpoch || !a.enterpriseUpdate) fail(400, "COLLABORATION_REQUIRED", "企业画板保存需要协同版本，请重新打开画板。");
        const result = await tx.apply(a.id, a.enterpriseEpoch, a.enterpriseUpdate);
        if (a.viewport && [a.viewport.x, a.viewport.y, a.viewport.zoom].every(Number.isFinite) && a.viewport.zoom > 0) await tx.write(`/enterprise/viewports/${user.id}/${a.id}.json`, a.viewport);
        return result ? { ...toSummary(result.board), enterpriseState: result.state, enterpriseEpoch: result.epoch, revision: result.board.revision } : null;
      }
      case "boards:rename": { const value = await store.renameBoard(a, b); return value ? toSummary(value) : null; }
      case "boards:duplicate": { const value = await store.duplicateBoard(a); return value ? toSummary(value) : null; }
      case "boards:delete": return { ok: await store.trashBoard(a) };
      case "boards:trash:list": return store.listTrashedBoards(30);
      case "boards:trash:restore": { const value = await store.restoreBoard(a); return value ? toSummary(value) : null; }
      case "boards:trash:delete": return { ok: await store.deleteTrashedBoard(a) };
      case "boards:trash:empty": return { ok: true, count: (await store.emptyTrash()).length };
      case "boards:images:move": { const result = await store.moveImageNode(a, b, { x: Number(c), y: Number(d) }); return { boardId: a, nodeId: b, previous: result.previous, position: { x: result.node.x, y: result.node.y } }; }
      case "boards:images:resize": return { boardId: a, nodeId: b, ...await store.resizeImageNode(a, b, Number(c)) };
      case "boards:images:arrange": return { boardId: a, mode: c, gap: d ?? 40, positions: await store.arrangeImageNodes(a, b, c, d ?? 40) };
      case "boards:images:duplicate": return { boardId: a, copies: (await store.duplicateImageNodes(a, b, c ?? 24)).map(copy => ({ sourceNodeId: copy.sourceNodeId, nodeId: copy.node.id, x: copy.node.x, y: copy.node.y })) };
      case "boards:images:setVersion": { const result = await store.setImageNodeVersion(a, b, c); return { boardId: a, nodeId: b, previousVersionIndex: result.previousVersionIndex, versionIndex: result.versionIndex, versionCount: result.versionCount, imagePath: result.node.imagePath }; }
      case "boards:canvas:write": return store.writeCanvasNode(a);
      case "boards:finishGeneration": return {ok:await store.finishGenerationNode(a,b,c)};
      case "boards:appendNodes": { const current = await store.getBoard(a); await store.appendNodes(a, b.filter((node: BoardData["nodes"][number]) => !current?.nodes.some(existing => existing.id === node.id || ("imagePath" in node && "imagePath" in existing && node.source === "generated" && existing.imagePath === node.imagePath && existing.jobId === node.jobId)))); return { ok: true }; }
      case "boards:appendVersions": { const current = await store.getBoard(a), node = current?.nodes.find(node => node.id === b); const versions = node && "imagePath" in node ? node.versions ?? [{ imagePath: node.imagePath, jobId: node.jobId }] : []; await store.appendVersions(a, b, c.filter((version: { imagePath: string; jobId: string }) => !versions.some(existing => existing.imagePath === version.imagePath && existing.jobId === version.jobId))); return { ok: true }; }
      case "boards:images:trash:move": {
        const nodes = await store.removeNodes(a, b); const ids: string[] = [];
        const board = await store.getBoard(a);
        for (const node of nodes) { const id = randomUUID(); ids.push(id); await tx.write(`/enterprise/image-trash/${id}.json`, { id, boardId: a, boardName: board?.name ?? "画板", node, deletedAt: new Date().toISOString(), previewUrl: assetUrl(node.imagePath) }); }
        return { count: nodes.length, items: nodes.map((node, index) => ({ trashId: ids[index], nodeId: node.id })) };
      }
      case "boards:images:trash:list": { const files = await tx.list("/enterprise/image-trash"); return Promise.all(files.map(async file => JSON.parse(await tx.read("/enterprise/image-trash/" + file)))); }
      case "boards:images:trash:restore": { const record = JSON.parse(await tx.read(`/enterprise/image-trash/${String(a)}.json`)); await store.restoreNodes(record.boardId, [record.node]); await tx.remove(`/enterprise/image-trash/${String(a)}.json`); return { item: record, imageUrls: Object.fromEntries([record.node.imagePath, ...(record.node.versions ?? []).map((version: {imagePath: string}) => version.imagePath)].map(value => [value, assetUrl(value)])) }; }
      case "boards:images:trash:delete": await tx.remove(`/enterprise/image-trash/${String(a)}.json`); return { ok: true };
      case "boards:images:trash:empty": { const files = await tx.list("/enterprise/image-trash"); for (const file of files) await tx.remove("/enterprise/image-trash/" + file); return { ok: true, count: files.length }; }
      case "boards:getState": { try { return JSON.parse(await tx.read(`/enterprise/user-state/${user.id}.json`)); } catch { return {}; } }
      case "boards:setLastOpened": await tx.write(`/enterprise/user-state/${user.id}.json`, { lastOpenedBoardId: a }); return null;
      default: return null;
    }
  }
  detail(board: BoardData): BoardDetail {
    const media = Object.fromEntries(boardStoragePaths(board).map(value => [value, assetUrl(value)]));
    return { ...board, images: media, media };
  }
}
