import { createServer } from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { WebSocket } from "ws";
import { createEnterpriseServer } from "../src/server.js";
import { readConfig } from "../src/config.js";
import { encodeBoardChange } from "../../shared/enterprise-board.js";
import type { EnterpriseSession } from "../../shared/enterprise.js";
import { testDesktop } from "./desktop.js";
import type { BoardData } from "../../shared/types.js";

const root = process.cwd();
const adminUrl = process.env.TUDA_TEST_POSTGRES_URL ?? "postgresql://127.0.0.1:55432/postgres";
const databaseName = `tuda_enterprise_test_${process.pid}_${Date.now()}`;
const admin = new pg.Client({ connectionString: adminUrl });
const directory = await mkdtemp(path.join(os.tmpdir(), "tuda-enterprise-test-"));
const databaseUrl = new URL(adminUrl); databaseUrl.pathname = "/" + databaseName;
let created = false;
const services: Awaited<ReturnType<typeof createEnterpriseServer>>[] = [];
const sockets: WebSocket[] = [];
const fixtureImage = await readFile(path.join(root, "demo-assets/lamp-studio.jpg"));
const providerRequests: Array<{ key?: string; body: Record<string, unknown> }> = [];
const provider = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    providerRequests.push({ key: request.headers.authorization, body: request.headers["content-type"]?.includes("application/json") ? JSON.parse(Buffer.concat(chunks).toString()) : { multipart: true, preservedReference: Buffer.concat(chunks).includes(fixtureImage) } });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: fixtureImage.toString("base64") }] }));
  })().catch(() => response.writeHead(500).end());
});
await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
const providerAddress = provider.address(); assert(providerAddress && typeof providerAddress === "object");
const providerBase = `http://127.0.0.1:${providerAddress.port}/v1`;
try {
  await admin.connect(); await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
  const config = readConfig({ DATABASE_URL: databaseUrl.toString(), TUDA_MASTER_KEY: "isolated-test-master-key-".repeat(3), TUDA_DATA_DIR: directory,
    TUDA_PUBLIC_URL: "http://127.0.0.1:18473", DINGTALK_CORP_ID: "fixture-corporation", DINGTALK_CLIENT_ID: "fixture-client", DINGTALK_CLIENT_SECRET: "fixture-secret",
    DINGTALK_ADMIN_UNION_ID: "fixture-admin", TUDA_DEFAULT_ROLE: "editor" });
  config.port = 0; config.host = "127.0.0.1";
  const identity = { async exchange(code: string) { return { corpId: code === "outside" ? "other-corporation" : config.corpId, unionId: "fixture-" + code, userId: "fixture-" + code, name: code }; } };
  let service = await createEnterpriseServer(config, identity); services.push(service);
  const address = await service.listen(); assert(address && typeof address === "object");
  let base = `http://127.0.0.1:${address.port}`; config.publicUrl = base;
  async function request(route: string, token?: string, body?: unknown, expected = 200, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(); assert.equal(response.status, expected, `${route}: ${text.slice(0, 300)}`);
    return response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  }
  async function login(code: string) {
    const start = await request("/api/auth/start", undefined, {});
    const state = new URL(start.authorizeUrl).searchParams.get("state")!;
    await request(`/auth/dingtalk/callback?state=${encodeURIComponent(state)}&authCode=${code}`, undefined, undefined, code === "outside" ? 403 : 200);
    const result = await request("/api/auth/poll", undefined, { loginId: start.loginId, verifier: start.verifier }, code === "outside" ? 403 : 200);
    return result.session as EnterpriseSession;
  }
  const administrator = await login("admin"), editor = await login("editor"), viewer = await login("viewer");
  assert.equal(administrator.user.role, "admin"); assert.equal(editor.user.role, "editor");
  await login("outside");
  await request("/api/members", administrator.token, { id: viewer.user.id, active: true, role: "viewer" }, 200, "PATCH");
  const command = (token: string, channel: string, args: unknown[], requestId = randomUUID(), expected = 200) => request("/api/command", token, { channel, args, requestId }, expected);
  await request("/api/provider-accounts", editor.token, { userId: editor.user.id, kind: "image", enabled: false }, 403, "PATCH");
  for (const [member, key] of [[editor, "fixture-editor-key"], [administrator, "fixture-admin-key"]] as const) {
    const assigned = await request("/api/provider-accounts", administrator.token, { userId: member.user.id, kind: "image", enabled: true, baseUrl: providerBase, model: "fixture-image", apiKey: key }, 200, "PATCH");
    assert(!JSON.stringify(assigned).includes(key));
    const publicAccount = await request("/api/provider-accounts?userId=" + member.user.id, administrator.token);
    assert.equal(publicAccount.image.hasKey, true); assert(!JSON.stringify(publicAccount).includes(key));
    const own = await request("/api/me", member.token); assert.equal(own.providers.imageModel, "fixture-image"); assert(!JSON.stringify(own).includes(key));
  }
  const encrypted = await service.db.pool.query("SELECT secret FROM tuda_provider_accounts");
  assert(encrypted.rows.every(row => !row.secret.includes("fixture-editor-key") && !row.secret.includes("fixture-admin-key")));
  const board = await command(editor.token, "boards:create", ["多人测试"]);
  const envelope = await command(editor.token, "boards:get", [board.id]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  const save = (token: string, base: any, value: BoardData, requestId = randomUUID(), expected = 200) => command(token, "boards:save", [{ id: base.id, enterpriseEpoch: base.enterpriseEpoch,
    enterpriseUpdate: Buffer.from(encodeBoardChange(Buffer.from(base.enterpriseState, "base64"), value)).toString("base64") }], requestId, expected);
  const initial = { ...board, nodes: [{ id: "a", type: "text", text: "商品", x: 0, y: 0 }, { id: "b", type: "text", text: "参考", x: 400, y: 0 }] } as BoardData;
  await save(editor.token, envelope, initial);
  const baseVersion = await command(editor.token, "boards:get", [board.id]);
  const peerA = structuredClone(baseVersion), peerB = structuredClone(baseVersion);
  peerA.nodes[0].x = 110; peerB.nodes[1].y = 220;
  const idempotency = randomUUID();
  const first = await save(editor.token, baseVersion, peerA, idempotency);
  const originalDelta = encodeBoardChange(Buffer.from(baseVersion.enterpriseState, "base64"), peerA);
  // Retrying uses the original bytes, rather than generating a new CRDT author ID.
  const duplicateArgs = [{ id: board.id, enterpriseEpoch: baseVersion.enterpriseEpoch,
    enterpriseUpdate: first.enterpriseMutations?.[0]?.update }];
  assert.equal(typeof originalDelta.length, "number");
  await save(administrator.token, baseVersion, peerB);
  let latest = await command(editor.token, "boards:get", [board.id]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  assert.equal(latest.nodes.find((node: any) => node.id === "a").x, 110);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  assert.equal(latest.nodes.find((node: any) => node.id === "b").y, 220);
  await command(viewer.token, "boards:create", ["should fail"], randomUUID(), 403);
  await save(viewer.token, latest, { ...latest, name: "should fail" }, randomUUID(), 403);
  await command(editor.token, "boards:list", []);
  const image = await readFile(path.join(root, "demo-assets/lamp-studio.jpg"));
  const asset = await command(editor.token, "asset:importUpload", ["data:image/jpeg;base64," + image.toString("base64")]);
  const retrieved = await request("/api/assets/" + asset.id, viewer.token);
  assert(retrieved.length > 0);
  await command(editor.token, "boards:appendNodes", [board.id, [{ id: "image", imagePath: asset.path, source: "upload", jobId: "fixture", width: asset.width, height: asset.height }]]);
  await command(editor.token, "boards:images:move", [board.id, "image", 800, 80]);
  await command(editor.token, "boards:images:resize", [board.id, "image", 320]);
  await command(editor.token, "boards:images:duplicate", [board.id, ["image"], 340]);
  const afterDuplicates = await command(editor.token, "boards:get", [board.id]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  await command(editor.token, "boards:images:arrange", [board.id, afterDuplicates.nodes.filter((node: any) => node.imagePath).map((node: any) => node.id), "vertical", 48]);
  const socket = new WebSocket(base.replace("http:", "ws:") + "/api/collaboration"); sockets.push(socket);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Heterogeneous legacy IPC wire values; domain operations validate each command.
  const messages: any[] = [];
  socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
  await new Promise<void>(resolve => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "authenticate", token: viewer.token, clientId: randomUUID() }));
  for (let i = 0; i < 50 && !messages.some(message => message.type === "ready"); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert(messages.some(message => message.type === "ready"));
  await command(editor.token, "boards:rename", [board.id, "实时通知"]);
  for (let i = 0; i < 50 && !messages.some(message => message.type === "board"); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert(messages.some(message => message.type === "board"));
  await request("/api/members", administrator.token, { id: viewer.user.id, active: false, role: "viewer" }, 200, "PATCH");
  await request("/api/me", viewer.token, undefined, 401);
  const generation = { workflowMode: "generate", prompt: "Offline fixture", model: "fixture-image", size: "auto", n: 1, quality: "high", background: "transparent", outputNodeIds: ["fixture-output"], referenceImages: [], boardId: board.id, clientTaskId: randomUUID() };
  const queued = await command(editor.token, "image:generate", [generation]);
  assert.equal((await command(editor.token, "image:generate", [generation])).taskId, queued.taskId);
  await service.jobs.workOne();
  const generated = await request("/api/jobs/" + queued.taskId, editor.token); assert.equal(generated.status, "succeeded", generated.error);
  assert.equal(providerRequests.length, 1); assert.equal(providerRequests[0].key, "Bearer fixture-editor-key");
  assert.equal(providerRequests[0].body.quality, "high"); assert.equal(providerRequests[0].body.background, "transparent");
  await command(administrator.token, "image:generate", [{ ...generation, outputNodeIds: ["fixture-admin-output"], clientTaskId: randomUUID() }]); await service.jobs.workOne();
  assert.equal(providerRequests[1].key, "Bearer fixture-admin-key");
  assert.equal((await request("/api/jobs/" + queued.taskId, editor.token)).result.images.length, 1);
  await command(editor.token, "image:generate", [{ ...generation, clientTaskId: randomUUID(), model: "wrong-model" }], randomUUID(), 400);
  await command(editor.token, "image:generate", [{ ...generation, n: 2, outputNodeIds: ["conflict-a", "conflict-b"] }], randomUUID(), 409);
  const beforeEdit = await command(editor.token, "boards:get", [board.id]);
  assert.equal(beforeEdit.nodes.filter((node: {id: string}) => node.id === "fixture-output").length, 1);
  const editTask = await command(editor.token, "image:generate", [{ ...generation, workflowMode: "edit", outputNodeIds: undefined, resultTargetNodeId: "image", clientTaskId: randomUUID(), referenceImages: [{id:"source",name:"source.jpg",mimeType:"image/jpeg",dataBase64:fixtureImage.toString("base64")}] }]);
  await service.jobs.workOne(); const editResult = await request("/api/jobs/" + editTask.taskId, editor.token); assert.equal(editResult.status, "succeeded", editResult.error);
  assert.equal(providerRequests[2].body.preservedReference, true);
  const afterEdit = await command(editor.token, "boards:get", [board.id]); const editedNode = afterEdit.nodes.find((node: {id: string}) => node.id === "image");
  assert.equal(editedNode.versions.length, 2);
  await command(editor.token, "boards:appendVersions", [board.id, "image", [editedNode.versions.at(-1)]]);
  assert.equal((await command(editor.token, "boards:get", [board.id])).nodes.find((node: {id: string}) => node.id === "image").versions.length, 2);
  const detail = await command(editor.token, "assets:detail", [board.id, "image"]); assert.equal(detail.versions.length, 2);
  const invalid = await command(editor.token, "boards:get", [board.id]);
  await save(editor.token, invalid, { ...invalid, nodes: [...invalid.nodes, { id: "bad", imagePath: "/private/other-user/photo.png", jobId: "bad", source: "upload", x: 0, y: 0 }] }, randomUUID(), 400);
  const candidate = await service.db.pool.query("SELECT result FROM tuda_receipts WHERE org_id=$1 AND user_id=$2 AND request_id=$3", [config.organizationId, editor.user.id, idempotency]);
  assert.equal(candidate.rowCount, 1);
  // The original committed result is retained; a reused ID with different bytes is rejected.
  assert.deepEqual(await command(editor.token, "boards:save", duplicateArgs, idempotency), first);
  await command(editor.token, "boards:save", [{ ...duplicateArgs[0], enterpriseUpdate: Buffer.from(encodeBoardChange(Buffer.from(baseVersion.enterpriseState, "base64"), peerB)).toString("base64") }], idempotency, 409);
  latest = await command(editor.token, "boards:get", [board.id]);
  const revision = latest.revision;
  socket.terminate(); await service.close(); services.pop();
  service = await createEnterpriseServer(config, identity); services.push(service);
  const reopened = await service.listen(); assert(reopened && typeof reopened === "object"); base = `http://127.0.0.1:${reopened.port}`;
  latest = await command(editor.token, "boards:get", [board.id]);
  assert.equal(latest.name, "实时通知"); assert.equal(latest.revision, revision);
  await command(editor.token, "boards:delete", [board.id]);
  assert.equal(await command(editor.token, "boards:get", [board.id]), null);
  await command(editor.token, "boards:trash:restore", [board.id]);
  await save(editor.token, latest, latest, randomUUID(), 409);
  if (process.env.TUDA_TEST_DESKTOP === "1") {
    const shared = await command(editor.token, "boards:create", ["双客户端桌面验证"]);
    await command(editor.token, "boards:appendNodes", [shared.id, ["desktop-a", "desktop-b"].map((id, index) => ({ id, imagePath: asset.path, source: "upload", jobId: "desktop", width: 320, height: 220, x: index * 420, y: 0 }))]);
    const port = new URL(base).port; config.port = Number(port); config.publicUrl = base;
    await testDesktop({ base, sessions: [editor, administrator], boardId: shared.id,
      board: () => command(editor.token, "boards:get", [shared.id]),
      restart: async offline => { await service.close(); services.pop(); try { await offline?.(); } finally { service = await createEnterpriseServer(config, identity); services.push(service); await service.listen(); } } });
  }
  await request("/api/auth/logout", editor.token, {});
  await request("/api/me", editor.token, undefined, 401);
  console.log(JSON.stringify({ ok: true, realPostgres: true, corporateIdentityGate: true, isolatedSessions: true, collaborativeMerge: true,
    readOnlyEnforced: true, revokedConnection: true, mediaScope: true, cliLayoutOperations: true, persistenceAfterRestart: true, restoreEpochProtected: true, durableReceipts: true, perEmployeeEncryptedKeys: true, referenceBytesPreserved: true, stableOutputIdentities: true, versionEditIdempotent: true, nonPaidGenerationFixture: true, generationIdempotency: true }, null, 2));
} finally {
  provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  for (const socket of sockets) socket.terminate();
  for (const service of services.reverse()) await service.close().catch(() => undefined);
  if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end().catch(() => undefined); await rm(directory, { recursive: true, force: true });
}
