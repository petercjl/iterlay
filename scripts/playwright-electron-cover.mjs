import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { prepareDevElectron } from "./prepare-dev-electron.mjs";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, "output/playwright"), { recursive: true });
const output = await mkdtemp(path.join(root, "output/playwright/tuda-cover-"));
const userData = await mkdtemp(path.join(root, "tmp/cover-desktop-test-"));
const workspace = path.join(userData, "workspace");
await mkdir(path.join(workspace, "boards"), { recursive: true });
await mkdir(path.join(workspace, "outputs"), { recursive: true });
const paths = ["lamp-studio.jpg", "aura-cover.jpg"].map(name => path.join(workspace, "outputs", name));
for (let i = 0; i < paths.length; i++) await writeFile(paths[i], await readFile(path.join(root, "demo-assets", path.basename(paths[i]))), { flag: "wx" });
const bad = path.join(workspace, "outputs", "unreadable.png");
await writeFile(bad, "unreadable fixture", { flag: "wx" });
const node = (id, imagePath, x = 0) => ({ id, type: "image", imagePath, jobId: id, source: "uploaded", x, y: 0, width: 800, height: 600, displayWidth: 240 });
const legacyId = "cover-legacy";
const legacy = { schemaVersion: 3, revision: 0, id: legacyId, name: "封面验收 · 历史画板", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nodes: [node("unreadable", bad), node("first", paths[0], 300), node("second", paths[1], 600)] };
await writeFile(path.join(workspace, "boards", `${legacyId}.json`), JSON.stringify(legacy), { flag: "wx" });
await writeFile(path.join(workspace, "settings.json"), JSON.stringify({ theme: "light", language: "zh-CN", memoryEnabled: false, boardAssistantEnabled: false }), { flag: "wx" });
await writeFile(path.join(workspace, "onboarding.json"), JSON.stringify(Object.fromEntries(["board", "library", "gallery", "edit", "demo-start"].map(id => [`tuda.onboarding.${id}.v1`, { status: "completed", at: new Date().toISOString() }]))), { flag: "wx" });
const executablePath = await prepareDevElectron();
let app, page;
const errors = [];
async function start() {
  const env = { ...process.env, TUDA_PLAYWRIGHT: "1", TUDA_E2E_USER_DATA: userData };
  delete env.VITE_DEV_SERVER_URL; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath, args: ["."], cwd: root, env, timeout: 60000 });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForURL(/dist\/index\.html/u, { timeout: 60000 });
  await page.waitForFunction(() => window.imageWorkbench && document.querySelector('input[placeholder="搜索画板"]'), undefined, { timeout: 60000 });
}
async function getBoard(id = legacyId) { return page.evaluate(id => window.imageWorkbench.getBoard(id), id); }
async function waitCover(nodeId, imagePath) {
  await page.waitForFunction(async ({ id, nodeId, imagePath }) => {
    const b = await window.imageWorkbench.getBoard(id);
    return b.coverNodeId === nodeId && b.thumbnailImagePath === imagePath && b.thumbnailDataUrl?.startsWith("data:image/jpeg;base64,");
  }, { id: legacyId, nodeId, imagePath }, { timeout: 30000 });
}
async function cardMenu() {
  await page.getByRole("button", { name: `画板 ${legacy.name} 操作`, exact: true }).click();
  await page.getByRole("menuitem", { name: "更换封面", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "选择图片 3", exact: true }).waitFor();
}
try {
  await start();
  // Historical boards are repaired on the library page; an unreadable first image falls through.
  await waitCover("", paths[0]);
  await page.screenshot({ path: path.join(output, "01-automatic-repair.png") });
  // A CLI/API append gets a cover before the board has ever been opened in the canvas.
  const cli = await page.evaluate(async imagePath => {
    const api = window.imageWorkbench;
    const b = await api.createBoard("封面验收 · CLI追加");
    await api.appendBoardNodes(b.id, [{ id: "cli-image", imagePath, jobId: "cli-image", source: "uploaded", width: 800, height: 600 }]);
    return api.getBoard(b.id);
  }, paths[1]);
  assert.equal(cli.thumbnailImagePath, paths[1]); assert.ok(cli.thumbnailDataUrl);
  // Library picker persists the chosen node.
  await cardMenu();
  await page.getByRole("button", { name: "选择图片 3", exact: true }).click();
  await page.screenshot({ path: path.join(output, "02-cover-picker.png") });
  await page.getByRole("button", { name: "设为画板封面", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await waitCover("second", paths[1]);
  // Enter canvas and set the other image using its right-click menu.
  await page.locator(`[data-board-library-id="${legacyId}"] [data-board-card]`).dblclick();
  await page.locator('[data-id="first"]').waitFor({ timeout: 30000 });
  await page.locator('[data-id="first"]').click({ button: "right", position: { x: 100, y: 70 } });
  await page.getByRole("menuitem", { name: "设为画板封面", exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "03-canvas-cover-menu.png") });
  await page.getByRole("menuitem", { name: "设为画板封面", exact: true }).click();
  await waitCover("first", paths[0]);
  // Real window/app restart reads the same persistent choice.
  await app.close(); app = undefined;
  await start(); await waitCover("first", paths[0]);
  // Explicitly restoring automatic mode returns to the first readable image.
  await cardMenu();
  await page.getByRole("button", { name: "恢复自动选择", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await waitCover("", paths[0]);
  // Select the second node again, then remove it via the same mutation used by the canvas.
  await cardMenu(); await page.getByRole("button", { name: "选择图片 3", exact: true }).click();
  await page.getByRole("button", { name: "设为画板封面", exact: true }).click();
  await waitCover("second", paths[1]);
  await page.evaluate(async id => {
    const api = window.imageWorkbench, b = await api.getBoard(id);
    await api.saveBoard({ id, expectedRevision: b.revision, nodes: b.nodes.filter(n => n.id !== "second") });
  }, legacyId);
  await waitCover("", paths[0]);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, "04-restart-and-fallback.png") });
  const report = { ok: true, platform: process.platform, executablePath, output, userData,
    verified: ["historical-cover-repair", "unreadable-first-image-fallback", "cli-append-cover", "library-picker", "canvas-context-menu", "restart-persistence", "restore-automatic", "deleted-cover-fallback"], errors };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {}); console.error(await page.locator("body").innerText().catch(() => "")); }
  console.error("Evidence:", output); throw error;
} finally { if (app) await app.close(); }
