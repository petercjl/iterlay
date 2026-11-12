import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _electron as electron } from "playwright";
import { Client } from "../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const appPath = process.env.TUDA_PLUGIN_TEST_APP;
if (!appPath || !path.isAbsolute(appPath)) throw new Error("Set TUDA_PLUGIN_TEST_APP to the exact packaged development .app");
const scenario = process.env.TUDA_PLUGIN_TEST_SCENARIO || "active";
const userData = await mkdtemp(path.join(os.tmpdir(), "tuda-packaged-plugin-"));
const parent = path.resolve("output/playwright");
await mkdir(parent, { recursive: true });
const output = await mkdtemp(path.join(parent, "board-plugin-"));
const env = { ...process.env, TUDA_USER_DATA_PATH: userData, TUDA_EMBEDDED_HOST: "codex-own", TUDA_PLUGIN_SPACE: "personal", TUDA_SPACE: "personal", TUDA_PLAYWRIGHT: "1", TUDA_NO_LAUNCH: "1", TUDA_COMPANY_URL: "" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TUDA_AUTH_HANDOFF_FILE;
let app, client;
async function start() {
  app = await electron.launch({ executablePath: path.join(appPath, "Contents/MacOS/Tuda"), args: [], env, timeout: 60000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.imageWorkbench && document.documentElement.dataset.boardSaveState, { timeout: 60000 });
  client = new Client({ name: "packaged-native-consumer", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("cli/dist/board-plugin.js")], env, stderr: "pipe" }));
  return page;
}
async function stop() {
  if (!app) return;
  const running = app;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host quit did not finish within 20 seconds")), 20000);
    running.process().once("exit", () => { clearTimeout(timer); resolve(); });
  });
  const info = JSON.parse(await readFile(path.join(userData, "local-api.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${info.port}/board-plugin/host/quit`, { method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30000) });
  assert(response.ok, "embedded host must be able to quit safely");
  await exited;
  await running.close().catch(() => undefined);
  app = null;
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
try {
  let page = await start();
  assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), userData);
  await page.locator("[data-tuda-board-only=true]").waitFor();
  for (const name of ["生成图片", "生成视频", "添加 Canvas", "AI 对话", "先配置图片服务"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
  const board = await call("create_board", { name: "原生插件打包验收" });
  if (scenario === "active") await call("open_board", { boardId: board.id });
  if (scenario === "inactive") {
    const holding = await call("create_board", { name: "当前打开的其他画板" });
    await call("open_board", { boardId: holding.id });
  }
  const batch = await call("import_board_images", { boardId: board.id, operationId: "fixture-import", files: [path.resolve("demo-assets/lamp-studio.jpg"), path.resolve("demo-assets/lamp-sage.jpg")], columns: 2 });
  const note = await call("write_board_text", { boardId: board.id, operationId: "fixture-note", text: "插件文字说明", anchorNodeId: batch.nodeIds[0], side: "below" });
  if (scenario === "active") {
    await call("fit_board_view", { boardId: board.id });
    await page.waitForFunction(() => document.querySelectorAll("[data-image-node]").length === 2, { timeout: 30000 });
    await page.getByText("插件文字说明", { exact: true }).waitFor({ state: "visible", timeout: 30000 });
  }
  const before = await call("get_board", { boardId: board.id });
  assert.equal(before.nodes.length, 3);
  if (scenario === "active") await page.getByRole("button", { name: "添加文本", exact: true }).waitFor({ state: "visible" });
  let moved = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await call("get_board", { boardId: board.id });
    const result = await client.callTool({ name: "move_board_nodes", arguments: { boardId: board.id, expectedRevision: latest.revision, positions: [{ nodeId: note.nodeIds[0], x: 80, y: 520 }] } });
    if (!result.isError) { moved = true; break; }
    assert(JSON.stringify(result).includes("REVISION_CONFLICT"), JSON.stringify(result));
  }
  assert(moved, "rereading must resolve a revision changed by pending UI save");
  if (scenario !== "active") {
    await call("rename_board", { boardId: board.id, name: "后台图文修改验收" });
    await call("get_board_library");
    await call("open_board", { boardId: board.id });
    assert.equal((await call("trash_board", { boardId: board.id })).ok, true);
    assert.equal((await call("restore_board", { boardId: board.id })).id, board.id);
  }
  if (process.env.TUDA_PLUGIN_TEST_FAST_QUIT !== "1") {
    await call("fit_board_view", { boardId: board.id });
    await page.screenshot({ path: path.join(output, "canvas.png") });
  }
  await client.close(); client = null;
  await stop();
  page = await start();
  const reopened = await call("get_board", { boardId: board.id });
  assert.equal(reopened.nodes.length, 3);
  assert.deepEqual(reopened.nodes.find(n => n.id === note.nodeIds[0])?.text, "插件文字说明");
  assert.equal(reopened.nodes.find(n => n.id === note.nodeIds[0])?.x, 80);
  const repeated = await call("import_board_images", { boardId: board.id, operationId: "fixture-import", files: [path.resolve("demo-assets/lamp-studio.jpg"), path.resolve("demo-assets/lamp-sage.jpg")], columns: 2 });
  assert.deepEqual(repeated.nodeIds, batch.nodeIds);
  assert.equal((await call("get_board", { boardId: board.id })).nodes.length, 3);
  await call("rename_board", { boardId: board.id, name: "插件重启恢复通过" });
  assert.equal((await call("trash_board", { boardId: board.id })).ok, true);
  assert((await call("list_trashed_boards")).some(b => b.id === board.id));
  assert.equal((await call("restore_board", { boardId: board.id })).id, board.id);
  const report = { ok: true, scenario, appPath, userData, boardId: board.id, imageNodes: 2, textNodes: 1, restartPersistence: true, importRetrySafe: true, recoverableBoardTrash: true, safeHostQuit: true, boardOnlyUi: true, screenshot: process.env.TUDA_PLUGIN_TEST_FAST_QUIT === "1" ? null : path.join(output, "canvas.png") };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report));
} finally { if (client) await client.close(); if (app) await stop(); }
