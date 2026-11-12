import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { readConfig } from "../src/config.js";
import { createEnterpriseServer } from "../src/server.js";

const adminUrl =
  process.env.TUDA_TEST_POSTGRES_URL ?? "postgresql://127.0.0.1:55432/postgres";
const name = "tuda_storage_test_" + Date.now(),
  admin = new pg.Client({ connectionString: adminUrl });
const folder = await mkdtemp(path.join(os.tmpdir(), "tuda-storage-contract-"));
let service: Awaited<ReturnType<typeof createEnterpriseServer>> | undefined,
  created = false;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const database = new URL(adminUrl);
  database.pathname = "/" + name;
  const config = readConfig({
    DATABASE_URL: database.href,
    TUDA_MASTER_KEY: "fixture".repeat(12),
    TUDA_DATA_DIR: folder,
    TUDA_PUBLIC_URL: "http://127.0.0.1:18473",
    DINGTALK_CORP_ID: "fixture-corp",
    TUDA_COMPANY_ORIGIN: "https://company.example",
    TUDA_COMPANY_NAS_SERVICE_TOKEN: "fixture-service-token",
    TUDA_COMPANY_ORGANIZATION_ID: "cloud-org",
  });
  config.port = 0;
  config.host = "127.0.0.1";
  const checked: string[] = [];
  service = await createEnterpriseServer(config, undefined, (async (
    _url,
    init,
  ) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-service-token",
    );
    const { token } = JSON.parse(String(init?.body));
    checked.push(token);
    if (!["storage-editor", "storage-viewer"].includes(token))
      return Response.json({ ok: true, data: { contract: 1, active: false } });
    return Response.json({
      ok: true,
      data: {
        contract: 1,
        active: true,
        appId: "tuda",
        audience: "tuda-nas",
        organizationId: "cloud-org",
        memberId: token,
        sessionId: "session-" + token,
        expiresAt: new Date(Date.now() + 240_000).toISOString(),
        scopes:
          token === "storage-editor"
            ? ["boards:read", "boards:write", "assets:read", "assets:write"]
            : ["boards:read", "assets:read"],
      },
    });
  }) as typeof fetch);
  const address = await service.listen();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (
    token: string,
    channel: string,
    args: unknown[],
    status = 200,
  ) => {
    const response = await fetch(base + "/api/command", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel, args, requestId: randomUUID() }),
    });
    assert.equal(response.status, status);
    return response.json();
  };
  const board = await call("storage-editor", "boards:create", [
    "云端身份的 NAS 画板",
  ]);
  const bytes = await readFile(
    path.join(process.cwd(), "demo-assets/lamp-studio.jpg"),
  );
  const asset = await call("storage-editor", "asset:importUpload", [
    "data:image/jpeg;base64," + bytes.toString("base64"),
  ]);
  await call("storage-editor", "boards:appendNodes", [
    board.id,
    [
      {
        id: "image",
        imagePath: asset.path,
        jobId: "fixture",
        source: "upload",
      },
    ],
  ]);
  const read = await call("storage-viewer", "boards:get", [board.id]);
  assert.equal(read.nodes[0].imagePath, asset.path);
  const initialLibrary = await call("storage-viewer", "boards:library:get", []);
  assert.equal(initialLibrary.revision, 0);
  const folderResponse = await call("storage-editor", "boards:library:update", [{ expectedRevision: 0, action: { type: "createFolder", name: "团队项目", id: "team-project", parentId: null } }]);
  assert.equal(folderResponse.folders[0].name, "团队项目");
  await call("storage-viewer", "boards:library:update", [{ expectedRevision: 1, action: { type: "renameFolder", id: "team-project", name: "拒绝" } }], 403);
  await call("storage-editor", "boards:library:update", [{ expectedRevision: 0, action: { type: "renameFolder", id: "team-project", name: "旧版本" } }], 409);
  await call("storage-editor", "boards:library:update", [{ expectedRevision: 1, action: { type: "move", items: [{ kind: "board", id: board.id }], parentId: "team-project" } }]);
  const sharedLibrary = await call("storage-viewer", "boards:library:get", []);
  assert.equal(sharedLibrary.boardFolders[board.id], "team-project");
  assert.equal((await call("storage-viewer", "boards:get", [board.id])).nodes[0].imagePath, asset.path);
  await call("storage-editor", "boards:library:update", [{ expectedRevision: 2, action: { type: "deleteEmptyFolder", id: "team-project" } }], 400);
  await call("storage-viewer", "boards:create", ["blocked"], 403);
  await call("storage-viewer", "boards:setLastOpened", [board.id]);
  await call("storage-editor", "image:generate", [{}], 403);
  await call("device-model-token", "boards:list", [], 401);
  const assets = await fetch(
    base + "/api/assets/" + asset.path.split(":").at(-1),
    { headers: { authorization: "Bearer storage-viewer" } },
  );
  assert.equal(assets.status, 200);
  assert(Buffer.from(await assets.arrayBuffer()).equals(bytes));
  assert(checked.includes("device-model-token"));
  console.log(
    JSON.stringify({
      ok: true,
      realPostgres: true,
      storageIntrospection: true,
      modelTokenRejected: true,
      modelExecutionRejected: true,
      readWriteScopes: true,
      sharedFolders: true,
      staleFolderUpdatesRejected: true,
      existingNasOrganization: config.organizationId,
      assetBytesPreserved: true,
    }),
  );
} finally {
  await service?.close();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
  await rm(folder, { recursive: true, force: true });
}
