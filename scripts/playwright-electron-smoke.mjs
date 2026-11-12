import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "output", "playwright");
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, "tuda-smoke-"));
const userData = await mkdtemp(path.join(os.tmpdir(), "tuda-smoke-"));
await mkdir(output, { recursive: true });
await mkdir(path.join(userData, "workspace"), { recursive: true });
const fixture = await readFile(path.join(projectRoot, "demo-assets", "lamp-studio.jpg"));
const errors = [];
const provider = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/images/generations") { response.writeHead(404).end(); return; }
  request.resume();
  setTimeout(() => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: fixture.toString("base64") }] })), 800);
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const connection = provider.address();
const config = {
  id: "fixture-provider", name: "Offline fixture", type: "openai-compatible", apiMode: "images",
  baseUrl: `http://127.0.0.1:${connection.port}`, generationEndpoint: "/v1/images/generations",
  referenceEndpoint: "/v1/images/edits", model: "fixture", supportsReferenceImages: true
};
await writeFile(path.join(userData, "workspace", "settings.json"), JSON.stringify({
  providers: [config], activeProviderId: config.id, theme: "light", language: "zh-CN", memoryEnabled: false,
  boardAssistantEnabled: false, boardAssistantAwarenessEnabled: false, editSmartSuggestionsEnabled: false
}));
await writeFile(path.join(userData, "workspace", "onboarding.json"), JSON.stringify(Object.fromEntries(
  ["board", "library", "gallery", "edit", "demo-start"].map((id) => [`tuda.onboarding.${id}.v1`, { status: "completed", at: new Date().toISOString() }])
)));
let electronApp;
const expectedCompanyDefaults = process.env.TUDA_E2E_COMPANY_DEFAULTS_FILE
  ? JSON.parse(await readFile(process.env.TUDA_E2E_COMPANY_DEFAULTS_FILE, "utf8")) : undefined;
