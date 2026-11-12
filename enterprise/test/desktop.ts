import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import type { EnterpriseSession } from "../../shared/enterprise.js";
import type { ImageWorkbenchApi } from "../../shared/workbench-client.js";
import type { BoardData } from "../../shared/types.js";

declare global { interface Window { imageWorkbench: ImageWorkbenchApi } }

/** Uses only isolated test profiles and the integration test's fixture identities. */
export async function testDesktop(input: {
  base: string; sessions: EnterpriseSession[]; boardId: string;
  board: () => Promise<BoardData>; restart: (offline?: () => Promise<void>) => Promise<void>;
}) {
  const profiles = await Promise.all([0, 1].map(() => mkdtemp(path.join(os.tmpdir(), "tuda-enterprise-desktop-"))));
  await mkdir("output/playwright", { recursive: true });
  const output = await mkdtemp(path.resolve("output/playwright/tuda-enterprise-"));
  const apps: ElectronApplication[] = [];
  const launch = (profile: string) => {
    const env = { ...process.env, TUDA_PLAYWRIGHT: "1", TUDA_E2E_USER_DATA: profile };
    delete env.VITE_DEV_SERVER_URL;
    return _electron.launch({ args: ["."], cwd: process.cwd(), env, timeout: 60_000,
      ...(process.env.TUDA_E2E_ELECTRON ? { executablePath: process.env.TUDA_E2E_ELECTRON } : {}) });
  };
  async function bridge(index: number, method: string, args: Record<string, unknown>) {
    const info = JSON.parse(await readFile(path.join(profiles[index], "local-api.json"), "utf8"));
    const response = await fetch(`http://127.0.0.1:${info.port}/call`, { method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" }, body: JSON.stringify({ method, args }) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result.result;
  }
  async function waitBoard(check: (board: BoardData) => boolean) {
    for (let i = 0; i < 150; i++) { if (check(await input.board())) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error("Desktop changes did not reach durable board state");
  }
  async function drag(page: Page, nodeId: string, dx: number, dy: number) {
    const box = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox(); assert(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 }); await page.mouse.up();
  }
  try {
    console.log("desktop: prepare encrypted fixture sessions");
    const encryptionProfile = await mkdtemp(path.join(os.tmpdir(), "tuda-test-encryption-"));
    const encryptor = await launch(encryptionProfile);
    try {
      const initialWindow = await encryptor.firstWindow();
      await initialWindow.waitForURL(/dist\/index\.html/, { timeout: 60_000 });
      await initialWindow.waitForFunction(() => Boolean(window.imageWorkbench), { timeout: 60_000 });
      for (let index = 0; index < profiles.length; index++) {
        const encrypted = await encryptor.evaluate(({ safeStorage }, value) => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption unavailable");
          return safeStorage.encryptString(JSON.stringify(value)).toString("base64");
        }, { serverUrl: input.base, value: input.sessions[index] });
        await mkdir(path.join(profiles[index], "workspace"), { recursive: true });
        await writeFile(path.join(profiles[index], "enterprise.json"), JSON.stringify({ version: 1, serverUrl: input.base, activeSpace: "enterprise", encryptedSession: encrypted }), { flag: "wx", mode: 0o600 });
        await writeFile(path.join(profiles[index], "workspace/settings.json"), JSON.stringify({ language: "zh-CN", theme: "light", memoryEnabled: false, boardAssistantEnabled: false }), { flag: "wx" });
      }
    } finally { encryptor.process().kill("SIGKILL"); await encryptor.close().catch(() => undefined); await rm(encryptionProfile, { recursive: true, force: true }); }
    console.log("desktop: launch two clients");
    for (const profile of profiles) apps.push(await launch(profile));
    const pages = await Promise.all(apps.map(app => app.firstWindow()));
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      await page.waitForURL(/dist\/index\.html/, { timeout: 60_000 });
      await page.waitForFunction(() => window.imageWorkbench && document.documentElement.dataset.boardSaveState, { timeout: 60_000 });
      await bridge(index, "open_board", { boardId: input.boardId });
      await page.locator('[data-id="desktop-a"]').waitFor({ state: "visible", timeout: 30_000 });
      await page.getByRole("button", { name: "适配全部", exact: true }).click();
    }
    await pages[0].waitForTimeout(600);
    const initial = await input.board();
    const a = initial.nodes.find(node => node.id === "desktop-a")!, b = initial.nodes.find(node => node.id === "desktop-b")!;
    console.log("desktop: concurrent drag");
    await Promise.all([drag(pages[0], a.id, 70, 45), drag(pages[1], b.id, -60, 80)]);
    await waitBoard(board => board.nodes.find(node => node.id === a.id)!.x !== a.x && board.nodes.find(node => node.id === b.id)!.y !== b.y);
    const merged = await input.board();
    console.log("desktop: wait for peer convergence", merged.nodes.map(n => ({id:n.id,x:n.x,y:n.y})));
    for (const page of pages) await page.waitForFunction(nodes => nodes.every(node => {
      const transform = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${node.id}"]`)?.style.transform;
      const values = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform ?? "");
      return values && Math.abs(Number(values[1]) - node.x) < .01 && Math.abs(Number(values[2]) - node.y) < .01;
    }), merged.nodes);
    console.log("desktop: selective undo");
    await pages[0].getByRole("button", { name: "撤销", exact: true }).click();
    await waitBoard(board => board.nodes.find(node => node.id === a.id)!.x === a.x);
    assert.equal((await input.board()).nodes.find(node => node.id === b.id)!.y, merged.nodes.find(node => node.id === b.id)!.y, "Undo must preserve the peer's edit");
    await pages[0].mouse.move(600, 350);
    await pages[1].locator("[data-peer-cursor]").first().waitFor({ state: "visible" });
    let offlinePose: {x:number;y:number} | undefined;
    console.log("desktop: restart service");
    await input.restart(async () => {
      await drag(pages[0], a.id, 40, 30);
      await pages[0].waitForFunction(async () => (await window.imageWorkbench.enterpriseStatus()).pendingWrites > 0);
      await pages[0].waitForFunction(() => document.documentElement.dataset.boardSaveState === "failed");
      await drag(pages[0], a.id, 55, 35);
      await pages[0].waitForFunction(async () => (await window.imageWorkbench.enterpriseStatus()).pendingWrites > 1);
      offlinePose = await pages[0].evaluate(id => {
        const transform = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!.style.transform;
        const values = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform)!;
        return { x: Number(values[1]), y: Number(values[2]) };
      }, a.id);
    });
    for (const page of pages) await page.waitForFunction(async () => (await window.imageWorkbench.enterpriseStatus()).connected, { timeout: 30_000 });
    await waitBoard(board => { const node = board.nodes.find(node => node.id === a.id)!; return Boolean(offlinePose && Math.abs(node.x - offlinePose.x) < .01 && Math.abs(node.y - offlinePose.y) < .01); });
    await pages[0].screenshot({ path: path.join(output, "editor-a.png") });
    await pages[1].screenshot({ path: path.join(output, "editor-b.png") });
    console.log(JSON.stringify({ desktop: true, twoEditors: true, dragMerge: true, selectiveUndo: true, liveCursor: true, reconnect: true, offlineOutboxReplay: true, latestSequentialOfflineEdit: true, screenshots: output }));
  } catch (error) {
    console.error("desktop durable state", (await input.board()).nodes.map(n => ({id:n.id,x:n.x,y:n.y})));
    for (let index = 0; index < apps.length; index++) {
      const page = await apps[index].firstWindow();
      console.error("desktop window", index, await page.evaluate(() => ({nodes:[...document.querySelectorAll<HTMLElement>(".react-flow__node")].map(n=>({id:n.dataset.id,transform:n.style.transform})),save:document.documentElement.dataset.boardSaveState})).catch(()=>null));
      await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => undefined);
    }
    throw error;
  } finally { for (const app of apps) { const timer = setTimeout(() => app.process().kill("SIGKILL"), 10_000); try { await app.close(); } catch { /* Isolated fixture cleanup. */ } finally { clearTimeout(timer); } } for (const profile of profiles) await rm(profile, { recursive: true, force: true }); }
}