if (expectedCompanyDefaults && process.env.TUDA_E2E_STANDALONE !== "1") {
  await writeFile(path.join(userData, "company-workspaces.json"), JSON.stringify({ version: 1, origin: "", activeSpace: "personal", folders: {}, selections: {} }), { flag: "wx", mode: 0o600 });
}
async function bridge(method, args = {}) {
  const info = JSON.parse(await readFile(path.join(userData, "local-api.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${info.port}/call`, {
    method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" },
    body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30_000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Workspace operation failed");
  return body.result;
}
async function pageReady(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.waitForURL(/dist\/index\.html/u, { timeout: 60_000 });
  await page.waitForFunction(() => window.imageWorkbench && document.querySelector('[data-library-nav-indicator], input[placeholder="搜索画板"]'), undefined, { timeout: 60_000 });
}
try {
  const packaged = process.env.TUDA_E2E_PACKAGED === "1";
  const standalone = process.env.TUDA_E2E_STANDALONE === "1";
  const env = { ...process.env, TUDA_PLAYWRIGHT: "1", TUDA_E2E_USER_DATA: userData,
    ...(packaged && !standalone ? { TUDA_EMBEDDED_HOST: "release-verification", TUDA_USER_DATA_PATH: userData } : {}) };
  if (standalone) { delete env.TUDA_EMBEDDED_HOST; delete env.TUDA_USER_DATA_PATH; }
  delete env.VITE_DEV_SERVER_URL;
  electronApp = await electron.launch({ args: packaged ? [] : ["."], cwd: projectRoot, env,
    ...(process.env.TUDA_E2E_ELECTRON ? { executablePath: process.env.TUDA_E2E_ELECTRON } : {}), timeout: 60_000 });
  let page = await electronApp.firstWindow();
  await pageReady(page);
  const appPath = await electronApp.evaluate(({ app }) => app.getAppPath());
  const runtimeUrl = pathToFileURL(path.join(appPath, "dist-electron/electron/agents/coding-runtime.js")).href;
  const piProbe = spawnSync(process.env.TUDA_E2E_ELECTRON || createRequire(import.meta.url)("electron"), ["--input-type=module", "-e",
    `const runtime = await import(${JSON.stringify(runtimeUrl)}); if (typeof runtime.createAgentSession !== 'function' || typeof runtime.ModelRuntime.create !== 'function') process.exit(1);`
  ], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30_000 });
  assert.equal(piProbe.status, 0, `Pi SDK must import from the actual desktop runtime: ${piProbe.stderr || piProbe.error || ""}`);
  const piRuntimeReady = true;
  let companyDefaultsVerified = false;
  if (expectedCompanyDefaults) {
    const expectedAccount = new URL(expectedCompanyDefaults.accountOrigin).origin;
    const expectedNas = new URL(expectedCompanyDefaults.nasUrl).href.replace(/\/$/, "");
    const status = await page.evaluate(() => window.imageWorkbench.enterpriseStatus());
    assert.equal(status.serverUrl, expectedAccount, "The installed account service must use its deployment default");
    assert.equal(status.storageUrl, expectedNas, "The installed NAS service must use its deployment default");
    if (standalone || process.env.TUDA_E2E_DEFAULTS_UI === "1") {
      await page.locator("#library-sidebar button[data-space]").click();
      const dialog = page.locator("[data-enterprise-dialog]:visible");
      await dialog.locator("[data-company-advanced] summary").click();
      assert.equal(await dialog.locator("#enterprise-server-url").inputValue(), expectedAccount);
      assert.equal(await dialog.locator("#company-nas-url").inputValue(), expectedNas);
      if (!status.authenticated) assert.equal(await dialog.getByRole("button", { name: /使用钉钉登录企业空间|Sign in with DingTalk/ }).isEnabled(), true);
      await page.screenshot({ path: path.join(output, "company-defaults.png") });
      await page.keyboard.press("Escape");
    }
    companyDefaultsVerified = true;
  }
  if (standalone) {
    assert.equal(packaged, true, "Standalone startup verification requires an installed package");
    const metadata = await electronApp.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }));
    assert.equal(metadata.packaged, true);
    await page.screenshot({ path: path.join(output, "installed-startup.png") });
    console.log(JSON.stringify({ ok: true, ...metadata, standalone: true, libraryHome: true, piRuntimeReady, companyDefaultsVerified, screenshot: path.join(output, "installed-startup.png") }, null, 2));
  } else {
  await page.waitForFunction(async () => (await window.imageWorkbench.getSettings()).setupComplete);
  const settings = await page.evaluate(() => window.imageWorkbench.getSettings());
  await page.evaluate((settings) => window.imageWorkbench.saveSettings({ ...settings, apiKeyByProviderId: { "fixture-provider": "offline-test-only" } }), settings);
  const board = await page.evaluate(() => window.imageWorkbench.createBoard("Isolated smoke board"));
  const imported = await page.evaluate((data) => window.imageWorkbench.importUploadedImage(data), "data:image/jpeg;base64," + fixture.toString("base64"));
  const webpThumbnail = await page.evaluate(async (data) => {
    const image = new Image(); image.src = data; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    canvas.getContext("2d").drawImage(image, 0, 0);
    const asset = await window.imageWorkbench.importUploadedImage(canvas.toDataURL("image/webp"));
    const thumbnail = await window.imageWorkbench.getAssetThumbnail(asset.path, 192);
    const decoded = new Image(); decoded.src = thumbnail; await decoded.decode();
    return decoded.width > 0 && decoded.width <= 192;
  }, "data:image/jpeg;base64," + fixture.toString("base64"));
  assert.equal(webpThumbnail, true, "WebP must have a usable local PNG thumbnail");
  const nodeId = "smoke-image";
  await page.evaluate(({ boardId, nodeId, imagePath }) => window.imageWorkbench.appendBoardNodes(boardId, [{ id: nodeId, imagePath, jobId: "smoke-import", source: "upload" }]), { boardId: board.id, nodeId, imagePath: imported.path });
  await bridge("open_board", { boardId: board.id });
  const node = page.locator(`[data-id="${nodeId}"]`);
  await node.waitFor({ state: "visible", timeout: 30_000 });
  await bridge("duplicate_images", { boardId: board.id, nodeIds: [nodeId], offset: 340 });
  await page.waitForFunction(() => document.querySelectorAll("[data-image-node]").length === 2);
  await bridge("resize_image", { boardId: board.id, nodeId, displayWidth: 320 });
  await page.waitForFunction((id) => document.querySelector(`[data-id="${id}"]`)?.style.width === "320px", nodeId);
  const arrangedNodes = (await bridge("get_board", { boardId: board.id })).nodes;
  const arranged = await bridge("arrange_images", { boardId: board.id, nodeIds: arrangedNodes.map(n => n.id), mode: "vertical", gap: 48 });
  await page.waitForFunction((positions) => positions.every(p => document.querySelector(`[data-id="${p.nodeId}"]`)?.style.transform === `translate(${p.x}px, ${p.y}px)`), arranged.positions);
  await page.waitForTimeout(350);
  const afterExternal = await bridge("get_board", { boardId: board.id });
  for (const expected of arranged.positions) {
    const saved = afterExternal.nodes.find(n => n.id === expected.nodeId);
    assert.equal(saved.x, expected.x); assert.equal(saved.y, expected.y);
  }
  await page.getByRole("button", { name: "适配全部", exact: true }).click();
  await page.waitForTimeout(350);
  const before = await bridge("get_board", { boardId: board.id });
  const original = before.nodes.find((item) => item.id === nodeId);
  const bounds = await node.boundingBox();
  assert(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(({ id, transform }) => document.querySelector(`[data-id="${id}"]`)?.style.transform !== transform, { id: nodeId, transform: `translate(${original.x}px, ${original.y}px)` });
  const closed = page.waitForEvent("close");
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  const persisted = JSON.parse(await readFile(path.join(userData, "workspace", "boards", board.id + ".json"), "utf8"));
  const moved = persisted.nodes.find((item) => item.id === nodeId);
  assert(moved.x !== original.x || moved.y !== original.y, "The final drag must persist when closed immediately");
  const reopened = electronApp.waitForEvent("window");
  await electronApp.evaluate(({ app }) => { app.emit("activate"); });
  page = await reopened;
  await pageReady(page);
  assert((await bridge("list_boards")).some((item) => item.id === board.id), "Workspace service must survive reopening its initial window");
  await bridge("open_board", { boardId: board.id });
  await page.locator(`[data-id="${nodeId}"]`).waitFor({ state: "visible" });
  const task = await bridge("generate_image", { boardId: board.id, prompt: "Offline smoke fixture", n: 1 });
  assert.equal(task.status, "running");
  const secondClose = page.waitForEvent("close");
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await secondClose;
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await bridge("get_generation_status", { generationId: task.generationId });
    if (result.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.images.length, 1);
  const finalWindow = electronApp.waitForEvent("window");
  await electronApp.evaluate(({ app }) => { app.emit("activate"); });
  page = await finalWindow;
  await pageReady(page);
  await bridge("open_board", { boardId: board.id });
  await page.waitForFunction(() => document.querySelectorAll("[data-image-node]").length >= 3);
  await page.screenshot({ path: path.join(output, "electron-smoke.png") });
  const windowOptions = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(windowOptions.sandbox, true);
  assert.equal(windowOptions.contextIsolation, true);
  assert.equal(windowOptions.nodeIntegration, false);
  assert.equal(errors.filter((message) => /Content Security Policy|preload|uncaught|not defined/i.test(message)).length, 0, errors.join("\n"));
  console.log(JSON.stringify({ ok: true, packaged, piRuntimeReady, companyDefaultsVerified, isolatedWorkspace: true, immediateCloseSaved: true, mcpReopen: true, rendererIndependentGeneration: true, sandbox: true, boardNodes: 3, cliLayoutSynchronized: true, webpThumbnail: true, screenshot: path.join(output, "electron-smoke.png") }, null, 2));
  }
} catch (error) {
  await writeFile(path.join(output, "electron-smoke-errors.json"), JSON.stringify({ error: String(error), rendererErrors: errors }, null, 2));
  if (electronApp) for (const page of electronApp.windows()) await page.screenshot({ path: path.join(output, "electron-smoke-failure.png") }).catch(() => undefined);
  throw error;
} finally {
  await electronApp?.close().catch(() => undefined);
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await rm(userData, { recursive: true, force: true });
}
